# このMacの運用手順

2026-10-04 Asia/Tokyo。ユーザーの明示的な全作業許可に基づき、2repositoryの運用移管・実Codex実行・Draft PR publication・遠隔status更新を完了した。過去の準備記録より、この文書を現在の稼働状態の正本とする。

## 起動と通常操作

デスクトップの「Local AI Manage.command」またはrepositoryの `Managed-Launch.command` をダブルクリックする。既存serviceを維持したままprivate Unix socketから短命・一回用の認証リンクを取得し、既定ブラウザを開く。画面は `http://127.0.0.1:42731/`。素のURLだけでは認証できない場合があるので、認証期限後はlauncherを再度開く。再認証時も設定・既存有効sessionは維持される。

- CareRecordとlocal-ai-manageの専用clone/stateを `registry.live.local.json` に登録。registryはGit対象外・0600。
- 全体Resumed、両repo Enabled / Resumed。最終GUI確認はrevision 5、idle、Current jobs / Needs human / Quota wait各0。Ready候補なし。
- 同時実行は全体2件・各repo1件。repo間round-robin、repo内priorityとIssue番号順。既定GPT-6.1 Sol / medium。
- 準備済みの通常Issueに既存worker規約に沿うmetadataと `codex:ready` を設定すると、候補を再検証して固定profileで実行する。関連PR、依存関係、unknown/partial stateはworkerが再検証する。
- GUIを閉じてもworker管理は継続する。Pause dispatchは新規開始を止め、実行中処理の完了を待つ。repo Pause / Disableも同様。Resumeは保存済みneeds-humanやquotaを解除しない。
- Draft PRを人がレビューする。業務PRの自動mergeは行わない。Issueの保存session/baseと実行履歴を消して再試行しない。

ログイン時に `local.local-ai-manage.controller` と `local.local-ai-manage.status` のLaunchAgentが起動する。RunAtLoad、異常終了時再起動、明示Node24、owner-only plist/private logを使用。旧 `local.care-record.codex-worker` は無効化・登録解除済みで、二重writerは動かさない。通常終了・再起動時のlock/socket解放とGUI再接続を検証済み。強制終了後の不明reservation/lockは自動奪取せず [復旧手順](recovery.md) に従う。

private controllerは `~/.local/state/local-ai-manage-live`、status targetsは `~/.local/state/local-ai-manage-live-status`。handoffは登録全repoとregistry fingerprintに結び付く。元worker state・Issue履歴・worktree/session・移管前backupは保持している。旧Pause設定のprivate managed controllerとobserve-only registryも維持する。

## 遠隔status

| repository | 固定status | 実行試験のDraft PR |
| --- | --- | --- |
| CareRecord | [Issue #76の固定コメント](https://github.com/shougayaki-1/care-record/issues/76#issuecomment-5975781364) | [PR #75](https://github.com/shougayaki-1/care-record/pull/75) |
| local-ai-manage | [Issue #1の固定コメント](https://github.com/shougayaki-1/local-ai-manage/issues/1#issuecomment-5975781765) | [PR #3](https://github.com/shougayaki-1/local-ai-manage/pull/3) |

Macのstatus serviceはsanitized observationを固定workflowにdispatchする。両repoのdefault branchの `.github/workflows/codex-worker-status.yml` が唯一のcomment writerであり、直接PATCH publisherは起動していない。標準GITHUB_TOKENのcontents:read / issues:writeと固定Issue/commentのrepository variablesを使う。新PATは保存しない。Status Issueにcodex:* queue labelは付けない。

workflowはdefault branchの実行SHAに固定した2scriptだけをGitHub Contents APIで取得する。checkoutは使用せず、CareRecordの既存gitlinkを変更しない。dispatchと10分scheduleを同一concurrency groupに直列化し、実行中runはcancelしない。scheduled判定はheartbeatが15分超なら同じコメントをstaleへ変更する。Actionsの遅延はあり得る。

idle時はcontrollerの15秒heartbeatを明示的にmanaged-controllerとして表示し、実worker稼働時はworker telemetryを使用する。heartbeatは実行権限や孤児停止の証明に使わない。保存stateや過去イベントのmtimeがstaleでも、idle中のcontroller heartbeatとは別の情報。遠隔statusのPausedは保存worker state、GUIのPauseはcontrollerのdispatch意図であり同一ではない。quota残量はunknown、CLI起動modelは実起動時のみ表示する。

最終確認時に両固定コメントがidle / observed / managed-controllerへ更新され、実workflow run [CareRecord 37173083230](https://github.com/shougayaki-1/care-record/actions/runs/37173083230) と [local-ai-manage 37173108625](https://github.com/shougayaki-1/local-ai-manage/actions/runs/37173108625) が成功した。独立inspectionも実runで成功、stale/future/逆順payloadは回帰テストで検証済み。実時間15分のMac停止試験は行っていない。

## 検証と変更の範囲

- 管理アプリ92テスト、取り込みworker115テスト成功。typecheck / lint / build / diff whitespace確認成功。
- Macの短いisolated HOME、owner-only dashboard IPC、既存sessionを維持した再認証、CLI flag、idle supervisor heartbeat、strict remote grammarを検証した。
- CareRecord Issue #55は保存session/baseを保持して実resumeし、親検証と通常worker処理でDraft PR #75まで完了。unit 516件（76ファイル）、typecheck / lint / CI合成環境build成功。PRのGitHub CIも成功。
- local-ai-manage Issue #2は実GUIからdispatchし、人待ち停止の原因を解消して同じsession/baseで再開。親検証からDraft PR #3まで成功。差分はprofile利用文書のみ。
- 運用workflowのCareRecord PR #77 / #78 / #79は内容・CIを確認して手動merge。業務Draft PR #75 / #3はmergeしていない。
- 本番credentialのコピー、local E2E、DB/migration適用は実施していない。CareRecordのPRに設定されたGitHub CIはその既存検証を実行した。通常のmain pushによる既存GitHub/Vercel integrationは停止・変更していない。

対応profileはcare-record-v1とlocal-ai-manage-v1。Tauri、任意repo profile、model overrideは将来範囲。並列実行は全体上限内で各repo1件に対応。新しいrepoはorigin/path重複・exact scripts・固定profile・移管確認を整えて登録する。

## スマホ・外出先からの管理（2026-10-04追加）

controllerに `--tailscale auto` を追加し、VPN接続時だけスマホ用の入口を有効化する。Macの管理画面の「スマホ用ログインリンク」または `Mobile-Link.command` から短命・一回用リンクを取得する。MacのTailscale IPv4は追加時点で `100.84.0.122`、portは42731。Mac / iPhoneのTailscale接続を確認。通常のloopbackアクセスと保存されたdispatch設定を維持する。詳細と再認証手順は [スマホ接続](mobile-access.md) を参照。

反映後の実serviceで `100.84.0.122:42731` の未認証401、bootstrap200、status200、CSRF取得200、別Origin403を確認。待受は127.0.0.1とTailscale IPv4だけ。controller revision 5 / 全体Resumed / scheduler idleを維持。iPhoneのTailscaleアドレスへのping応答を確認。アプリ96件・worker115件、typecheck / lint / build / diff-check成功。iPhoneブラウザでの表示・操作は端末側での確認対象。

## 確認待ちの保留とGitHub通知（2026-10-04追加）

managed workerでIssueがneeds-humanになった場合、保存されたcurrentを次の独立Issueの開始前にhumanWaitingへ移す。session/base/worktree/検証失敗回数/結果はそのまま保持する。GitHubのcodex:needs-humanも維持し、確認待ちIssueと未完了の依存Issueがあるタスクは再実行しない。手動の全体・repo Pause/Disable、共有quota、不明reservationは引き続き新規実行を止める。確認待ちは管理画面の「確認が必要」に常時表示する。保留Issueの再開は人の判断後に保存状態を使って個別に行い、ラベル削除だけで自動再開しない。

status serviceの `--mention-user shougayaki-1` によりcurrentまたはhumanWaitingの確認待ちを30秒ごとに確認する。各repoの `codex-worker-attention.yml` と固定 `engine/attention-writer.mjs` が、GitHub Actions Botから該当Issueに@メンションする。repo variable `CODEX_WORKER_MENTION_USER` は通知先login。issue/reason/category/checkだけを渡し、本文・ログ・session・保存パスは送らない。同じIssueと確認理由の通知はGitHub側のBotコメントmarkerで重複を防ぎ、再起動や応答喪失後も再通知しない。失敗時は5分間隔で再試行する。コメントを削除すれば次回の試行で再通知する。返信を自動で実行許可として扱わない。

通知workflowはcontents:read / issues:writeだけを使用し、default branchの実行SHAに固定したscriptをContents APIで取得する。固定statusコメントのwriterとは別のconcurrency laneで、該当Issueへ新規commentを作成する。業務PRのmerge、DB適用、credential変更は行わない。

反映確認: 通知専用の運用PR [CareRecord #80](https://github.com/shougayaki-1/care-record/pull/80) / [local-ai-manage #4](https://github.com/shougayaki-1/local-ai-manage/pull/4)を反映。CareRecord側のCI成功。実Bot通知 [#39へのコメント](https://github.com/shougayaki-1/care-record/issues/39#issuecomment-5978256184)、[Actions run 37190173341](https://github.com/shougayaki-1/care-record/actions/runs/37190173341)の成功を確認。serviceの通常停止・再起動前にprivate backupを取り、controller revision 5のResume設定を維持。#39のcurrent全体がhumanWaitingへそのまま保存されたことを元stateとのJSON比較で確認。次の独立候補#47をmanaged dispatch。管理アプリ101件・worker119件、typecheck / lint / build成功。

## Issue #5 人間承認の反映（2026-10-04）

実装commit [2311283](https://github.com/shougayaki-1/local-ai-manage/commit/23112835925fb68309b883b6f70f5b8747186e1d) を `codex/initial-controller` へPushし、このMacのcontroller/statusに反映した。稼働中の実行がないことを確認し、dispatchを保守Pause、privateなcontroller/worker stateとビルドをbackup、両serviceをSIGTERMで通常終了してから再ビルド・再起動した。lock/socketは旧processが解放し、削除・強制奪取はしていない。

認証済みの実APIでapprovalRevision 0とcurrent/humanWaitingのカテゴリ別missing表示を確認した。不明repositoryを含む承認requestは400で拒否。人間承認は作成していない。CareRecord current #58 / humanWaiting #39, #47, #48, #57, #59、およびlocal-ai-manage current #5のstate.jsonはbackupとのSHA-256比較で完全一致した。repo Enabled/Resumedを維持し、保守Pauseだけを解除して全体Resumed、controller revision 7、scheduler idleへ復帰した。通常heartbeatと2つのLaunchAgentの新PIDを確認した。

管理アプリ113件・worker130件（合計243件）の回帰、typecheck / lint / build / diff-check成功。E2E・DB適用・needs-human解除・業務PR mergeは行っていない。承認手順・scope・stale・再開契約は [人間承認の手順](human-approvals.md) を参照。管理画面を再読み込みすると承認操作が表示される。default branchへのmergeは行わず、Pushしたbranchのビルドを既存LaunchAgentが使用する。


## 並列実行と停止原因の解消（2026-10-04）

全体上限2・各repository1件へ変更し、controller/statusをprivate backup後に通常停止・再build・再起動した。scheduler version 2は旧単一予約のschemaを引き継いで読み、全予約を保持する。repository別dispatch journal、短いadmission lane、共有quota、全jobのdrain、承認時の対象repository lock、offline recoveryの全lane fingerprintを検証した。詳細は [並列実行と停止原因](parallel-execution.md)。

CareRecord #74の停止は、saved baseと同じvercel.jsonに実行branchのfalse項目がないことが原因だった。managed parentによるbranch限定抑止の準備を追加し、既存session/worktreeで親検証から [Draft PR #83](https://github.com/shougayaki-1/care-record/pull/83) まで完了した。業務PRはmergeしていない。

#39はcredential分離・合成test環境でtypecheck/lint/unit/UI/buildが成功、protected diffの検出なし。saved baseとmainの差は #80の通知workflow/scriptの2fileだけだった。初回の復旧操作はautomatic approval reviewで拒否されたが、ユーザーの明示承認後、元state/baseをbackup、fast-forward前後の実装diffDigest一致とsession保全を確認して親検証へ戻し、GitHub labelをreadyへ変更した。独立した親unit検証で失敗したため、保存sessionによる有限self-repairへ進んだ。

#45はopenの#39、#60〜#63はopenの#59への依存で待機。DB/RLSや認証差分、実行必須E2Eのscope承認が必要な #47/#48/#57/#59は未解除。Ready labelが再付与されてもhumanWaitingを確認待ちとして表示する。

回帰はアプリ120件・worker134件（合計254件）成功、typecheck/lint/build/diff-check成功。アプリ全fileのfixture同時実行で既存producerのタイミングテストが不安定になったため、最終の全アプリ回帰はtest-concurrency=1で確認した。producer単体の全回帰も成功。実際のworker重複は追加の並列テストで確認済み。実serviceのglobalConcurrency 2とactiveJobsを認証APIで確認した。両repoに実候補が同時にはなかったため、実Codex2件の同時起動は未試験。


#47/#57のローカルtypecheck/lint/unit/UI/buildはすべて成功した。#59のUIにはPopover transition完了前のvisibility assertion失敗があったため、StorybookのwaitForで条件成立を待つ最小修正を保存worktreeのstoryだけに適用し、UI全件成功を確認した。固定sleep/timeout増加・DB/RLS変更・state/label変更はしていない。protected diffは #47=db/security/permission、#57=auth、#59=auth/db/security/permissionであり、カテゴリ承認を保持する。

#39の再試行はCLIのquota errorで一度止まった。minute-onlyの回復時刻を同じ分の13秒後に読むと翌日へ繰り越すバグを修正し、現在分は1分後、明確な過去時刻は翌日、明示timestampはそのままとする回帰を追加した。最新account observationはordinaryUsageAllowed=true、primary usedPercent=3だった。ユーザーの「再開して」に基づき、記録が誤翌日化のパターンと完全一致し実行lock/予約がないことを確認、private backup/receiptを保存してworker・scheduler・settled dispatchの既知retry時刻だけを1分後へ訂正、controllerを通常再起動した。quotaWaits/session/失敗履歴は保持し、reset券は使っていない。全体と両repoのResume/Enableを維持する。

親検証は、scope承認を通過したhumanカテゴリをローカルscript委譲の検査へ再投入しないよう修正した。auth理由をresultにも含む実際の形で、承認から親検証・mock publicationまでの回帰を確認した。public build assetのsandbox download制限は親build検証へ委譲するpromptを明確化し、実credential/production/external serviceの境界を維持した。

再試行時刻の訂正後、#39 は同じsessionで実resumeした。未変更のunitテストで15件のtimeoutが発生してneeds-humanとなったが、独立した標準 `npm run test:unit` は設定変更なしで成功した。親検証が追加した当該branch限定のVercel deploymentEnabled=false項目により、元の承認diffDigestとは相違する。実装だけのdigest照合を条件に再検証へ戻す案はautomatic approval reviewで未承認の追加差分として拒否されたため、追加scopeの明示承認待ちに留める。全体の保守Pauseは解除する。

## ローカルDB/E2Eの自動検証へ切替（2026-10-05）

ユーザーが「必要なローカルDB/E2E検証も自動で行う」を選択したため、CareRecordのregistryにlocal-automatic方針を追加する。コード差分のカテゴリ承認をPRレビューへ移し、E2E必須Issueの実装前停止を解消。固定親runnerは新規Supabase project・空きport・seedなしでmigrationを適用し、DBテスト・存在するisolation spec・public型比較・固定全specのdesktop/mobile E2Eをretry 0で検証する。成功前のpush/Draft作成、production・実credential・既存DB利用・mergeは許可しない。

実#47の使い捨てDB起動・migration適用は成功したが、DBテストで失敗した。一時stackはcleanup済みで、その試験だけではPR作成していない。固定phase/test識別子だけを同じsessionの有限repairへ渡す。旧credential/external_service labelも、固定unit/buildのcredential分離試験が成功した場合に限り検証項目を解消する。承認履歴を偽造・一括追加しない。

回帰は管理アプリ123件・worker144件（合計267件）、typecheck/lint/build/diff-check成功。mock local runnerでDB失敗・skip・中断cleanup・実credential非継承を確認。保存jobの自動選択、実credential/production禁止、同じgit statusでの内容改変拒否も検証した。詳細は [自動ローカル検証方針](human-approvals.md#ローカル検証の自動化2026-10-05)。


反映中の通常停止では旧controller lockが残った。LaunchAgent全登録解除、controller/bridge/standalone processなし、open lockなし、全worker lockなし、予約idle/空、全worker stateのbackup一致を確認し、既存offline recoveryで旧directoryをretireして `~/.local/state/local-ai-manage-live-auto-local` へrotationした。旧lock・control receiptsは旧directoryに保存し、既知quotaを引継ぎ、dashboard signing keyと固定status targetを維持した。registry/handoff/quota/status fingerprintを新方針へ同期、既存LaunchAgents・Managed/Mobile launcherのcontroller-stateも新directoryへ変更した。

shutdownはschedulerの新規実行を停止してからGitHub observerをabortし、その後drainを待つ順序へ修正した。実controllerでSIGTERM後の自力lock解放とkickstart成功を確認。新しいrevision系で全体・両repoをResumeする。自動検証へ進めるだけのcode-review待ちは人への通知を抑止し、本当の検証失敗は既存通知schemaへ固定projectionして残す。#39の個別復旧は未承認の追加差分についての以前のreview拒否と実検証停止を保持し、一括で解除していない。

最終確認: 新controller revision 3で全体・両repo Enabled/Resumed、全体上限2。#47を保存jobから自動選択しlegacy local probeへ投入したが、成功条件を満たさずautomatic_verification_failedとして保留した。その他の自動対象は独立に再選択する。これは人間承認を足せば成功扱いになる状態ではなく、実検証／環境の失敗を保持するもの。旧controllerの未完了予約を消して再実行したわけではない。
