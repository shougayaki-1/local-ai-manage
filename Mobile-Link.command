#!/bin/zsh
set -eu
export PATH="$HOME/.local/share/fnm/node-versions/v24.12.0/installation/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
cd -- "${0:A:h}"
print 'MacとスマホのTailscaleを接続し、以下のリンクを2分以内にスマホで開いてください。'
if ! node dist/server/cli.js --mobile-link --controller-state "$HOME/.local/state/local-ai-manage-live-auto-local"; then
  print 'スマホ用リンクを取得できません。管理サービスとTailscaleの接続を確認してください。'
fi
read '?Enterで閉じる'
