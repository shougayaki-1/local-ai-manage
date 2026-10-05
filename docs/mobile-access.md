# スマホ・外出先からのアクセス

Macとスマホで[Tailscale](https://tailscale.com/download)をインストールし、同じアカウントで接続する。Mac側のVPN / 機能拡張許可とスマホ側のVPN許可を完了する。Macは起動・ログインした状態でネットワークに接続しておく。スリープ中はアクセスできない。

このMacのcontroller LaunchAgentは `--tailscale auto` を使用する。接続済みのTailscale IPv4アドレスを5秒ごとに検出し、そのアドレスだけに追加listenerを起動する。未接続・再接続中もloopback管理画面とworker controllerは継続する。LANやインターネットの全interfaceにはbindしない。Tailscaleの接続先権限はtailnetのアクセス設定に従う。

## スマホで開く

1. Macの通常launcherで管理画面を開く。
2. 「スマホ用ログインリンク」を押す。リンクはMac側だけで認証後に取得できる。
3. 発行されたリンクを自分のスマホへ渡し、2分以内にSafari / Chromeで開く。スマホのTailscaleを接続しておく。
4. 認証後は `http://<MacのTailscale IPv4>:42731/` をブックマークして使える。認証は30日間保持し、利用時に期限を更新する。管理サービスの通常再起動でも維持する。Cookieを削除した場合・別のブラウザ・30日間未使用の場合はMacで新しいリンクを取得する。古い一回用リンクを開き直しても、有効な認証が残っていれば表示を続ける。

[Mobile-Link.command](../Mobile-Link.command)をダブルクリックしても、新しい一回用リンクを表示できる。ログインリンクは認証用なので他人へ渡さず、ログへ保存しない。再発行は既存の認証済みセッションを無効化しない。

外出先でもスマホのTailscale接続を維持する。HTTPの通信はTailscale VPNで暗号化される。ポート開放、Funnelや公開tunnelは使用しない。Macのローカル管理画面は引き続き `http://127.0.0.1:42731/`。

## スマホでの表示と操作

画面幅760px以下ではリポジトリ切替が上部に並び、収まらない項目は横にスワイプして選べる。選択中のリポジトリは背景と枠で表示する。「全体の状況」で全リポジトリの表示に戻る。

実行待ち、リポジトリ設定、確認項目、イベントは項目名付きの縦型カードで表示する。一時停止・再開・有効化などの操作ボタンは高さ44px以上。長いリポジトリ名や状態は折り返し、画面全体の横スクロールを防ぐ。横向き・タブレット・PCでは画面幅に応じて一覧表と複数列の表示に切り替わる。

## CLI

```sh
npm start -- --registry registry.local.json --tailscale auto --port 42731
# 稼働中managed serviceのスマホ用リンクを取得する
npm start -- --mobile-link --controller-state /Users/shoug/.local/state/local-ai-manage-live-auto-local
```

`--tailscale <100.x.x.x>` は割り当て済みTailscale IPv4アドレスへの明示bind。`--lan <192.168.x.x>` は同じWi-Fi用の明示bindで、Tailscaleとは併用不可。LAN HTTPはVPNで暗号化されないため、外出先用にはTailscaleを使う。既定はloopbackのみ。

## 検証範囲

単体 / HTTP回帰で認証、一回用リンク、Origin / Host / peer制限、LAN opt-in、Tailscaleアドレス範囲、VPN未接続時のlocal継続、既存controller操作を確認する。スマホのSafari / Chrome上での実操作は端末で確認する。

通信切断は自動で再接続し、Tailscale再接続や画面復帰時にも再確認する。認証切れとは別の表示にする。非表示のタブは定期取得を止め、複数タブによるアクセス集中を減らす。署名鍵はcontrollerのprivate保存領域の `dashboard-auth.key`（0600）に保存する。CookieはHttpOnly / SameSite=Strictを維持し、操作にはOrigin検証とCSRFを必要とする。
