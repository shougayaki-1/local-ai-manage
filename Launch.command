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
  if [[ -t 0 ]]; then read '?Press Enter to close.' || true; fi
  exit 1
fi
if [[ -f registry.local.json ]]; then
  node dist/server/cli.js --registry registry.local.json --github --open
else
  node dist/server/cli.js --demo --open
fi
