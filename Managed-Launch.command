#!/bin/zsh
set -eu
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
cd -- "${0:A:h}"
if [[ ! -f dist/server/cli.js || ! -f registry.managed.local.json || ! -f "$HOME/.local/state/local-ai-manage-managed/handoff.json" ]]; then
  print 'Managed setup is missing. Complete the reviewed handoff first.'
  read '?Press Enter to close.'
  exit 1
fi
exec node dist/server/cli.js --registry registry.managed.local.json --controller-state "$HOME/.local/state/local-ai-manage-managed" --github --execute --open
