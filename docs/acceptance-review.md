# 実装と実運用の確認記録

更新: buildはworkerの正規CI合成環境で成功し、#55のGoogle-first問題もworktreeで修正・検証した。最新の結果は [停止原因解消記録](resolution-record.md) を参照。以下の過去の失敗記録は環境未指定の単独buildについてのもの。

更新: ユーザー承認後にこのMacの停止・再起動防止、専用producer適用、Pause状態の管理設定を実施した。以下には準備時点の記録も含む。現在の運用状態とbuild制約は [運用移管記録](operation-record.md) を正本とする。

2026-10-04。対象はlocal-ai-manage。CareRecordの開発source、専用clone、既存state、LaunchAgent、GitHub queue/comment/workflowを変更せずに検証した。

## 実装済みの範囲

| 要件 | 実装と検証 |
| --- | --- |
| 複数repo、既存worker再利用 | registry、固定CareRecord/manager profiles、trusted bridge、global 1のscheduler。canonical origin/state identityとdurable予約を再検証 |
| Queue/priority/dependencies | bounded read-only GitHub adapter、repo round-robin、priority/番号順、依存・既存PRのfresh再検証 |
| State/session/quotaの保全 | resetを行わず、保存base/session/retry/needs-human/profileを保持。不明なjobはreservation/lockを残して停止 |
| ローカルGUI | Vite/React、loopback HTTP、localhost nonce/cookie/Origin/CSRF/CSP、Issue/Draft link、queue/履歴/sanitized events |
| Pause/Resume/Enable/Disable | revision/idempotent durable controls、drain receipt。人の対応やquotaを解除しない |
| CLIに不慣れな利用者 | macOS Launch.commandでobserve-only GUIを表示。実行・移管・任意shellの起動経路を分離 |
| Heartbeat/model実測 | producer sidecar、OS spawn成功によるmodel/effort、15秒heartbeat。旧workerにproducerがなければ未取得 |
| 旧producerへの移植準備 | 開発版・専用clone版の2つのhash-bound bundle。専用cloneのplanはdedicated/ready-for-review |
| 既存安全設計 | credential/sandbox/parent checks/Draft-only/E2E禁止を保持。専用clone由来のdeployment抑止と広いcomponents検証を取り込み |
| 復旧 | offline plan/attestation、journal replay、置換controller paused、既存証跡保全。不明quotaを解除しない |
| 切替前GUI診断 | 認証済みread-only readiness、30秒cache、固定producer catalogueとpreflightを表示。dispatch認可を返さない |
| 遠隔Status | 共通sanitized snapshot/formatter、固定comment直接publisher、独立read-only monitor |
| 同一commentのstale表示 | opt-in Actions dispatchと未有効化sole-writer template。同じconcurrency lane、観測時刻による逆順拒否、実行時のstale再計算 |

GUIからのlocal diff閲覧、Tauri、LAN/スマホ公開、repo並列実行、Issueごとのmodel override、任意repoの自動profile生成は将来範囲として残す。GitHubリンクからDraft PR/diffは閲覧できる。

## 実際に行った検証

- `npm test`: app 88件、固定engine 115件、失敗/skip 0。内側のproducer regressionは開発版101件・専用clone版103件を実行して件数まで検証。
- `npm run typecheck`: 成功。
- `npm run lint -- --max-warnings=0`: 成功。
- `npm run build`: 成功。
- 合成demo GUI: readinessの表示と確認項目展開をブラウザで確認。demo serverは終了済み。
- 登録済みcloneへのread-only producer照合: ready-for-review。稼働processがどのsourceをロードしているかの証明には使わない。
- 実Codex dispatch、E2E、実PR投稿、実status投稿、workflow schedule登録、live移管は未実施。

## 実運用への切替前に必要な手順

1. `docs/producer-migration.md`の専用bundleをレビューし、採用source/releaseを決める。Git repositoryはまだ初期commit前で、稼働用releaseとして公開していない。
2. 稼働standalone/controller/worker/Codex子processを確認し、安全な停止境界と自動再起動防止を管理者が確認する。lockやheartbeat不在から停止を推測しない。
3. 最新sourceでproducer planとpatch checkを再実行し、承認済みcloneへ適用する。対象CareRecord側の検証条件を満たす。state/session/retry/quotaは維持する。
4. `README.md`/`docs/recovery.md`に従ってprivate controllerとregistry-bound handoffを準備する。最初は全体/repo pausedに保つ。不明なjobはoffline reviewに戻す。
5. Status Issue/commentの固定IDとmarker、codex:* label不在を確認する。直接publisherかActions sole writerの一方を選ぶ。Actionsを採用する場合は全ての旧comment writerを停止してからreview済みscript/templateをdefault branchへ配置する。
6. 限定trialで1 repo・1 Issue・global 1を確認し、その後repoを追加する。auto merge、E2E、deploy/production操作は許可しない。

最初の依頼で稼働worker停止・LaunchAgent/current state/GitHub queue変更が禁止されたため、これらの実操作を自動実行していない。実装の検証成功をlive移管完了とは扱わない。
