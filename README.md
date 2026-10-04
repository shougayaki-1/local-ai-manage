# Local AI Manage

Mac上のCodex Continuous Workerを複数repositoryで管理するlocal dashboard。

このMacの運用移管・実行検証は完了しています。起動・停止・遠隔statusの最新手順は [運用手順](docs/live-operation.md) を参照してください。
初期状態ではworkerに対して **observe-only** です。controllerのdispatch設定はGUIから保存できます。明示的な移管設定と `--execute` を揃えた場合だけ、schedulerが固定workerを1件ずつ実行します。通常のlauncherは観測のみです。`--github`でGitHub queueの読み取りを接続できます。

## 起動

Node.js 24.12以降を使用します。

```sh
npm ci
npm run build
npm run demo -- --open
```

デモは合成データだけを使います。`--open`はMacの既定ブラウザで認証付きリンクを開きます。
Mac以外や`--open`省略時は、一回用ログインリンクを標準出力に表示します。2分以内に開いてください。リンクを共有したり出力をログへ保存しないでください。URL fragmentは画面起動時に除去されます。

## Macでの起動

[Launch.command](Launch.command)をダブルクリックすると、git対象外の`registry.local.json`があれば実stateをobserve-onlyで表示し、なければ合成デモを開きます。GitHub queueの読み取りも接続します。worker起動やLaunchAgent登録は行いません。今回のローカル設定には既存CareRecord workerのpathを登録済みです。終了は起動したTerminalでCtrl+Cを押してください。通常launcherはdashboardだけを止めます。実行を有効化した起動では、新規dispatchを止め、現在のjobが終わるまで待ちます。

## 実repositoryの観測

`registry.example.json`を`registry.local.json`へコピーし、GitHub owner/repo、専用cloneの絶対path、**既存state directory**を記入してください。秘密情報は保存しません。registryは任意コマンド・credential項目を受け付けません。

```sh
npm start -- --registry registry.local.json --github --open
npm start -- --registry registry.local.json --github --status
```

複数repositoryは配列に追加できます。origin一致、canonical path、同じGit common directoryや入れ子stateの重複を検証します。各cloneとstate directoryは既存である必要があります。stateがない/不正/別repoならUnavailableとなり、作成・修復はしません。

`enabled`はcontroller設定の初期値です。GUIのEnable/Disableはcontroller専用領域に保存され、registryそのものは変更しません。`enabled`だけでは実行せず、移管確認と `--execute` も必要です。registryのownershipはobserve-onlyのみ、global/repository concurrencyは1のみです。CareRecord stateは移動せず旧pathを指定してください。

## Controller設定

停止理由ごとの人間承認と、承認した差分／Issue要件に限定した再開を実装しました。管理画面の「確認が必要」から操作できます。Pause/Enableとは独立です。詳細は [人間承認の手順と契約](docs/human-approvals.md) を参照してください。

GUIで全体Pause/Resume、repositoryごとのPause/Resume・Enable/Disableを保存できます。**既定の起動では設定保存のみ**です。`--execute`で明示的に移管設定を接続した起動では、schedulerの次のdispatchへ適用します。このMacでは2repoの移管と実dispatchを完了し、全体/repo Resumeで通常待機しています。GUI操作はneeds-human、workerのpaused、failure counter、session、quota、GitHub labelを直接変更しません。managed workerの通常処理は既存契約に従ってstate/labelを更新します。

初回は全体およびrepositoryがPausedです。独立保存領域は `~/.local/state/local-ai-manage`。別pathは `--controller-state /absolute/private/directory` で指定できます（親directoryは事前作成）。clone/worker stateと重なるpath、symlink、他ユーザー所有、group/worldアクセス可能なdirectoryは拒否します。directoryは0700、ファイルは0600。demoおよびCLI `--status` はcontrollerを開かず、worker観測だけを返します。

操作schemaは `{requestId, expectedRevision, target, action}` のみ。targetはglobalまたは登録済みid、actionはpause/resume/enable/disable（globalはpause/resumeのみ）。UUID v4 request IDで再試行を冪等にし、revision競合を409で返します。ackの `applied / dispatch-intent` はcontroller設定の保存確認です。managed modeでは別field `application` が `draining / applied / blocked / not-managed / superseded` を返します。Pause/Disableは現在のjobが終わるまでdraining、以後のdispatch停止を確認できればappliedです。Resume/Enableのappliedはdispatch gateへの反映であり、needs-humanの解除やCodex起動成功の意味ではありません。GUIは応答不明時に同じIDで再確認し、draining receiptを追跡します。

保存は単一write lane、0600一時ファイルのsync→rename→directory sync。保存結果が不明なら以後のwriteを拒否します。履歴は最大1024操作で、上限時は新規操作を拒否し、IDの重複防止記録を勝手に破棄しません。起動時はschema、registry topology、履歴revisionと設定の整合を検証します。

`controller.lock`はexclusive作成し、自動で奪取しません。異常終了後のlockは、**このdashboard processが終了していることを確認してから**管理者が対応してください。worker.lock/stateを消す操作ではありません。別controllerの二重起動は失敗します。Managed launcherは起動済みserviceのprivate socketから新しい認証リンクを取得します。

HTTP操作には認証cookie、厳密なOrigin、JSON、session固有CSRF tokenが必要です。操作は30回/分、readは120回/分に制限。異常stateやstale lockを修復・削除するAPIはありません。

## 表示の意味

- status/stage/Issue/retry/quotaは保存stateの観測。process livenessは未確認。
- 固定bridgeのheartbeat／CLI起動model・effortを表示。旧workerは未取得。configured defaultとは区別します。
- 5分以上更新されていないstateはstale。quota中にstaleでも故障とは判断しません。
- `--github`でqueue/priority/dependencies/関連PRを読み取り表示。省略時は未接続で、空queueと判断しません。
- queueはrepo内priority→Issue番号順。metadata優先、次にpriority label、未指定は最後です。dependency open/unknown・関連PR・不正metadata・既存除外labelはReadyになりません。
- 取得範囲はIssue/PR/timelineの各先頭100件、repo観測ごと最大24 GET。paginationの残りやAPI予算不足はpartial/unverifiedと表示します。
- HTTP pollingからの呼出しはcacheを使い、全repoで同時1lane、30秒ごとに1repoを順番に更新。25秒の全体deadline、gh単発10秒/8MiB制限。5分以上前のqueueはstale。前回成功後の取得失敗はstaleとして保持します。
- Readyは観測時の候補であり、worker実行やclaimを意味しません。実行adapterの接続時にfresh Issue/依存/PRを再検証する必要があります。
- Recent runsは既存issue-N.jsonの最大4096 directory entriesから20件/repo、Issue番号降順であり実行日時順ではありません。
- Issue/PR/diffは検証済みGitHubリンク。raw local diff/log viewerはありません。

## 安全境界

既定は127.0.0.1にのみbind。明示 `--tailscale auto` でVPN専用、`--lan <private IPv4>` でLAN専用の入口を追加できる。Host/Origin/peer検証、他origin CORSなし、HttpOnly SameSite=Strict session、短命single-use bootstrap、固定CSP、no-store。port競合は失敗し外部bindへfallbackしません。

APIはraw stateを返しません。Issue本文/タイトル、branch、絶対path、session、result/progress自由文、token、PHI、raw stderr/tool output/reasoningを投影から除外します。stateJSONとarchiveはsymlink・1MiB超過を拒否。raw errorを返しません。秘密データが正規field（owner/repo等）に入らないようregistryは管理者が確認してください。

API: GET `/api/status`, `/api/repositories`, `/api/repositories/:id/status`, `/api/queue`, `/api/runs`, `/api/logs`。read APIにも認証が必要です。POST `/api/session`はsession bootstrap、POST `/api/controls`はcontroller dispatch設定の保存専用です。GET `/api/csrf`、`/api/requests/:requestId`でCSRF tokenと適用結果を取得します。worker control endpoint、shell/exec、GitHub proxy、任意path読取はありません。

GitHub認証は既存gh/OS keyringを再利用し、必要時だけgh subprocessに限定したGitHub環境を渡します。tokenを取り出したり設定へ保存したりしません。CODEX_HOME/API key/Supabase key/GH_DEBUG/NODE_OPTIONSはghに渡しません。Issue本文はmetadata解析のため一時的に取得しますが、cache・API・GUI・ログには保存しません。GET固定endpoint以外をadapterは拒否します。

同一OSユーザーによる攻撃を完全隔離するsandboxではありません。専用workerユーザー/cloneと既存sandbox/credential isolationを維持してください。Tailscale / LANの接続手順は [スマホからのアクセス](docs/mobile-access.md) を参照してください。Tauriは将来の対応範囲です。このMacのcontroller/status LaunchAgentは登録済みです。

## 検証

```sh
npm run typecheck
npm run lint
npm test
npm run build
git diff --check
```

テストは一時directory、合成state、local Git、loopback HTTPだけを使用します。実worker/state/GitHubを操作しません。E2E・Supabase・migration・production・deployは実行しません。

設計、対応範囲、次のIssueは [docs/implementation-plan.md](docs/implementation-plan.md) を参照。


## 実行adapter（内部契約・移管後に接続可能）

`src/worker-adapter.ts`に固定profileの1件実行adapterを追加しました。schedulerから呼ぶ経路を実装しました。HTTPからの任意実行やLaunch.commandの自動有効化はありません。既定dashboardは観測のみです。

- workerは `engine/care-record` に取り込んだ固定artifactを呼びます。登録clone内のworkerスクリプトを実行しません。standalone CLI入口は取り除き、bridgeはIPCの固定schemaのみを受けます。
- care-record-v1とlocal-ai-manage-v1を実装。package名・exact scripts・保護対象をprofileごとに照合し、GPT-6.1 Sol / mediumを固定。詳細は[profile一覧](docs/profiles.md)。Issue metadataによるmodel/effort overrideは未実装です。
- 内部 `dispatchOnce` はcanonical registry、private ledger directory、登録repo id、正のexpectedIssue、明示的handoff attestationを要求。registryのenabledもtrueである必要があります。観測用registryはfalseのまま、別のlive registryでは登録2repoをtrueにしています。
- handoffの `standaloneStopped: true / scope: all-registered-workers` は、管理者が登録全repoのstandalone worker・Codex子processが終了し、再起動しない状態へ移管したことの申告です。lock不在から自動推測しません。GUIからこの申告を作るAPIはありません。このMacでは登録2repoの停止確認と移管を実施済みです。
- 全体exclusive `dispatch.lock` と、実行前にsync保存する `dispatch.json` reservation。異常終了・不正IPC・生存worker.lock・保存結果不明ならlock/reservationを保持して再実行を止めます。人による確認に基づくoffline rotation/replayはdocs/recovery.mdを参照してください。
- quota待機は前回adapter結果と全登録worker stateから検査。future nextRetryAt、期限不明のquota待機では他repoも起動しません。schedulerもshared quota gateと期限を永続化し、repository間をround-robinで選びます。
- expectedIssueとsaved currentが違えばworkerを進めません。saved needs-human/failed/pausedも解除せず、session/base/failures/quotaWaitsを維持します。session resume非対応時は保存sessionを捨てず人の確認へ止めます。
- 新規claimでは最新queue候補、fresh Issue、再取得した依存/関連PRを確認。候補変更や未確認なら実行しません。GitHub上のclaimは原子的ではないため、exclusive ownershipが必須です。
- parent verification、credential isolation、sandbox、finite self-repair、E2E禁止、DB/RLS等の境界、Draft-only publicationは取り込んだworkerのままです。bridge stdout/stderrはGUIへ渡さず、終了結果は固定schemaで投影します。

出典と取り込み差分は [engine/care-record/PROVENANCE.md](engine/care-record/PROVENANCE.md)。自動回帰はfake Git/Codex/GitHubと一時worktreeを使用します。別途、2repoの実dispatchからDraft PRまで検証済みです。


## Managed scheduler（運用移管後のみ）

`--execute --github --registry ...` でschedulerを接続します。demoやCLI `--status`との併用は拒否します。このMacのManaged launcher/serviceは移管済みのlive registryでこのflagを使用します。通常Launch.commandは観測のみです。 移管はstandalone writer/Codex子processの終了確認と再起動防止が必要な別作業です。

必要な条件:

1. canonical registryで対象repoのenabled=true、Sol / medium、選択profileのexact checks。
2. 専用private controller directory内の0600 `handoff.json`。対象repo id一覧と登録全体のfingerprint、`standaloneStopped: true`、`scope: all-registered-workers`が必要。ファイルは自動生成しません。
3. GUIで全体と対象repoをResumeし、controllerのenabled設定も有効にする。初回は全体/repo paused。再起動では保存済みの設定を保持するため、明示起動時には保存済みResumeが有効な場合があります。

handoff file schema（placeholderはそのまま使えません）:

```json
{
  "version": 1,
  "registryFingerprint": "<canonical registry fingerprint>",
  "standaloneStopped": true,
  "scope": "all-registered-workers",
  "repositories": [{"repositoryId": "owner--care-record", "profile": "care-record-v1"}]
}
```

fingerprintは `src/handoff.ts` の `registryFingerprint(loadRegistry(...))` で算出します。path、owner/repo、enabled、model/effortを含む全registryに結び付け、変更時は拒否します。これはプロセス終了を自動証明する仕組みではなく、管理者による移管確認です。観測用registryのenabledを変えると既存controller topologyも変わるため、移管時は別のprivate controller directoryを使い、観測用設定とworker stateを保持してください。

schedulerは全体1slot。repo間はround-robin、repo内はpriority→Issue番号、saved currentがあればその復元を優先します。queueはobservedかつ5分以内のみ候補にし、partial/stale/unknownをdispatchしません。stateのstaleは保存mtimeの意味でprocess生存判定ではなく、毎回readし、trusted workerで再検証します。読めない登録stateがあればshared quota判定をできないため全体停止します。

候補の確保はcontroller write laneでPause/Disableと直列化。worker実行中はlaneを保持せずGUI操作を受け付けます。Pause/Disableはprocessをkillせず、bounded job完了まで待ちます。worker自身のsession/base/quota/retry/needs-humanは維持します。

cursor・実行予約・cooldown・quota期限は0700 controller directoryの0600 `scheduler.json`へsync/renameで保存。完了後は30秒以上空け、古いqueueから同じ候補を高頻度で再検証しません。reservationやdispatch lockが残る再起動はblockedとし、PID・lock不在から自動回復しません。未知の実行結果や保存失敗もblockedです。HTTP経由のreconciliation APIはありません。明示的なoffline CLIについてはdocs/recovery.mdを参照してください。

Ctrl+C/SIGTERMは新規dispatchを止め、現在jobの完了を待ちます。trusted bridgeは別process groupで動くため、TerminalのCtrl+Cが子workerを直接終了させません。強制終了やOS再起動ではorphan確認が必要です。dashboard終了中もreceipt/statusで完了待ちを表示できます。

heartbeat／CLI起動model・effort／sanitized eventsを実装済みです。offline controller復旧CLIも実装済みです。復旧途中のjournal replayとlocal-ai-manage profileも実装済みです。このMacでは旧workerの自動起動停止、専用producer適用、2repoの実dispatchとDraft PR、remote statusの実更新まで完了しています。

### Worker telemetry

固定bridgeはworker lock取得後に0600 `telemetry.json`を生成します。15秒ごとのheartbeatは60秒でstaleとなり、通常終了はstoppedになります。更新はprocess生存や孤児の終了を証明せず、schedulerの実行許可には使いません。既存workerにsidecarがなければ未取得です。stateとIssue／stage／statusが一致しないsidecarも表示しません。

model／effortは固定Codex CLIがOSのspawn成功を通知した場合のみ表示します。CLIに渡した値であり、サーバー側のmodel解決を検証するものではありません。直近worker起動内の固定イベント（state、worker.started／stopped、codex.started）を最大100件保持し、本文・session・パス・stdout／stderrは収集しません。表示用保存に失敗してもjob契約は変えず、未取得／staleで表示します。

### Offline controller recovery

`--recovery-plan <new-controller-directory>` は読み取り専用診断です。`--reconcile <new-controller-directory> --attestation <private-json>` は対象snapshotに結び付いた全プロセス停止・自動再起動禁止の管理者確認を要求します。どちらもregistryと旧controller-stateを明示し、GitHub/実行/GUI flagsと併用できません。旧locks/journalsとworker dataを保存したまま旧controllerをretireし、置換先を全体/repo pausedで作成します。既知quota期限は引き継ぎ、不明なquotaはblockedのままです。worker lockを消したり、未知のjobを成功扱いにはしません。詳細は[復旧手順](docs/recovery.md)を参照してください。live復旧は未実施です。

復旧再開は `--recovery-resume-plan <new-directory>` →新しい停止確認file→ `--resume-recovery <new-directory> --attestation <private-json>` の順です。以前の復旧CLI停止も確認し、変更済みfileを上書きせず不足分だけ補完します。完了済みretryは新controller設定を変更しません。`--profiles`でofflineの固定profile一覧を確認できます。

## 移管前点検と遠隔statusのpreview

読み取り専用CLIを追加しました。起動設定・worker/state/lock・GitHubは変更しません。

```sh
npm start -- --registry registry.local.json --controller-state /absolute/private/controller --preflight
npm start -- --registry registry.local.json --controller-state /absolute/private/controller --preflight --github
npm start -- --registry registry.local.json --remote-status
npm start -- --registry registry.local.json --remote-status --github
```

`--preflight`は移管準備の診断です。停止の証明や実行許可には使いません。`--github`付きでは固定gh auth statusだけで認証を確認します。CodexのChatGPT login・CLI互換性、実process停止・自動再起動防止は人の確認事項です。問題ありはexit 2、確認事項が残る通常診断はexit 0で、authorizesDispatchは常にfalseです。

`--remote-status`はCareRecord Issue #73のmarkerとheartbeat timestampを使ったコメント本文previewをJSONで出力します。このpreviewコマンドではGitHubへ投稿しません。固定comment publisherとActions用テンプレートは後述のopt-in経路です。このMacでは2repoの専用IssueとActions sole writerを有効化し、実更新を確認済みです。旧workerに有効なsidecarがなければheartbeatはunknown、quotaがないだけでavailableとは表示しません。詳細は[接続・点検手順](docs/connection.md)。

## 固定コメントpublisherと独立監視

opt-in `--status-publisher /private/status`（registryと--github必須）で管理者が指定した固定コメントだけを更新します。通常launcher/GUIから起動しません。`--status-monitor /private/status`はread-onlyで15分staleを判定します。Actions用の無効テンプレートと独立scriptも用意しました。直接publisherではコメント自体のstale書換を行わず、独立監視のexit statusで通知します。同一コメントのstale自動表示には後述のActions sole writerを選べます。このMacでは後述のActions sole writerで実投稿・cron登録済みです。詳細は[status更新・監視手順](docs/publishing.md)。

## 旧CareRecord producerの移植準備

`--producer-plan --registry registry.local.json`でレビュー済みパッチのsource hashesを読み取り専用照合できます。開発snapshot用と専用clone用の2つのbundleを準備し、一時コピーでそれぞれ101件・103件のworker回帰を確認しました。専用cloneのdeployment抑止・components全体の検証を保持したbundleを、このMacの専用cloneへ適用済みです。適用後の照合はalready-presentで、旧LaunchAgentは停止・自動起動無効化済みです。詳細は[producer移植手順](docs/producer-migration.md)。

GUIの「切替前の確認」は認証済みのread-only `/api/readiness`で、保存状態の診断とproducer bundle照合を表示します。30秒cacheを使い、GUI自身のcontroller lockを識別します。表示から移管やdispatchを許可する経路はありません。

同一コメント上のstale自動表示には `--status-actions /absolute/private/status`を用意しました。Mac側は固定workflowへsanitized observationを送信し、Actionsが更新・監視を同じ直列laneで処理します。逆順eventは観測時刻で拒否します。配布用テンプレートはexampleのまま、このMacの2repoではレビュー済みworkflowを有効化しました。直接publisherとの併用は不可です。詳細は[status更新・監視手順](docs/publishing.md)。

最新の運用・検証結果は[運用手順](docs/live-operation.md)にまとめています。[確認記録](docs/acceptance-review.md)と[停止原因解消記録](docs/resolution-record.md)は準備時点の履歴です。

## スマホ・外出先から使う

MacとスマホでTailscaleに接続し、Macの管理画面の「スマホ用ログインリンク」から開いてください。詳細は [接続手順](docs/mobile-access.md)。

## このMacの管理設定（2026-10-04）

デスクトップの「Local AI Manage.command」、または [Managed-Launch.command](Managed-Launch.command) を開いてください。起動済みserviceへ認証して管理画面を開きます。privateな `registry.live.local.json` を使い、CareRecordとlocal-ai-manageがEnabled / Resumed、全体もResumedで実行候補を待っています。同時実行は全体1件、既定はGPT-6.1 Sol / mediumです。

controllerとstatusはログイン時にLaunchAgentで起動します。旧CareRecord standalone agentは無効化・登録解除済みです。元state、Issue履歴、session/worktreeと移管前backupは保持しています。GUIを閉じてもserviceは継続します。停止する場合はGUIのPause dispatchで新規実行を止め、実行中jobの完了を待ちます。

実workerでCareRecord [Draft PR #75](https://github.com/shougayaki-1/care-record/pull/75)、local-ai-manage [Draft PR #3](https://github.com/shougayaki-1/local-ai-manage/pull/3) を作成しました。業務変更のmergeは人がレビューします。遠隔statusは両repoの専用固定コメントをActionsが更新・監視しています。詳しい操作と検証証跡は [運用手順](docs/live-operation.md) を参照してください。
