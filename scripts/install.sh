#!/usr/bin/env bash
# Richtet Agent Colony auf einer frischen Linux/WSL-Maschine ein:
#
#   git clone https://github.com/aploe/agent-colony
#   cd agent-colony
#   ./scripts/install.sh
#
# Prueft Voraussetzungen, installiert Abhaengigkeiten, legt eine lokale
# Config an, traegt optional den Status-Hook ein und startet den Server.
# Wiederholte Laeufe sind idempotent: eine vorhandene
# config/colony.local.json wird nicht angefasst, ein schon eingetragener
# Hook bleibt unveraendert (siehe scripts/install-hooks.mjs).
#
# Gegenstueck: ./scripts/install.sh --uninstall
set -euo pipefail

usage() {
  cat <<'EOF'
Verwendung: scripts/install.sh [Optionen]

Optionen:
  --hooks       Status-Hook ohne Rueckfrage eintragen (8 Ereignisse in
                ~/.claude/settings.json, feuern in jeder Claude-Code-Session
                auf dieser Maschine -- siehe hooks/session-status.sh)
  --no-hooks    Status-Hook ohne Rueckfrage NICHT eintragen
  --no-start    Den Server am Ende nicht starten
  --uninstall   Status-Hook entfernen, laufenden Server beenden, sonst
                nichts anfassen (node_modules und config/colony.local.json
                bleiben erhalten)
  -h, --help    Diese Hilfe anzeigen

Ohne --hooks/--no-hooks fragt das Skript auf einem Terminal nach; ohne
Terminal (z.B. in einem Skript) wird der Hook uebersprungen.
EOF
}

# 1. Flags
HOOKS_MODE="ask"
NO_START=0
UNINSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --hooks) HOOKS_MODE="yes" ;;
    --no-hooks) HOOKS_MODE="no" ;;
    --no-start) NO_START=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Unbekannte Option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

cd "$(dirname "$0")/.."

# 2. Voraussetzungen -- alle fehlenden sammeln statt beim ersten Fehler
# abzubrechen, damit eine frische Maschine nicht mehrfach neu anlaufen muss.
echo "Pruefe Voraussetzungen ..."
MISSES=()

if [ "$(uname -s 2>/dev/null || echo unbekannt)" != "Linux" ] || [ ! -r /proc/self/stat ]; then
  MISSES+=("Nur Linux (WSL zaehlt) mit lesbarem /proc wird unterstuetzt (gefunden: $(uname -s 2>/dev/null || echo unbekannt)). start-server.sh und stop-server.sh lesen PIDs darueber.")
fi

# Node liegt in der Claude-Code-Bash nicht immer auf dem PATH; wie in
# start-server.sh die nvm-Version aus .nvmrc dazuholen, wenn vorhanden.
NVMRC="$(cat .nvmrc 2>/dev/null || echo v20)"
NODE_BIN="$HOME/.nvm/versions/node/$NVMRC/bin"
[ -d "$NODE_BIN" ] && export PATH="$NODE_BIN:$PATH"

if command -v node > /dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$NODE_MAJOR" -lt 20 ] 2>/dev/null; then
    MISSES+=("Node ist zu alt ($(node -p process.version 2>/dev/null || echo '?'), noetig: >=20). nvm install $NVMRC")
  fi
else
  MISSES+=("Node nicht gefunden. nvm install $NVMRC, oder https://nodejs.org")
fi

command -v npm  > /dev/null 2>&1 || MISSES+=("npm nicht gefunden (kommt normalerweise mit Node/nvm).")
command -v git  > /dev/null 2>&1 || MISSES+=("git nicht gefunden. apt install git (oder Distro-Aequivalent).")
command -v ss   > /dev/null 2>&1 || MISSES+=("ss nicht gefunden (Paket iproute2). apt install iproute2.")
command -v curl > /dev/null 2>&1 || MISSES+=("curl nicht gefunden. apt install curl.")

if [ "${#MISSES[@]}" -gt 0 ]; then
  echo "Voraussetzungen fehlen:"
  for m in "${MISSES[@]}"; do
    echo "  - $m"
  done
  exit 1
fi
echo "Voraussetzungen erfuellt."

# 3. --uninstall: Hook raus, Server stoppen, sonst nichts anfassen.
if [ "$UNINSTALL" -eq 1 ]; then
  echo
  echo "Deinstalliere Agent Colony ..."
  FAIL=0
  if ! node scripts/install-hooks.mjs --uninstall; then
    echo "Hook-Entfernung fehlgeschlagen (siehe oben)." >&2
    FAIL=1
  fi
  if ! ./scripts/stop-server.sh; then
    echo "Server-Stop fehlgeschlagen (siehe oben)." >&2
    FAIL=1
  fi
  echo
  echo "node_modules und config/colony.local.json bleiben unangetastet."
  exit "$FAIL"
fi

# 4. Abhaengigkeiten. Ein Worktree hat node_modules nur als Symlink auf das
# Hauptcheckout (CLAUDE.md, "Umgebung") -- installiert wird dort, nicht hier.
echo
echo "Installiere Abhaengigkeiten ..."
if [ -L node_modules ]; then
  echo "node_modules ist ein Symlink (Worktree) -- npm ci uebersprungen."
else
  npm ci --no-audit --no-fund
fi

# 5. Lokale Config. Nur anlegen, wenn sie fehlt -- ein zweiter Lauf darf
# persoenliche Anpassungen nie ueberschreiben.
echo
CONFIG_FILE="config/colony.local.json"
if [ -f "$CONFIG_FILE" ]; then
  echo "$CONFIG_FILE existiert schon -- unveraendert gelassen."
else
  node -e "
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const home = os.homedir();
    const cfg = {
      claudeProjectsDir: path.join(home, '.claude', 'projects'),
      ignorePaths: [home],
    };
    if (process.env.WSL_DISTRO_NAME) cfg.wslDistro = process.env.WSL_DISTRO_NAME;
    fs.writeFileSync('$CONFIG_FILE', JSON.stringify(cfg, null, 2) + '\n');
  "
  echo "$CONFIG_FILE angelegt."
fi

# 6. Der Ordner darf fehlen (Claude Code legt ihn erst bei der ersten
# Session an) -- das ist eine Warnung, kein Abbruch. Mit Serverstart meldet
# sie start-server.sh aus dem Serverlog, hier also nur ohne Start.
MERGED_DIR="$(node -e "import('./src/collect.mjs').then(m => m.loadConfig()).then(c => console.log(c.claudeProjectsDir))")"
if [ "$NO_START" -eq 1 ] && [ ! -d "$MERGED_DIR" ]; then
  echo "Warnung: $MERGED_DIR existiert nicht. Die Karte bleibt leer, bis Claude Code dort eine Session angelegt hat."
fi

# 7. Status-Hook. Faengt nichts ab, das den Lauf insgesamt stoppen muesste --
# ein Fehler hier wird gemeldet, der Server startet trotzdem, nur der
# Exitcode am Ende bleibt 1.
echo
DO_HOOKS=0
HOOK_FAILED=0
case "$HOOKS_MODE" in
  yes) DO_HOOKS=1 ;;
  no) echo "Hook wird nicht eingetragen (--no-hooks)." ;;
  ask)
    if [ -t 0 ]; then
      echo "Der Status-Hook traegt 8 Ereignisse (SessionStart, UserPromptSubmit, Notification,"
      echo "PermissionRequest, Stop, SubagentStart, SubagentStop, SessionEnd) in ~/.claude/settings.json"
      echo "ein und feuert danach in JEDER Claude-Code-Session auf dieser Maschine."
      read -r -p "Jetzt eintragen? [j/N] " ans || ans=""
      case "${ans,,}" in
        j|ja|y|yes) DO_HOOKS=1 ;;
        *) echo "Nicht eingetragen." ;;
      esac
    else
      echo "Kein Terminal fuer eine Rueckfrage -- Hook nicht eingetragen. Spaeter: ./scripts/install.sh --hooks"
    fi
    ;;
esac

if [ "$DO_HOOKS" -eq 1 ]; then
  if ! node scripts/install-hooks.mjs; then
    echo "Hook-Installation fehlgeschlagen (siehe oben)." >&2
    HOOK_FAILED=1
  fi
fi

# 8. Server starten. Anders als ein Hook-Fehler ist das hier fatal -- ohne
# laufenden Server ist "frische Maschine, laufende Karte" nicht erreicht.
echo
if [ "$NO_START" -eq 1 ]; then
  echo "Server wird nicht gestartet (--no-start)."
else
  if ! ./scripts/start-server.sh; then
    echo "Serverstart fehlgeschlagen (siehe oben)." >&2
    exit 1
  fi
fi

# 9. Kurze Zusammenfassung.
PORT="${COLONY_PORT:-$(node -e "import('./src/collect.mjs').then(m => m.loadConfig()).then(c => console.log(c.port))")}"
echo
echo "== Zusammenfassung =="
if [ "$NO_START" -eq 1 ]; then
  echo "URL (nach Start): http://localhost:$PORT"
else
  echo "URL: http://localhost:$PORT"
fi
echo "Config: $CONFIG_FILE"
if [ "$DO_HOOKS" -eq 1 ] && [ "$HOOK_FAILED" -eq 0 ]; then
  echo "Hook: eingetragen (wirkt ab der naechsten Claude-Code-Session)"
elif [ "$DO_HOOKS" -eq 1 ]; then
  echo "Hook: fehlgeschlagen (siehe oben)"
else
  echo "Hook: nicht eingetragen"
fi
echo "Deinstallieren: ./scripts/install.sh --uninstall"

exit "$HOOK_FAILED"
