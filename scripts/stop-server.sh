#!/usr/bin/env bash
# Beendet den Agent-Colony-Server, der auf dem Port aus der Config lauscht
# (Vorgabe 4173). Gegenstueck zu scripts/start-server.sh.
#
#   ./scripts/stop-server.sh
#   COLONY_PORT=4180 ./scripts/stop-server.sh   # anderer Port
#
# Gefunden wird der Server ueber den Port, nie ueber ein Kommandozeilenmuster:
# `pkill -f "node src/server.mjs"` trifft die Server anderer Worktrees und
# Sessions mit (docs/FALLEN.md, "Werkzeuge"). Lauscht auf dem Port etwas, das
# kein Agent-Colony-Server ist, faesst das Skript es nicht an.
set -euo pipefail
cd "$(dirname "$0")/.."

NODE_BIN="$HOME/.nvm/versions/node/$(cat .nvmrc)/bin"
[ -d "$NODE_BIN" ] && export PATH="$NODE_BIN:$PATH"
command -v node > /dev/null || { echo "Node nicht gefunden. nvm install $(cat .nvmrc)"; exit 1; }

PORT="${COLONY_PORT:-$(node -e 'import("./src/collect.mjs").then(m=>m.loadConfig()).then(c=>console.log(c.port))')}"

pid_on_port() {
  ss -ltnpH "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2 || true
}

PID="$(pid_on_port)"
if [ -z "$PID" ]; then
  echo "Auf Port $PORT laeuft kein Server."
  exit 0
fi

# Nur einen Prozess beenden, der wirklich src/server.mjs ausfuehrt — egal aus
# welchem Checkout. `ss -p` nennt Node 24 als "MainThread", der Name taugt
# also nicht; die Kommandozeile unter /proc schon.
CMDLINE="$(tr '\0' ' ' < "/proc/$PID/cmdline" 2>/dev/null || true)"
case "$CMDLINE" in
  *src/server.mjs*) ;;
  *)
    echo "Auf Port $PORT lauscht PID $PID, aber das ist kein Agent-Colony-Server:"
    echo "  ${CMDLINE:-<Kommandozeile nicht lesbar>}"
    echo "Nichts beendet."
    exit 1
    ;;
esac

kill "$PID" 2>/dev/null || true
for _ in $(seq 20); do
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "Agent Colony auf Port $PORT beendet (PID $PID)."
    exit 0
  fi
  sleep 0.25
done

# Nach 5 s ohne Reaktion hart beenden; der Server haelt keinen Zustand, der
# verloren gehen koennte.
kill -9 "$PID" 2>/dev/null || true
sleep 0.25
if kill -0 "$PID" 2>/dev/null; then
  echo "PID $PID laeuft noch, auch nach kill -9."
  exit 1
fi
echo "Agent Colony auf Port $PORT hart beendet (PID $PID)."
