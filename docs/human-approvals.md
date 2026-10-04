# 停止したIssueの人間承認

Issue #5 の固定承認契約です。管理画面の「確認が必要」に、保留中の作業も含めて `Pending human reason` と `Approval: missing | approved | stale` を表示します。

管理者はGitHubのIssue要件と専用worktreeの差分を別途レビューし、確認したカテゴリの「確認済み範囲を承認」を押します。差分・本文・絶対path・session・raw errorは管理画面へ出しません。承認を保存しても全体／repositoryのPause・Disableは解除しません。managed実行の設定が有効なら、schedulerが同じ保存作業を再選択します。別のcurrentがあるときはそちらを保持し、保留作業の再開はcurrent終了後です。

承認できるカテゴリは `db / auth / permission / tenant / security / retention / manual_e2e` です。その他の停止理由を承認によって解除する操作はありません。たとえばpermissions.tsはdbとpermission、RLS/tenantを含む新規migrationはdb・security・permission・tenantを独立に確認します。既存migration編集、credential、production、deploy、destructive、worktree/sandbox安全性の禁止は維持します。GitHubコメント・ラベル・Codexの自由文・Resume/Enableを承認とは解釈しません。

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
