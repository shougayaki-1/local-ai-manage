# 実装範囲と次のIssue

2026-10-03。CareRecordの `docs/codex-worker-multi-repo.md` を元に、独立repositoryで最初の観測基盤を実装した。workerの置換やlive migrationは行わない。

## 今回

- strict registry（32 repoまで、origin/realpath/common Git dir/重複scope検査）
- state v1→共通snapshot projector、CLI status
- private JSONのbounded/no-follow読取とstate byte保全
- 認証付きloopback read API、static React dashboard、demo
- synthetic fixtureによる秘密情報不含有、wrong repo/schema、origin/CSRF/Host、認証期限/replay、read-onlyのテスト

元設計D1のconsumer-side projectionとD4のobserver版を先行実装した。旧workerにproducer heartbeat/effective modelがないためunknown表示。worker producer側D1、D2/D3、D5/D6は未完了。初期releaseはGitHub接続なし。第二段階ではtrusted gh subprocessだけに既存GitHub capabilityを渡し、HTTP APIがtoken値やworker実行権限を公開する経路は持たない。

## 次の小さなIssue

1. **Producer snapshot contract**: CareRecord worker側にallowlist sidecar/heartbeat/observed modelを追加。現state/CLI互換と#73 remote契約を確認。秘密canary/restart/unknown-fieldテスト。worker自体の変更はCareRecordで別PR。
2. **Trusted profile + dispatch contract**: CareRecord exact checks/protected pathsをprofile化し、expectedIssueの再検証、current復元、quota-safe returnを追加。sandbox/env/parent verificationとDraft-onlyを維持。既存worker tests全件を通す。1に依存。
3. **Single-slot controller**: registryを利用したround-robin、reservation/global lock、orphan reconciliation、shared-account quota gate。standalone worker存在が不明ならdispatch禁止。crash/lock/PID/current復元をfixtureで検証。2に依存。
4. **Queue / producer status UI**: reviewed GitHub read adapterをcontroller側に設置し、priority/依存/固定除外理由をsnapshotへ投影。heartbeatとeffective defaultsも接続。Issue本文/任意GH proxyを提供しない。1/3に依存。
5. **Typed controls**: pause/resume/enable/disableのdurable request/ack/revision、CSRF、drain。needs-human/quotaをResumeで解除しない。HTTP handlerからstate/labelを書かない。3/4に依存。
6. **macOS launcher + handoff**: fixed artifact、既存state path維持、自然なsafe boundaryで旧writer→controller移管。停止/LaunchAgent変更は別途明示された作業で実施。rollbackは最新stateを使い、resetしない。5に依存。Tauri/remote/並列はさらに別Issue。

Issueは未登録。順序はproducer contract→dispatch→controller→queue UI→controls→handoff。observe-only GUIはこの順序を待たず利用できる。

## 文書確認

Context7: 2026-10-03、Node.js 24 HTTP/listen/Host validation、Vite公式static build、React公式createRoot/useEffect cleanupを確認した。production運用はVite previewではなくNode static server。

- https://nodejs.org/docs/latest-v24.x/api/http.html
- https://nodejs.org/docs/latest-v24.x/api/net.html
- https://vite.dev/guide/static-deploy.html
- https://react.dev/reference/react-dom/client/createRoot
- https://react.dev/reference/react/useEffect


## 第二段階: read-only GitHub queue

local-ai-manageだけで完結する観測機能として、元の4のqueue read/UI部分を先行実装。これはproducer/dispatch/controllerへの依存を解除して実行機能を先行させるものではない。CareRecordコード/state/LaunchAgentを変更しない。

- `--github`で明示的に接続。Mac launcherはこのflagを使用。省略すればnetworkなしのstate観測を維持。
- trusted ghによる固定GET、既存keyring認証、credential env allowlist、raw errorsを固定理由へ変換。
- queue metadata/priority/依存と既存除外label/関連PRの観測。本文/タイトル/branchをpublic snapshotへ渡さない。
- 最大24 requests/repo観測、30秒ごと1repo round-robin、全体25秒、単発10秒。先頭100件の未完paginationはpartial。
- 一部repo未取得、初回API失敗、last-good後の失敗、stale、依存/関連PR未確認を明示。未確認candidateはReadyにしない。
- 取得はHTTP request handlerで任意endpointを受けず、独立observerがcacheを更新する。worker dispatchのsingle-slotとは別のread lane。

producer status contractとtrusted dispatch adapterは引き続き未実装。CareRecord側の変更は別PR/安全な更新境界で扱う。2/3/6および5のworker接続・drainは未実装。queueの観測結果だけで実装開始やneeds-human解除を行わない。

Context7追加確認（2026-10-03）: GitHub CLI公式gh apiのexplicit GET/hostname/credential store、Node 24 execFileのtimeout/maxBuffer/AbortSignal。外部OSS・追加framework・新規依存は導入しない。

追加一次資料: [GitHub timeline API](https://docs.github.com/en/rest/issues/timeline)、[GitHub Issues API](https://docs.github.com/en/rest/issues/issues)。Issue一覧にPRも含まれる点とtimelineのper_page上限100を確認。


## 第三段階: durable controller preferences / typed controls

local-ai-manage内で独立して扱えるcontroller設定とGUI操作を実装した。実行schedulerやworker移管は含めない。D5のrequest/ackのうちdispatch intentの保存部分であり、worker適用ackやdrainを完了扱いにしない。

- 全体pause/resume、登録repo pause/resume/enable/disable。初回全体/repo paused。
- strict schema、UUID request id、idempotent replay、expectedRevision、serialized atomic persist、restart validation。
- controller専用0700 directory / 0600 state+exclusive lock。既存clone/stateとの重複禁止。stale lockの自動回収なし。
- 確認できない保存失敗後はwrite停止。履歴上限1024で拒否。記録をpruneして再実行を許すことはしない。
- session/Origin/JSON/CSRF/操作rate limit。HTTPはcontroller設定のみを変更し、legacy state/labelを変更しない。
- GUIは設定保存のackとworker statusを区別。応答不明の再確認は同じrequest ID。
- 19 fixture tests成功。ブラウザーでResume→Pause→reloadのrevision維持、Enable→Disableの保存を確認。needs-human/quotaは維持。

次の実行接続に必要な作業: trusted CareRecord profile artifact、expectedIssueのfresh再検証、global single-slot reservation、orphan reconciliation、shared quota gate、active jobのdrainと適用ack。ownershipは依然observe-onlyを強制し、操作が保存されても起動しない。

Context7追加確認（2026-10-03）: Node24 fs exclusive open / FileHandle.sync / renameによる永続化。追加依存なし。


## 第四段階: trusted worker adapter / bounded dispatch

元のD2/D3の前提になる内部adapterを実装。CareRecord working-treeのworker engineと既存testsを固定artifactとして取り込み、clone内のmutable worker codeへの依存を排除。既存CareRecordファイルには変更を加えない。

bounded `expectedIssue`、fresh dependency/PR再検証、saved current/quota/session/retry維持、明示的all-registered-workers handoff、registry enabled gate、private global reservation/lock、sanitized IPC terminal outcomeを追加。現在はSol / mediumのCareRecord profileのみ。HTTP/launcher/CLIからの実行経路はなし。

引き続き未実装: round-robin scheduler、controller preferencesとの実行接続、drain/worker適用ack、heartbeat/effective modelのproducer snapshot、logs UI、handoff/reconciliation運用。手動attestationは終了・再起動禁止を自動確認する機能ではない。運用移管も未実施。

検証: app/adapter 25件、engine 100件、typecheck、lint、build。fixed bridge自体もfake Git+合成paused stateでIPC/closeを確認。live GitHub/Codex/worker/state/LaunchAgentは操作しない。

Context7 Node24 child_process fork / explicit env / execArgv / IPC / close、およびOpenAI Docsの非対話実行公式資料を確認。新しい依存は追加しない。


## 第五段階: single-slot scheduler / GUI application receipt

schedulerをtrusted adapterへ接続。default observe-onlyは維持し、`--execute`+GitHub+private handoffで明示的にmanaged modeを選べる。通常launcher/local registryは変更しない。CareRecordの運用移管は未実施。

- registry全体にbindするhandoff schema、private file/no-follow、exact profileとenabled gate。
- round-robin cursor、repo内priority/Issue順、saved current復元優先、observed queueのみ。
- reservation/cooldown/shared quotaのdurable state、global concurrency=1、unknown/orphanのfail-closed。
- controller laneによるPause/Disableと予約の直列化。実行はlane外。draining/application/superseded receipt、authenticated HTTP/UI接続。
- Ctrl+C/SIGTERMは新規dispatch停止→job完了待ち→dashboard/controller終了。bridgeを別process groupへ分離しTerminal signal伝播を防止。
- 34 app/adapter/scheduler tests + 100 engine tests。typecheck/lint/build、fake dispatch GUIでdraining→applied確認。live workerは未接続。

現時点の残り: producer status/heartbeat/effective model、sanitized logs、handoff/reconciliation運用、他repo用profile。D3 schedulerとD5 control gate/drainは実装済みだが、運用移管を完了したとは扱わない。Context7でNode24 timer cancellation/persistenceを確認。

## 第六段階: producer telemetry / sanitized events（2026-10-03）

local-ai-manage側の固定CareRecord artifactに任意telemetry lifecycleを追加し、trusted bridgeだけで有効化。live CareRecordのsource/state/LaunchAgentは変更していない。

- lock取得後に専用0600 sidecarを生成。15秒heartbeat、60秒でstale、通常終了でstopped。worker state schemaとbounded terminal契約は維持。
- 固定Codex CLIのOS spawn成功通知をmodel/effortの根拠とし、configured defaultを実測と混同しない。backend modelの解決確認ではない。
- stateとのIssue/stage/status一致、strict allowlist、未来timestamp/unknown fields/oversize/symlinkの拒否。本文/session/rawログ/パスはHTTPにもGUIにも渡さない。
- 直近起動内の固定イベント最大100件、authenticated GET /api/logs、GUIのrepo絞り込みに接続。情報欠落と空ログを区別。
- telemetryはdiagnosticのみ。生存や孤児終了の証明にせず、scheduler gate/復旧判断には使用しない。保存失敗はjob挙動を変えず未取得/staleへ。
- 38 app tests + 103 engine tests、typecheck/lint/build。合成GUIでCLI invocation/stopped heartbeat/events/絞り込みを確認。live dispatchとE2Eは未実行。

残りはhandoff/orphan reconciliationの運用と他repo用reviewed profile。既存CareRecord workerへのtelemetry移植と#73 remote status契約は別作業として残る。

## 第七段階: offline controller ownership recovery（2026-10-03）

- 読み取り専用planと対象fingerprintに結び付いた0600の管理者停止確認file、offline専用CLI。PID/heartbeatから終了を推測しない。
- 元のlocks/journals/control receiptsと全worker stateをbyte単位で保持。旧controllerをretireし、新private directoryをglobal/repo paused、revision=0で作成する。
- source/target/親directoryの復旧gateで途中の通常起動を拒否。中断状態の自動rollback、marker削除、target再利用はしない。
- scheduler/dispatchに残ったquota期限も引き継ぎ、未知quotaはblocked維持。worker lock残存と壊れたquota証跡では切替を拒否。
- 47 app tests + 103 engine tests、typecheck/lint/build。CLIはsynthetic Git repoで確認。live worker/移管/復旧/E2Eは未実行。

残り: 実運用移管、復旧途中のjournal replay、worker lockが残る場合の独立した確認手順、旧CareRecord producer移植/#73 remote契約、他repo用reviewed profile。詳細はdocs/recovery.md。

## 第八・九段階: interrupted recovery replay / reviewed second profile（2026-10-03）

- version 2 durable recovery journal、read-only resume plan、新たな全process/復旧CLI停止確認にbindしたexclusive attempt claim。既存filesの期待値照合と不足filesだけの作成、gateを維持した再開。source/worker dataの保全、quota floor継承、完了済みretryのread-only receipt。
- local-ai-manage-v1をTS/engine allowlist、handoff、scheduler、trusted bridge、parent verification、Codex promptへ接続。typecheck/lint/test/build必須、root/hooks exact照合、controller/engine/security paths保護、別profile sessionの実行拒否。offline --profiles catalog。
- 57 app tests + 108 engine tests、typecheck/lint/build。各中断境界、同時再開、fingerprint変更拒否、CLI再開、2回のquota継承、実Git worktreeの親検証とmock Draft出版を確認。live worker/移管/E2E/実PR出版は未実施。

残り: 実運用移管、journalのない旧形式中断の確認、worker lock残存の独立した確認、旧CareRecord producer移植/#73 remote契約、追加repoの個別調査とreviewed profile。任意shell/policy実行や自動移管は追加しない。詳細はdocs/recovery.mdとdocs/profiles.md。

## 第十段階: read-only migration preflight / #73 body preview（2026-10-03）

- #73をGitHubからread-only取得し、固定marker・machine-readable heartbeat・15分stale・最大5件のqueue表示・PHI非公開の契約を確認。共通projectorの結果からpreview本文を作成し、古いworkerはheartbeat unknownを維持。通常local heartbeatの60秒staleとremoteの15分閾値を区別する。transportは実装していない。
- offline --preflight: registry/profile/scripts/private directory/handoff/locks/recovery/quotaを診断。任意process操作・state更新・停止推測はせず、既存controller journalは管理者reviewを要求。--githubの場合だけ既存gh/keyring認証を固定read-only commandで確認。Codex認証/停止/再起動防止はmanual。
- status marker付きIssueをconsumerと固定workerの新規queue選択で除外。診断のfile readerはFIFO/symlink拒否。新privacy/点検filesもmanager profileの保護対象。
- 追加7 testsでsecret不含有・全state bytes保全・危険flags拒否・status marker除外・合成Git CLIを確認。64 app tests + 108 engine tests、typecheck/lint/buildが成功。

残り: 旧CareRecord producerの移植、#73固定commentへのpublisherと別実行主体stale監視、Codex認証/CLI互換性の実運用確認、実process停止・再起動防止とlive移管、限定trial。preflight成功は移管/実行成功の宣言ではない。

## 第十一段階: fixed comment publisher / independent read-only monitor（2026-10-04）

- strict private registry-bound fixed Issue/comment targets、専用exclusive publisher lock、opt-in CLI、fixed GET/PATCHとbody stdin、credential separation。自動Issue/comment作成なし。
- 30秒観測でstate変化、5分heartbeat、restart時remote更新時刻照合、失敗backoff、remote新heartbeat/コメント変更の保全。worker/state/quota/retry/dispatchと分離。
- read-only monitor CLI、同じclassifierを使うdependency-free script、issues:readの無効Actions template。15分stale/future/unknown/正常終了を区別。stale comment上書きraceは監視をread-onlyにすることで回避。
- 実投稿/cron登録/live移管は行っていない。publisherは単一host/writerの運用を要求し、別hostの分散排他を保証しない。同一commentのstale自動書換と旧producer移植は残る。詳細はpublishing.md。

## 第十二段階: standalone producer review bundle（2026-10-04）

- CareRecord開発working-treeに対する5-file最小patch、14-file before/after hashes、再現用baseline、opt-in --telemetry。state/CLI/credential/verificationを維持し、保存済みstatus Issueも保護。
- --producer-plan:strict bundle integrity/source照合、drift/symlink/partial拒否。source/state/locks/GitHubに書かない。registered dedicated cloneとの照合はblockedで、実適用しない。
- synthetic Gitへのpatch適用とafter hashes、実行中fake Codex heartbeatを含む101件のpatched-worker回帰。3件のbundle/CLI検証を含む78 app + 108 engine tests、typecheck/lint/buildが成功。内側のpatched-worker 101件も実際に実行・成功を確認した。
- 残り:専用cloneとapproved開発sourceの差異レビュー・release準備、live停止/自動再起動防止、publisher対象準備と運用有効化、限定trial。手順はproducer-migration.md。

## 第十三段階: 専用cloneの安全策保持とGUI移管診断（2026-10-04）

- 差異レビューで専用cloneのVercel deployment抑止とcomponents全体のunit/UI検証を発見。固定engineに保持し、検証前・commit前・push前で再確認。抑止解除をチェック実行中に混入するケースも拒否。
- 専用cloneに一致するproducer bundleを追加。publication/verificationのbyte保全と103件の回帰を検証。既存開発bundleは101件。実cloneのread-only planはdedicated / ready-for-review。
- GUIに切替前の確認を追加。固定認証GET、30秒cache、対象repo filter、producer状態と診断項目を表示。合成データで表示・展開を確認。
- 稼働source/state/LaunchAgentとGitHubは変更していない。残りは同一status commentのstale更新を競合なく実現する経路、運用の停止・再起動禁止確認、release採用とlive移管・限定trial。実装準備と実運用完了を区別する。

## 第十四段階: Status commentのActions sole writer（2026-10-04）

- 固定workflowへのopt-in dispatch、canonical本文grammar・repo/Issue/comment binding・timestamp検証、標準GITHUB_TOKENによる同一comment更新とschedule stale判定。
- 同じconcurrency lane・既存writer停止を前提に、古い観測とnewer remote heartbeatを拒否。遅延payloadもstale再描画。pending run置換とActions遅延の制約を明記。
- 合成transport/fake ghで6件の境界・逆順・credential分離を検証。workflowテンプレートは未有効化で実投稿なし。
- 残りは運用release採用、既存writer/process停止と再起動防止、workflow/固定target有効化、live移管と限定trial。
