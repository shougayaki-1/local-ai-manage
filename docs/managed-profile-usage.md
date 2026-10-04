# Reviewed managed worker profileの利用

このrepositoryにはレビュー済み固定profile `local-ai-manage-v1` を使用します。対象の `package.name` は `local-ai-manage` です。profileの正本は[profile一覧](profiles.md)、[controllerの固定catalogue](../src/profiles.ts)、[engineの固定policy](../engine/care-record/profiles.mjs)です。Issue本文やclone内のscriptから任意command・policyを追加することはできません。

## 実行条件

- global concurrencyは **1**。repository間も同時実行せず、schedulerが1件ずつ扱います。
- modelは **`gpt-6.1-sol`**、effortは **`medium`** に固定します。Issue metadataによるoverrideはありません。
- ChatGPT auth、`workspace-write`、approval `never`、Codex network disabledを維持します。API課金へのfallbackやsandbox迂回は行いません。
- **1 Issue = 1責任**として専用worktreeで作業し、saved base・HEAD・session・profile bindingを保持します。reset・rebase・mergeで保存baseを変更せず、別profileのsessionを流用しません。

catalogueの表示だけなら、build済みartifactで次のoffline commandを利用できます。registry、GitHub接続、worker起動は不要です。

```sh
node dist/server/cli.js --profiles
```

## ローカル検証と親workerの確認

親workerは文書のみの変更を含む全jobで `typecheck`、`lint`、`test`、`build` を必ず実行します。実行できるのは次のexact scriptsだけで、`test` 内の `test:engine` も照合対象です。

```json
{
  "typecheck": "tsc --noEmit",
  "lint": "eslint . --max-warnings=0",
  "test": "node --experimental-strip-types --test test/*.test.ts && npm run test:engine",
  "test:engine": "node --test engine/care-record/*.test.mjs",
  "build": "tsc -p tsconfig.server.json && vite build"
}
```

package/profileとscriptは起動前、worktreeの `npm ci` 前、親verification前に確認します。各checkと `test:engine` のpre/post hooks、およびroot install/prepare系lifecycle hooksは認めません。任意shellや依存更新を検証の代替にしません。

```sh
npm --ignore-scripts run typecheck
npm --ignore-scripts run lint
npm --ignore-scripts run test
npm --ignore-scripts run build
git diff --check
```

検証は一時directory、合成state、mock GitHub/Codex、local Git、loopback HTTPに限定します。安全なローカルcheckがsandbox capability（例: loopback listenのEPERM）で実行できない場合だけ、`typecheck` / `lint` / `test` / `build` / `diff-check` を親workerへ委譲できます。結果には未実行checkと制約を記し、`reasons` に `{"category":"sandbox_capability","check":"test"}` のように該当checkを指定します。assertion・型・lint・buildの実際の失敗はsandbox制約に分類せず、Issue内で修正し、解消できなければ `local_verification` として報告します。

`completed` / `safe_to_open_pr=true` は親による独立検証を依頼する結果です。親は委譲checkを含む必要checkを再実行し、すべて成功するまでcommit・push・PR作成へ進みません。

## 人の確認が必要な変更と除外範囲

controller・engine・credential・security policyの変更は `needs_human` です。CLI、scheduler、registry、handoff、recovery、server、GitHub queue/status、launcher、toolchain、`.agents` / `.codex` / `.github` などの保護対象も固定policyに従い、人の確認へ回します。profileの説明を追加する作業はこれらの変更を許可しません。

DB/RLS/migration、auth/permission/tenant、security/retention仕様判断、専用環境・認証・外部serviceが必要な作業、破壊的操作、明示的なmanual E2E/仕様判断は対応するhuman reasonで停止します。sandbox capabilityとして委譲しません。秘密情報、`.env`、credential、PHI、本番個人データを読み取り・出力・commit・log保存しません。RLS、権限、監査、retention、record historyを弱めず、既存migrationを編集・適用しません。

出版は **Draft PR限定**です。production serviceの利用、deploy、無人E2E、auto mergeは対象外です。実装workerの完了報告自体はcommit・push・PR作成の許可ではありません。

## 既存launcherと運用記録

[Managed-Launch.command](../Managed-Launch.command)は既存managed controllerのGUI入口です。保存済みResume設定は再起動にも引き継がれるため、起動後は全体/repositoryの状態を確認します。通常の[Launch.command](../Launch.command)はobserve-onlyです。launcherを開いたことやGUIのResumeだけでは、saved needs-human・paused・quota・不明な実行結果を解除しません。

managed実行にはcanonical registry、profileを明示したprivate handoff、登録全standalone workerと子processの停止・自動再起動禁止の管理者確認、全体/repositoryの実行設定が必要です。詳細は[READMEのmanaged scheduler](../README.md#managed-scheduler運用移管後のみ)と[移管前点検](connection.md)を参照してください。lockやheartbeatの不在を停止証明には使いません。

このMacの操作履歴は[運用移管記録](operation-record.md)、実装と実運用の区別は[確認記録](acceptance-review.md)、buildと残作業の更新は[停止原因解消記録](resolution-record.md)を参照します。保存state/session/baseやquotaをresetして次Issueへ進めず、復旧が必要なら[既存のoffline復旧手順](recovery.md)に従って人の確認へ戻します。この文書の追加はregistry/stateの変更、live dispatch、運用移管や実PR出版の成功を宣言しません。
