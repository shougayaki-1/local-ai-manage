# Reviewed worker profiles

profileはcontroller側の固定artifactで定義し、専用cloneのscriptやIssue metadataから任意command/policyをロードしません。現在は2種類です。名前の追加だけで他repositoryを実行できるわけではなく、package名、exact checks、保護対象、saved stateのbindingを満たす必要があります。

```sh
node dist/server/cli.js --profiles
```

このcatalog表示はofflineで、registry、GitHub、worker起動を必要としません。

| Profile | package.name | Parent verification |
| --- | --- | --- |
| care-record-v1 | care-record-app | typecheck/lint必須、変更領域・delegated checksに応じてunit/UI/buildなど既存ルール |
| local-ai-manage-v1 | local-ai-manage | 全jobでtypecheck/lint/test/build必須 |

両方ともGPT-6.1 Sol / medium、ChatGPT auth、workspace-write、approval never、Codex network disabled、finite self-repair、saved session/base、Draft-only出版と共有quota gateを維持します。profileはhandoffのrepo idごとに明示指定します。model/effortのIssue metadata overrideは追加していません。

## Local AI Manage policy

exact scripts:

```json
{
  "typecheck": "tsc --noEmit",
  "lint": "eslint . --max-warnings=0",
  "test": "node --experimental-strip-types --test test/*.test.ts && npm run test:engine",
  "test:engine": "node --test engine/care-record/*.test.mjs",
  "build": "tsc -p tsconfig.server.json && vite build"
}
```

親はtestを必ず実行するためengine testsも含みます。test:engineのscriptとpre/post hooksを照合します。build/test/typecheck/lintおよびroot install/prepareのlifecycle hooksは認めません。package/profileは起動前、worktreeのnpm ci前、親verification前に照合します。sandbox capabilityのdelegationはtypecheck/lint/test/build/diff-checkのみです。

UI・local tests等を対象とし、controller/engine/CLI/registry/handoff/recovery/server/credential/status/GitHub queueの実行・安全性境界、Launch.command、registry設定、toolchain設定、.agents/.codex/.githubへの変更は親検証で人の確認に回します。保護pathsの判定はnpm checks/commit/pushより前です。既存のsecret/migration/auth/tenant/retention等の保護も継承します。

新profileのstateにはprofile bindingを保存します。別profileで保存されたstateや、profile未記録の既存current/sessionをlocal-ai-manage-v1で実行しません。その場合、saved state/sessionを変更せずunknown completionとしてcontrollerが止まり、人の確認が必要です。CareRecordの既存stateはcare-record-v1で引き続き扱えます。

handoff例（registry fingerprintとrepo idは実環境に合わせる必要があります）:

```json
{
  "version": 1,
  "registryFingerprint": "<canonical registry fingerprint>",
  "standaloneStopped": true,
  "scope": "all-registered-workers",
  "repositories": [
    {"repositoryId": "owner--care-record", "profile": "care-record-v1"},
    {"repositoryId": "owner--local-ai-manage", "profile": "local-ai-manage-v1"}
  ]
}
```

この例は実運用のhandoff fileを作成・有効化しません。registry enabledとglobal/repo Resume、全standalone workers停止・自動再起動禁止という既存の移管条件は維持します。

## Adding another repository

対象repositoryのcanonical docs、検証scriptとhooks、protected paths、完了条件を調査してから、固定profileの新versionとして実装・レビューします。profile IDのTS/engine allowlist、bridge descriptor、親verification、prompt、saved-state binding、failure/self-repair/再開のテストとprovenanceを一緒に更新します。任意のshell文字列、動的script allowlist、clone内からのworker artifact importは追加しません。

CodexのJSONL、structured output、明示的sandbox設定は[公式non-interactive mode documentation](https://learn.chatgpt.com/docs/non-interactive-mode)で確認しています。既存のSol/mediumとChatGPT authを保持し、API課金へのfallbackは追加していません。

実検証はsynthetic Git repos、mock GitHub/Codex、固定bridgeのpaused状態に限定しています。live worker移管/dispatch、E2E、実PR出版は未実施です。
