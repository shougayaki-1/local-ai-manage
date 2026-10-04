#!/bin/zsh
set -eu
export PATH="$HOME/.local/share/fnm/node-versions/v24.12.0/installation/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
cd -- "${0:A:h}"
TRAPZERR() {
  print '管理画面の起動に失敗しました。上のエラーを確認してください。'
  if [[ -t 0 ]]; then read '?Enterで閉じる' || true; fi
  exit 1
}
if ! command -v node >/dev/null 2>&1; then
  print 'Node.jsが見つかりません。Node.js 24.12.0以上をインストールしてください。'
  if [[ -t 0 ]]; then read '?Enterで閉じる' || true; fi
  exit 1
fi
if [[ ! -f dist/server/cli.js ]]; then
  print 'Build is missing. Run npm ci and npm run build first.'
  if [[ -t 0 ]]; then read '?Enterで閉じる' || true; fi
  exit 1
fi
service="gui/$(id -u)/local.local-ai-manage.controller"
if /bin/launchctl print "$service" >/dev/null 2>&1; then
  /bin/launchctl kickstart "$service"
  for attempt in {1..10}; do
    if node dist/server/cli.js --open-existing --controller-state "$HOME/.local/state/local-ai-manage-live" 2>/dev/null; then
      print '管理画面をブラウザで開きました。管理サービスはバックグラウンドで稼働を続けます。'
      print 'このTerminalウィンドウは閉じて構いません。'
      exit 0
    fi
    sleep 1
  done
  print '管理GUIを開けませんでした。保存状態を保持して停止しています。運用記録を確認してください。'
  if [[ -t 0 ]]; then read '?Enterで閉じる' || true; fi
  exit 1
fi
node dist/server/cli.js --registry registry.live.local.json --controller-state "$HOME/.local/state/local-ai-manage-live" --github --execute --tailscale auto --open
