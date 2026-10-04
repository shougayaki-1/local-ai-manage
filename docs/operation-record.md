# このMacの運用移管記録

現在の2repo稼働・実dispatch・遠隔status更新は完了済みです。最新状態は [運用手順](live-operation.md) を参照してください。以下は機能説明または準備時点の履歴です。

更新: buildはworkerの正規CI合成環境で成功し、#55のGoogle-first問題もworktreeで修正・検証した。最新の結果は [停止原因解消記録](resolution-record.md) を参照。以下の過去の失敗記録は環境未指定の単独buildについてのもの。

2026-10-04 Asia/Tokyo。ユーザーの「OK、色々許可します」を受け、安全な停止・自動再起動防止とPause状態の管理設定を実施した。

## 実施した操作

- 旧LaunchAgentはloaded/not running/last exit 0、登録workerプロセスなし、保存Issue #55はneeds-human/paused。別のChatGPTアプリのCodex実行は対象外として維持。
- private maintenance directoryに元state/Issue履歴/schema、変更対象source、LaunchAgent原本とhash manifestを保存。credential/.envをコピーせず、worktree・runsは既存場所に保持。
- `local.care-record.codex-worker`をdisable、bootout。現OSのprint-disabledは `=> disabled` と表示する。初回のtrue/falseだけのparserではoverrideを正しく取得できなかったため、元override状態は確実な証跡として扱わない。
- 再照合ready-for-reviewを確認して専用clone bundleを適用。適用後planはalready-present。既存未commit runner変更も捕捉したbaselineに一致させ、無関係な差分をreset/commitしない。
- 元state/Issue履歴/schema、publication.mjs、verification.mjs、LaunchAgent原本のbyte一致を確認。session/base/retry/quotaや#55のneeds-humanを解除していない。
- registry.managed.local.jsonとprivate managed controller/handoffを準備。実際のservice解除・再起動無効化・状態保全の確認に基づく登録全体のhandoff。初期全体/repo Pause。
- Managed-Launch.commandを追加。通常Launch.commandのobserve-onlyは維持。管理GUIでpaused revision 0、repo Enabled/Paused、#55 needs-human、producer source確認済みを検証。

## 検証結果と限界

- 専用clone: worker 103件成功、typecheck/lint成功。buildはコンパイル/型検査後、Supabase環境変数不足で /auth/reset-password のページ収集に失敗。missing資格情報をダミーや本番値コピーで回避していない。
- manager: app 88件、engine 115件成功。typecheck/lint/build成功。managed entrypointの保護も回帰対象。
- GUIのPauseを確認した限定接続検証であり、実Codex/PR publication trialの成功とは扱わない。Status Issue/commentへの実投稿とActions schedule有効化も行っていない。

## 利用と次の確認

Managed-Launch.commandで管理GUIを起動する。現在は全体とrepoをPauseに保つ。Resumeしても#55の人待ちは解除しない。controllerの保存Resume設定は次回起動にも引き継ぐ。

実dispatch前には、非本番のbuild/check環境と現在worktreeのdeployment抑止、#55の人待ち原因を別途確認する。新しいIssueを試すために保存current/sessionをresetしない。producerのheartbeat/modelは実worker起動時に生成するため、Pause中に未取得でも起動時刻で代用しない。

rollbackは管理GUIを終了し、そのworker/Codex子processが全て終了したことを確認してから検討する。旧LaunchAgentを単にenable/bootstrapして並行writerを作らない。元overrideは未確定なので自動復元しない。元plistとsource/state backupはprivate maintenance directoryに保持し、GUI/APIから復元しない。

実装前の一次ドキュメント確認: Context7でNode.js 24のfs exclusive creation/no-follow/copy/fsyncを確認（2026-10-04）。LaunchAgent操作はこのMacのlaunchctl helpでdisable/bootout構文を確認した。
