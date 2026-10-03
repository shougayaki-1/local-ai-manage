#!/bin/zsh
set -eu
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
cd -- "${0:A:h}"
if [[ ! -f dist/server/cli.js ]]; then
  print 'Build is missing. Run npm ci and npm run build first.'
  read '?Press Enter to close.'
  exit 1
fi
if [[ -f registry.local.json ]]; then
  exec node dist/server/cli.js --registry registry.local.json --github --open
else
  exec node dist/server/cli.js --demo --open
fi
