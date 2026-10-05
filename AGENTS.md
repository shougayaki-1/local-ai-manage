# Local AI Manage

コーディングを始める前に、Context7（MCPサーバ）を使って対象ライブラリの最新ドキュメントを取得してください。

仕様は README.md、docs/profiles.md、docs/human-approvals.md、docs/github-human-review.md、docs/parallel-execution.md を参照してください。運用状態は docs/live-operation.md と実際の保存状態を照合してください。

変更後は typecheck、lint、関連テスト、build、git diff --check を実行してください。承認の差分束縛・カテゴリ分離、保存session/worktree、有限repair、quota、Pause/Disable、実行予約の保護を維持してください。
