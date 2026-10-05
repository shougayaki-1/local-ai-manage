# CareRecord worker artifact

2026-10-03、ユーザー所有CareRecordの `scripts/codex` working-treeから取り込んだ。並行作業の未commit変更を含むsnapshotであり、特定のcommit/releaseからの取得とは扱わない。元ファイルのSHA-256は source-manifest.json に記録。外部OSSのinstall/copyではない。

lib/*.mjsはcodex-runner.mjsのspawn成功通知・profile別prompt、queue.mjsの固定status marker付きIssue除外、および下記の専用clone由来の安全策を除き原文を維持。profile.mjsの読取はFIFOでも停止しないno-follow/non-blockingに対応。telemetry.mjsは固定語彙の表示用sidecarを生成する新規artifact。continuous-workerにはlock取得後の任意telemetry lifecycleを追加し、bridgeだけで有効化。continuous-worker.mjsの変更は expectedIssue付きonce契約、fresh依存/PR再検証、保存needs-human/failedの保護、schema resume不可時のsession保全、standalone CLI入口の削除、固定profileごとの親検証、saved stateのprofile binding。旧動作のtestsはそのまま維持し、bounded契約testsを末尾に追加。bridge.mjs、dispatch-contract.mjs、profile.mjs、profile.test.mjsは新規。

現profileはCareRecordのexact checks、protected paths、sandbox/credential分離、self-repairとDraft-only出版を再利用する。local-ai-manage-v1も固定policyとして追加し、全test/buildとcontroller/engine保護を必須にする。profiles.mjsは新規。任意repoへの無条件適用は宣言しない。将来のsource変更は自動同期せず、安全差分・provenance・全testsを確認して更新する。GUIから変更・任意profile追加する経路はない。

2026-10-04、登録済み専用worker cloneとの差異レビューでpublication.mjsのdeploymentDisabled/branchSuppressionOnlyとcomponents全体の検証範囲を取り込んだ。publication.mjsにno-follow/non-blocking・64KiB上限の設定readerを追加。continuous-workerはCareRecordの検証前・検証後commit前・push直前にdeployment抑止を確認し、失敗を固定reasonでneeds-humanへ保存する。vercel.jsonの変更は当該branchの抑止追加だけを許可し、それ以外は拒否する。manager profileのvercel.json変更も拒否する。元snapshotのsource-manifest.jsonは取得時の証跡として保持し、この変更を元原文とは扱わない。独立publication.test.mjsで7件の境界・退行を検証する。

2026-10-04、managed bounded dispatchに限定して `continueAfterHuman` を有効化。確認待ちのcurrent全体（session/base/worktree/result/retryを含む）をstate.jsonのhumanWaitingへ保持し、独立した候補だけをfresh依存/PR観測で再検証して開始する。旧standaloneと通常resumeの停止動作は維持。手動pause、quota、failed、unknown stage、保留Issueそのものは自動解除しない。humanWaitingは再起動時に検証し、ラベルが外れても自動選択しない。GUIと通知には固定語彙の安全な投影だけを渡す。

2026-10-04、Issue #5の固定人間承認契約を追加。lib/human-approval.mjs、lib/approved-e2e.mjsとmanager所有private履歴で、repository/Issue/category/base/HEAD/content digest（manual_e2eはIssue本文digest）を束縛する。workerはguardを保持し、対応する明示承認がある場合だけ通過し、verify/E2E/commit/publish境界で再検証する。

e2e/run-local.mjsとe2e/local-environment.mjsはユーザー所有CareRecordのscripts/e2e working-tree snapshot（2026-10-04）から取得。run-localはrepository rootをmanager固定argsから受け、enum spec/project・retry 0・skip/expected failure拒否・raw output省略へ適応したtrusted artifact。playwright.config.ts.referenceは同snapshotの検証fixtureで、SHA-256は0cfed6fa2a38ed34dc427f470ce8d5efb0782995ed31826ac871c3220e30fb64、local-environment.mjsはa44b17e1cd2ec92ef6b68f1b1a449d1833e03e4feb6d9ad179c8d682a52a66cd。実行時はこのconfig/guardのpinとexact dev scriptを確認し、未レビューのconfig変更は承認でも許可しない。source-manifest.jsonの元worker取得記録は変更しない。

2026-10-05、Issue #7: human grants を維持し、固定 binding の operational recovery descriptor と parent 検証を追加。verification failure の finite repair と永続 investigation、checks の exact profile、sandbox/credential 分離は維持。元source-manifestを改変せず、現artifactの合成回帰で検証。

2026-10-05、Issue #8: manager が生成・保存した current review request の stable actor ID、Issue/diff binding を検証し、#5 private grants へ変換。新しい strict IPC は request Issue/diff binding と仕様本文更新後の一回限り再評価のみで、generic specification grant は追加しない。controller lock/revision、finite checks/repair、production/credential/sandbox/publication guards を維持。新 manager module github-review.ts も protected path に追加。
