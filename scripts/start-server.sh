#!/usr/bin/env bash
# Startet den Agent-Colony-Server im Hintergrund, auf dem Port aus der Config
# (Vorgabe 4173), und wartet, bis er antwortet.
#
#   ./scripts/start-server.sh
#
# Der Server laeuft danach unabhaengig von Terminal und Claude-Session weiter.
# Laeuft auf dem Port schon ein Agent-Colony-Server, wird er ersetzt; ein
# zweiter Aufruf ist also ein Neustart (noetig nach Aenderungen unter src/ oder
# public/). Ein fremder Prozess auf dem Port bleibt unangetastet, das Skript
# bricht dann ab.
# Beenden: ./scripts/stop-server.sh (oder `kill <PID>`, die PID steht in der
# Startzeile).
# Im Vordergrund statt im Hintergrund: `npm start`.
#
# Warum ein Skript statt `npm start &`:
#  - Node liegt nur in interaktiven Shells auf dem PATH (nvm via .zshrc)
#  - ein einfaches `&` stirbt mit einer `wsl -- bash -s`-Sitzung, daher setsid
#
# Bis 2026-09-16 hiess das Skript scripts/dev.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

# Die Node-Version aus .nvmrc, wenn nvm sie installiert hat; sonst das Node,
# das ohnehin auf dem PATH liegt.
NODE_BIN="$HOME/.nvm/versions/node/$(cat .nvmrc)/bin"
[ -d "$NODE_BIN" ] && export PATH="$NODE_BIN:$PATH"
command -v node > /dev/null || { echo "Node nicht gefunden. nvm install $(cat .nvmrc)"; exit 1; }

# Ohne node_modules startet der Server zwar, aber die Importmap laeuft ins
# Leere und das HUD bleibt leer — ein Fehler, den man nur in der Browserkonsole
# saehe. Lieber hier abbrechen.
[ -d node_modules ] || { echo "node_modules fehlt. Erst: npm install"; exit 1; }

# COLONY_PORT ueberstimmt die Config wie im Server selbst; ohne diese Zeile
# wartete das Skript auf dem Config-Port, waehrend der Server woanders laeuft.
PORT="${COLONY_PORT:-$(node -e 'import("./src/collect.mjs").then(m=>m.loadConfig()).then(c=>console.log(c.port))')}"

# Nur den Prozess beenden, der auf UNSEREM Port lauscht — nicht jeden Server
# dieses Projekts per Kommandozeilenmuster. `pkill -f "node src/server.mjs"`
# traf vorher alle Worktrees, Ports und Sessions auf einmal: am 2026-09-11
# hat ein dev.sh-Lauf in einem Worktree zweimal den Server einer anderen
# Session auf einem anderen Port abgeschossen. Wer auf einem fremden Port
# laeuft, geht dieses Skript nichts an.
OLD_PID="$(ss -ltnpH "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2 || true)"
if [ -n "$OLD_PID" ]; then
  # Und auch dort nur einen Agent-Colony-Server. 4173 ist zugleich der
  # Standardport von `vite preview`; wer das Skript auf einer fremden
  # Maschine startet, soll nicht dessen Prozess verlieren. Gleiche Pruefung
  # wie in stop-server.sh.
  CMDLINE="$(tr '\0' ' ' < "/proc/$OLD_PID/cmdline" 2>/dev/null || true)"
  case "$CMDLINE" in
    *src/server.mjs*) ;;
    *)
      echo "Port $PORT ist belegt von PID $OLD_PID, und das ist kein Agent-Colony-Server:"
      echo "  ${CMDLINE:-<Kommandozeile nicht lesbar>}"
      echo "Nichts beendet. Anderer Port: COLONY_PORT=4180 $0  (dauerhaft: \"port\" in config/colony.local.json)"
      exit 1
      ;;
  esac
  kill "$OLD_PID" 2>/dev/null || true
  sleep 0.5
fi

# Absoluter Pfad in der Kommandozeile: aeltere Kopien dieses Skripts in anderen
# Worktrees toeten noch per Muster "node src/server.mjs" — so ein Start
# enthaelt dieses Muster nicht und ueberlebt sie.
LOG="${TMPDIR:-/tmp}/agent-colony.log"
setsid nohup node "$PWD/src/server.mjs" > "$LOG" 2>&1 < /dev/null &
disown

for _ in $(seq 20); do
  if curl -sf -o /dev/null "http://localhost:$PORT/api/state"; then
    # PID ueber den Port, nicht ueber $!: setsid forkt, wenn es selbst
    # Gruppenfuehrer ist, und dann gehoerte $! einem schon beendeten Prozess.
    PID="$(ss -ltnpH "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2 || true)"
    echo "Agent Colony -> http://localhost:$PORT   (PID ${PID:-?}, Log: $LOG)"
    echo "Beenden: ./scripts/stop-server.sh  (oder kill ${PID:-<PID>})"
    # Der Server laeuft im Hintergrund, seine Warnungen stuenden sonst nur im Log.
    grep "^Warnung:" "$LOG" || true
    exit 0
  fi
  sleep 0.3
done

echo "Server antwortet nicht. Log:"
cat "$LOG"
exit 1
