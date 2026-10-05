# 停止したIssueの人間承認

既定のmanual方針はIssue #5 の固定承認契約です。管理画面の「確認が必要」に、保留中の作業も含めて `Pending human reason` と `Approval: missing | approved | stale` を表示します。

管理者はGitHubのIssue要件と専用worktreeの差分を別途レビューし、確認したカテゴリの「確認済み範囲を承認」を押します。差分・本文・絶対path・session・raw errorは管理画面へ出しません。承認を保存しても全体／repositoryのPause・Disableは解除しません。managed実行の設定が有効なら、schedulerが同じ保存作業を再選択します。別のcurrentがあるときはそちらを保持し、保留作業の再開はcurrent終了後です。

承認できるカテゴリは `db / auth / permission / tenant / security / retention / manual_e2e` です。その他の停止理由を承認によって解除する操作はありません。たとえばpermissions.tsはdbとpermission、RLS/tenantを含む新規migrationはdb・security・permission・tenantを独立に確認します。既存migration編集、credential、production、deploy、destructive、worktree/sandbox安全性の禁止は維持します。GitHub自由文コメント・ラベル・Codexの自由文・Resume/Enableを承認とは解釈しません。Issue #8 の current manager request への検証済み 👍 だけは、既存 private grant へ変換します。詳細は [GitHub Issue の承認操作](github-human-review.md)。

## 固定操作schema

認証済み `POST /api/approvals` は既存の厳密なOrigin・JSON・session固有CSRF・write rate limitを利用します。任意コマンドやpathは受け付けません。

```json
{
  "requestId": "UUID-v4",
  "expectedRevision": 0,
  "repositoryId": "owner--repository",
  "issue": 57,
  "reason": "auth",
  "e2e": null
}
```

`expectedRevision` は `/api/status` の `approvalRevision` です。dispatch設定のrevisionとは独立です。登録済みmanaged repositoryの保存current、またはhumanWaitingに保持したIssueだけを承認できます。closed、blocked、failed、running、未完了／不明なdependency、profile不一致、active dispatch/worker lockは拒否します。承認時もworker stateを書き換えません。

保存はcontrollerの単一write laneで、private `approvals.json`（0600）に記録します。UUID v4の同じrequestを再送しても操作を追加しません。ID内容の変更・revision競合は409。履歴は最大1024件で、勝手に破棄しません。ackは `recorded / human-approval` であり、実行・検証・PR作成の成功ではありません。`GET /api/requests/:requestId` で保存receiptを再確認できます。保存結果が不明ならcontrollerのwrite/dispatchをblockedにします。停止後の通常restartではschema・registry topology・履歴を検証して復元します。offline recoveryで新controllerへ移る場合は、旧承認を暗黙に継承せず再レビューします。

## 差分とIssueへの束縛

DB/auth/permission/tenant/security/retentionはrepository ID・GitHub repository・Issue・カテゴリ・saved base commit・HEAD・差分のSHA-256・承認時刻へ束縛します。差分digestはbaseからの有効なファイル内容、削除、新規／untrackedのbinary内容、実行属性を含みます。内容そのものは保存しません。

`manual_e2e` はIssue本文のSHA-256と明示的なspec/projectへ束縛します。コメント本文は参照しません。本文が変更されるとstaleです。scopeを確認できない場合も既存承認はapprovedと表示せずstaleにします。

managerは承認を固定IPC descriptorとしてworkerへ渡します。workerはfresh Issue、dependencies、関連PR、保存worktreeの安全性を確認してから、該当するneeds-humanだけを再開します。verify前、E2E前、検証後commit前、publish前にscopeを再検証します。self-repairや検証コマンドによる内容変更もstaleです。親worker自身のcommitだけは、検証済みの内容digestが不変であることを確認したうえで、その起動内のpublish検証へ引き継ぎます。commit後にpublicationが中断してrestartする場合、新しいHEADに対して再承認が必要です。

stale／カテゴリ不足はneeds-humanへ戻り、ラベルを維持／再付与します。複数カテゴリの承認が揃うまでpublicationしません。push／Draft PR作成に限定し、auto mergeやproduction deploymentは許可しません。

## E2Eの承認範囲

`manual_e2e` は `care-record-v1` のみ対応します。管理画面で受け入れ条件に必要なspecを明示選択し、`chromium / mobile-chrome` の必要なprojectを選びます。

```json
{"specs":["auth"],"projects":["chromium","mobile-chrome"]}
```

spec allowlistはauth、workspace-routing、staff-features、tenant-isolation、admin-features、integration-flow、recovery、record-feed、record-routing、record-ui、password-recoveryです。path・glob・CLI flags・shell文字列を入力できません。

固定artifactのlocal runnerが一時Supabase環境を新規作成し、コピーしたmigrationをその環境だけに適用します。既存／production環境を利用しません。GitHub/Codex credentialは渡さず、環境からproductionキーを取り込みません。repositoryのPlaywright configとlocal環境guardは2026-10-04に取得したSHA-256で固定し、dev scriptもexact `next dev --webpack`・pre/post hooksなしを要求します。pinと異なるpolicy変更は承認があっても実行しません。

対象specとprojectの固定args、`--retries=0 --forbid-only --reporter=json` を構築します。検証結果にskip、retry、expected failure、失敗、ゼロ件があれば成功扱いにしません。既存timeoutを増やしません。Issue本文から実行コマンドを抽出しません。E2E承認はDB/RLS/auth等の差分承認を兼ねません。

本実装の検証は合成Issue・一時Git・モックE2E計画・loopback HTTPを使用し、実E2E、production、GitHubの実変更、稼働中workerの再開は行いません。


## ローカル検証の自動化（2026-10-05）

通常の有限repairで検証が通らない場合、local-automaticでは同じsession/worktree/baseを保って別の実装方法を最大2回試す。失敗回数と構造化された履歴を保存し、quota待ちや再起動で上限をリセットしない。Issueの受入条件・安全性・必須検証は維持し、検証を省くための実装変更は許さない。DB起動・migration適用の失敗、実credentialや本番操作のゲートはこの切替対象外。既に保留した作業の承認状態はこの変更だけでは解除しない。

registryのrepositoryに `"reviewPolicy": "local-automatic"` を指定すると、CareRecord profileはDB/auth/permission/tenant/security/retentionのコード差分レビューをDraft PRへ進める。E2E必須Issueも実装前には停止しない。省略またはmanualは従来どおり。Issue本文・ラベルから設定できず、registry fingerprintと固定bridge IPCへ束縛する。manager自身のcontroller/engineの保護は従来どおり。

親はtypecheck/lint/unit/UI/buildと、固定allowlist全E2E specをchromium・mobile-chrome、retry=0で検証する。必要なDB差分は新規project ID・空きportの一時Supabase環境だけにmigrationを適用し、`.test.sql`のpgTAP、存在するisolation spec、public schemaの型生成と `src/types/database.generated.ts` の一致を確認する。既存DB・linked projectは利用しない。固定artifactのSupabase configを使用しseedは無効、実credentialを継承せず、loopback endpointとlocal生成キーだけを使用する。実credentialを含み得るNext.js環境ファイル、変更されたE2E config/環境guard、script hooksは拒否する。

実装agent自身にはDB適用/E2E実行を許可せず、親への構造化委譲を要求する。検証前後・親commit後・publish前の差分digestを照合する。失敗は同じsessionで有限repair後に `automatic_verification_failed` として保存し、同じ保留作業を無限に再選択しない。未実行・skip・retry・型不一致を成功には扱わず、必要な検証が通った時だけpush/Draft PRを作成する。停止したcurrentを保持しても、別の自動検証対象humanWaitingを先に再開できる。

本番操作・実credential・external service・破壊的操作・仕様判断・worktree安全性は自動化対象外。マージは引き続き人が行う。使い捨てstackは通常終了・検証失敗・中断時に、自分のprojectだけを `stop --no-backup` する。片付け失敗時には設定を保持して成功扱いにしない。管理画面は自動対象をApproval: automaticと表示し、人間承認が済んだとは表示しない。

旧workerがunitの合成設定をcredential、公開build asset取得をexternal_serviceと報告した場合は、当該固定scriptをcredential分離環境で実際に成功させた場合だけ、その検証項目の停止理由を解消する。失敗・差分変更・環境ファイル存在・他のcredential/external理由は解除しない。

停止時は新規dispatchを止め、GitHub観測をキャンセルしてからscheduler drainを待つ。自動対象のカテゴリだけで待っている間は、人への確認通知を送らない。実検証の有限repair失敗は通知対象として残る。
承認契約は合成Issue・一時Git・モックE2E計画・loopback HTTPで検証します。productionと稼働中workerは検証に使いません。

## Operational recovery (Issue #7)

`local_verification / sandbox_capability / verification_retry_limit` は承認対象ではありません。承認一覧には表示せず、`automatic_retry_pending`（自動復旧中）または `human_investigation_required` を独立表示します。非承認カテゴリは private grant に変換できません。

manager は saved Issue・base・HEAD・有効な差分digestを照合した固定 recovery descriptor を bounded bridge に渡します。worker は fresh Issue、dependency、関連PR、worktree/branch/profile と binding を再検証し、同じsession/worktreeを保持して parent verification を実施します。Issue の ready 再付与、Resume、queue 再投入は不要です。global/repository の Pause/Disable、quota、未知の実行完了は解除しません。

checks は既存 profile の exact script と hook 契約のみ。Issue本文・コメント・raw error から command/path/flag を生成しません。既定の manual では混在する human categories に #5 の matching grants が引き続き必要です。信頼済み registry の明示的な `reviewPolicy: local-automatic` は care-record-v1 のコードレビューだけを Draft PR のレビューへ延期します。Issue・コメント・ラベル・Codex出力から設定できず、handoff fingerprint と固定 IPC へ束縛します。manager 自身の security guard、specification、production/deploy/credential/external_service/destructive/worktree safety は対象外です。#59 回帰は manual private grants と、全 human categories が automatic で operational recovery だけが残る両方を検証します。

required checks 成功後のみ commit/push/Draft publication に進みます。検証中の差分内容変更も検出します。本当の check failure は既存有限repairへ戻り、失敗回数を保持します。上限到達時は investigation を永続化し、scheduler は同じ失敗作業を無限選択しません。以前の retry-limit state も一度再検証でき、失敗は成功扱いしません。sandbox/network の設定変更、production、credential、destructive、auto merge の許可は追加しません。

回帰検証は合成Git、mock Codex/GitHub、loopback HTTP/IPCで実施します。追加の隔離検証ではCareRecord mainのコードを専用コピーへ取り出し、使い捨てDBのmigration再構築・全DB tests・isolation tests・generated types照合を通過しました。全固定specのPC/mobile E2Eはretry=0で実行し、既存mobile recoveryテストの画面遷移で失敗しました。E2E成功とは扱わず、productionや稼働中workerへの反映は行っていません。

local-automatic は typecheck/lint/unit/UI/build の exact scripts と固定 allowlist の全 E2E spec・PC/mobile（retry=0）、使い捨て Supabase project の DB tests・generated types・isolation tests を親だけで実施します。config は同梱固定artifactで、migration は既存環境へ適用せず一時環境にコピーします。credentials を渡さず、pin/hook/skip/retry/検証失敗は通過させません。検証前後・commit/publish の Issue/diff binding を維持し、DB/E2E を実行できない場合は investigation に残します。既定 manual のgrant schema・stale・category isolation は変更しません。timeout は既存600秒のままです。

Supabase CLIにも専用SUPABASE_HOMEとcredentialを除いた環境を渡します。固定local configは利用中CLIの互換設定だけを使い、OSのephemeral rangeと隣接portを避けます。cleanup失敗時は一時projectのconfigを保持してinvestigationとし、既存projectの停止・削除へ広げません。
