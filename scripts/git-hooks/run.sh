#!/bin/sh
# Shared entry for the git hooks: find node, run the leak check with the
# given arguments. Enabled with `git config core.hooksPath scripts/git-hooks`.
# Git GUIs and editors often run hooks without nvm on the PATH, so fall back
# to the version in .nvmrc and then to any nvm install. Without node the hook
# blocks: a check that cannot run must not let a commit through.
root=$(git rev-parse --show-toplevel) || exit 2
node=$(command -v node 2>/dev/null)
if [ -z "$node" ]; then
  want=$(tr -d ' \n' < "$root/.nvmrc" 2>/dev/null)
  for candidate in "$HOME/.nvm/versions/node/$want/bin/node" "$HOME"/.nvm/versions/node/*/bin/node; do
    if [ -x "$candidate" ]; then node=$candidate; break; fi
  done
fi
if [ -z "$node" ]; then
  echo "leak-check: node not found, blocking. Install node or put it on the PATH." >&2
  exit 2
fi
exec "$node" "$root/scripts/leak-check.mjs" "$@"
