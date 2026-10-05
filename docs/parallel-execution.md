# 並列実行と停止原因

registryの `globalConcurrency` は1〜32。実serviceは2、各repositoryの `maximumConcurrency` は1を維持する。同じrepositoryのworker state・Git worktree管理を同時に書き換えない。別repositoryの長いCodex実行・検証中に、空いている実行枠で他repositoryを開始できる。

schedulerは全実行予約をversion 2の `scheduler.json` に保持する。旧version 1は保存済み作業・共有quota・次回時刻を引き継いで読み込む。起動時に未完予約・残存lockがあれば自動で奪取せずblockedになる。保存の単一laneをPause/Disable・承認と共有し、同時完了が他jobの予約やquotaを消さない。

並列adapterは `dispatch-admission.lock` で開始前の共有gate確認と予約だけを直列化する。実行は `dispatch.<repositoryId>.lock/json` の独立laneで行う。他repoのworker lockを許容するのは、同じ稼働schedulerが保持する予約と対応するときだけ。未知のlock・orphan reservation・不明終了は復旧が必要。全体1件へ戻した場合も並列laneのquota/lockを検査する。offline recoveryのfingerprintにも全laneを含める。

共有quotaが判明したら新規開始を全repoで止める。すでに実行中のjobは通常の安全境界まで進む。不明なquota期限はblockedのまま。Pause/Disable・終了は対象jobすべての完了を待つ。GUIは実際の全体上限と全実行jobを表示する。

## 実行待ち

部分取得のキューでも、依存Issueと関連PRを個別に確認できた `ready / eligible` の候補は選択できる。unknown・stale・取得失敗の候補は選ばない。実workerはpriorityを含むfresh queue、Issue、依存、PRを開始直前に再取得する。

保存済みhumanWaitingのIssueは、GitHubのready labelが付いていても確認待ちとして表示する。保存session/worktree/baseを使う承認契約が揃うまで勝手に再実行しない。依存Issueがopenなら後続Issueも待機を維持する。

## ブランチのデプロイ抑止

CareRecordのmanaged parentは、検証前に `vercel.json` へ実行対象codex branchの `git.deploymentEnabled[branch]=false` を追加する。保存baseと同じ設定、またはすでに抑止済みの設定だけを扱い、他branch・headers・cron等の変更は許可しない。missing/malformed/symlink/oversized設定、global enabled boolean、無関係な設定編集は人の確認へ止める。

停止理由が `branch_deployment_not_disabled` のみで、保存結果がcompleted/safe、stageがpublishなら、同じ保存作業を再選択できる。worker側も条件を確認し、fresh Issue/依存/PR・worktree安全性を再検証し、親検証を通してからcommit/push/Draft PRへ進む。Codexを最初からやり直さず、session/base/failure counterを保持する。他のdeploy/production理由、DB/RLS/auth、credential、E2Eの承認要件は維持する。
