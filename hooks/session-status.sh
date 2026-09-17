#!/usr/bin/env bash
# Schreibt den Zustand einer Claude-Code-Session dorthin, wo agent-colony ihn
# lesen kann. Aufruf: bash session-status.sh <EventName>, Payload auf stdin.
#
# Warum bash und nicht Node: nachgemessen (2026-09-12, Methode und volle
# Zahlen in docs/HISTORIE.md) rund 12 ms fuer einen echten Hook-Aufruf gegen
# rund 13 ms allein fuer einen leeren Node-Prozessstart, noch ohne die
# eigentliche Arbeit (JSON lesen, Datei schreiben) -- ein Node-Hook waere
# damit nicht guenstiger, nur dieselbe Arbeit in einer anderen Sprache. Der
# fruehere Wert (1,5 ms) stammte aus dem Prototyp der Spec, nicht aus dem
# fertigen Skript mit seinen ~15 Subprozessen je Ereignis. Der Hook laeuft in
# jeder Session dieser Maschine, der Leser nur hier.
#
# Warum der Ereignisname als Argument und nicht aus dem Payload: ein Feld
# weniger, von dem der Hook abhaengt. Die Registrierung kennt das Ereignis
# ohnehin, sie traegt ja pro Ereignis einen eigenen Eintrag ein.
#
# Was hier NICHT steht: pid und procStart. Ob eine Session lebt, entscheidet
# der Leser ueber ~/.claude/sessions und /proc — der Hook wuerde das nur
# schlechter koennen ($PPID ist der Wrapper, nicht der Claude-Prozess).
#
# Der Hook endet unter allen Umstaenden mit 0. Ein Fehler hier darf niemals
# einen Turn oder einen Tool-Aufruf blockieren.
set -u

event="${1:-}"
dir="${XDG_RUNTIME_DIR:-/tmp}/agent-colony"

# stdin immer leeren, auch wenn das Payload nicht gebraucht wird — sonst
# bekommt der Schreiber ein SIGPIPE.
payload="$(cat 2>/dev/null || true)"

# Kein jq voraussetzen: die Session-ID ist ein UUID ohne Sonderzeichen.
sid="$(printf '%s' "$payload" | grep -o '"session_id":"[^"]*"' | head -1 | cut -d'"' -f4)"
[ -n "$sid" ] || exit 0

# Pfadsicherheit (R-Fix Runde 1, Minor 3): sid landet in Dateipfaden und in
# `rm -f`/`rm -rf`. Nur UUID-taugliche Zeichen zulassen, alles andere bricht
# ab, ohne etwas zu schreiben oder zu loeschen.
case "$sid" in
  *[!A-Za-z0-9_-]*) exit 0 ;;
esac

file="$dir/$sid.json"
subdir="$dir/$sid.subagents"

if [ "$event" = "SessionEnd" ]; then
  rm -f "$file"
  rm -rf "$subdir"
  exit 0
fi

# R16: SubagentStart/SubagentStop pflegen nur Markerdateien je agent_id,
# statt einen Zaehler in der Statusdatei mitzuzaehlen. Ein Read-Modify-Write
# auf einer gemeinsamen Datei verliert bei parallelen Subagenten Updates
# (gemessen: 20 parallele SubagentStart ergaben "subagents: 6") -- und
# parallele Subagenten sind in diesem Repo der Normalfall. Eine Sperre
# (flock) waere die schlechtere Antwort fuer einen Hook, der niemals haengen
# darf. Ein `mkdir`/`rm -f` je Datei ist dagegen von Natur aus atomar, und
# die beiden Ereignisse fassen die Statusdatei -- und damit `since` --
# ueberhaupt nicht mehr an, koennen also keinen gleichzeitigen Statuswechsel
# ueberschreiben. Die tatsaechliche Anzahl zaehlt kuenftig der Leser ueber
# die Eintraege in `$subdir` (spaeterer Task).
if [ "$event" = "SubagentStart" ] || [ "$event" = "SubagentStop" ]; then
  agent_id="$(printf '%s' "$payload" | grep -o '"agent_id":"[^"]*"' | head -1 | cut -d'"' -f4)"
  [ -n "$agent_id" ] || exit 0
  case "$agent_id" in
    *[!A-Za-z0-9_-]*) exit 0 ;;
  esac
  if [ "$event" = "SubagentStart" ]; then
    mkdir -p "$subdir" 2>/dev/null || exit 0
    : > "$subdir/$agent_id" 2>/dev/null
  else
    # Fehlt die Markerdatei, ist das kein Fehler -- der Hook kann mitten in
    # einer Session scharf geschaltet worden sein. `rm -f` ist dafuer da.
    rm -f "$subdir/$agent_id" 2>/dev/null
  fi
  exit 0
fi

mkdir -p "$dir" 2>/dev/null || exit 0

# Nur fuer SessionStart relevant (R11): unterscheidet einen echten Start von
# einer Kompaktierung mitten in der Session.
source_field="$(printf '%s' "$payload" | grep -o '"source":"[^"]*"' | head -1 | cut -d'"' -f4)"
# Nur fuer Notification relevant (R24): unterscheidet eine Permission-Abfrage
# ("Erlaubnis erteilt" braucht Aufmerksamkeit) von einer anderen Notification
# (z.B. "wartet auf neue Eingabe") -- beide feuerten sonst ununterscheidbar
# denselben Hook-Zustand.
notification_type="$(printf '%s' "$payload" | grep -o '"notification_type":"[^"]*"' | head -1 | cut -d'"' -f4)"

prev_status=""
prev_since=""
file_existed=0
if [ -f "$file" ]; then
  file_existed=1
  prev_status="$(grep -o '"status":"[^"]*"' "$file" | cut -d'"' -f4)"
  prev_since="$(grep -o '"since":"[^"]*"' "$file" | cut -d'"' -f4)"
fi

status="$prev_status"
case "$event" in
  SessionStart)
    # R11: SessionStart feuert auch mitten in einer laufenden Session, wenn
    # sie kompaktiert (source=compact). Eine arbeitende Session darf dabei
    # nicht auf idle zurueckfallen -- nur ein echter Sessionstart (jedes
    # andere source, z.B. startup) setzt idle. Gibt es noch keine Datei,
    # ist nichts zu bewahren und es gilt wie bei jedem anderen source: idle.
    if [ "$source_field" = "compact" ] && [ "$file_existed" -eq 1 ]; then
      status="$prev_status"
    else
      status="idle"
    fi
    ;;
  UserPromptSubmit)  status="working" ;;
  # R24: eine Permission-Abfrage ist eindeutig -- die Karte hat dafuer einen
  # eigenen Zustand (`prompt`, orange), nicht das allgemeine `waiting` (gelb).
  # `Notification` feuert fuer dieselbe Abfrage zusaetzlich mit
  # notification_type=permission_prompt (gemessen, siehe Spec); jede andere
  # Notification (z.B. "wartet auf neue Eingabe") bleibt `waiting`.
  PermissionRequest) status="prompt" ;;
  Notification)
    if [ "$notification_type" = "permission_prompt" ]; then
      status="prompt"
    else
      # Seit der Stop-Korrektur unten redundant zu Stop (beides "waiting"),
      # aber harmlos: eine Notification ohne Permission-Bezug bedeutet
      # ebenfalls "wartet auf Reaktion", unabhaengig davon, ob Stop schon
      # gefeuert hat.
      status="waiting"
    fi
    ;;
  # Korrigiert am 2026-09-13: `Stop` heisst "Turn fertig", nicht "nichts los".
  # Die Karte kennt dafuer schon einen Zustand -- `waiting` (gelb), das
  # bisherige Gelb der Transkript-Heuristik nach der letzten Antwort. Auf
  # `idle` abgebildet gab es fuer gemeldete Sessions ueberhaupt kein Gelb
  # mehr: Turn fertig wurde sofort grau, egal wie lange seitdem niemand
  # reagiert hat (live belegt an Session a71eff33, siehe docs/HISTORIE.md).
  # Die Karte kann ehrlich nur "seit dem Turn-Ende keine Reaktion" wissen,
  # nicht "noch nicht angesehen" -- das weiss nur der Editor. Die Reaktion
  # ist der naechste `UserPromptSubmit`, der auf `working` zurueckschaltet.
  # `idle` bleibt fuer den Fall, der wirklich "noch nichts passiert" heisst:
  # ein frischer `SessionStart`.
  Stop)              status="waiting" ;;
esac
[ -n "$status" ] || status="idle"

# `since` nur bei echtem Wechsel neu setzen, sonst stimmt "wartet seit 12 min"
# nach dem naechsten gleichartigen Ereignis nicht mehr.
#
# Millisekundenaufloesung (%3N), nicht nur Sekunden: zwei Statuswechsel kurz
# hintereinander (z.B. im Test, aber auch in einer echten Session) landen
# sonst in derselben Sekunde und "since" bleibt trotz echtem Wechsel gleich.
# Gemessen: mit Sekundenaufloesung schlug genau dieser Fall in 4 von 5
# Testlaeufen fehl. Format passt zu `toISOString()`, das der Rest des Repos
# fuer Zeitstempel verwendet (z.B. `generatedAt` in collect.mjs).
if [ "$status" = "$prev_status" ] && [ -n "$prev_since" ]; then
  since="$prev_since"
else
  since="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
fi

# Atomar: erst daneben schreiben, dann umhaengen. Ein halb geschriebener
# Datensatz wuerde den Leser sonst bei jedem Poll zum Parse-Fehler zwingen.
#
# M2: `cwd` und `event` haben keinen Konsumenten -- `hookStatus.mjs` liest
# nur sessionId/status/since -- und `cwd` stand unescaped im JSON: ein
# Anfuehrungszeichen im Pfad haette die Datei kaputt gemacht (die Session
# waere still auf die Heuristik gefallen). Beide Felder deshalb gestrichen,
# statt sie zu escapen -- ein Feld ohne Leser ist genau die Art Zustand, die
# die Ausnahme in CLAUDE.md nicht erlaubt (Schreiber und Leser duerfen nicht
# auseinanderlaufen koennen). `since` bleibt: der Leser pflegt es korrekt,
# auch wenn es noch keinen Konsumenten hat (siehe Spec).
tmp="$dir/.$sid.$$.tmp"
printf '{"sessionId":"%s","status":"%s","since":"%s"}\n' \
  "$sid" "$status" "$since" > "$tmp" 2>/dev/null \
  && mv -f "$tmp" "$file" 2>/dev/null
rm -f "$tmp" 2>/dev/null

exit 0
