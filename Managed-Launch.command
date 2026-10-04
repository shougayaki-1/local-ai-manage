#!/bin/zsh
set -eu
export PATH="$HOME/.local/share/fnm/node-versions/v24.12.0/installation/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
cd -- "${0:A:h}"
service="gui/$(id -u)/local.local-ai-manage.controller"
if /bin/launchctl print "$service" >/dev/null 2>&1; then
  /bin/launchctl kickstart "$service"
  for attempt in {1..10}; do
    if node dist/server/cli.js --open-existing --controller-state "$HOME/.local/state/local-ai-manage-live" 2>/dev/null; then exit 0; fi
    sleep 1
  done
  print '管理GUIを開けませんでした。保存状態を保持して停止しています。運用記録を確認してください。'
  read '?Enterで閉じる'
  exit 1
fi
exec node dist/server/cli.js --registry registry.live.local.json --controller-state "$HOME/.local/state/local-ai-manage-live" --github --execute --open
