# Build / Issue #55の停止原因解消

2026-10-04 Asia/Tokyo。

## Buildの確認

前回の素の `npm run build` はSupabase初期化値がないため失敗した。workerの親検証は既に `command(..., {testMode:true})` を使い、GitHub CIと同じAPP_ENV=test・loopback URL・公開された合成keyを渡す。今回この正規経路で専用cloneと#55 worktreeのbuildを確認し、どちらも成功した。本番環境の欠落を補ったのではなく、credential-freeなローカルCI検証として実施した。生成された .next は検証用で、配備に使わない。

本番credential/ .envのコピーやアプリの環境変数validation変更は行っていない。過去のGoogle fonts取得失敗も今回のbuildでは再発していない。

## #55の仕様と変更

指定Issueをread-onlyで確認した。「DB mutation失敗時に成功前提のGoogle同期へ進まない」という受入条件が単体削除にも適用される。Google-firstを維持していた旧差分はこの条件を満たさないため修正した。

- `soft_delete_shifts_atomic`のROW_COUNT=1を確認して論理削除を成立させる。0/null/予期しない件数/DB errorでは監査・Googleへ進まない。
- Google同期状態をpending_deleteで保存し、実DB削除の監査後に既存Google削除helperを呼ぶ。
- Googleだけ失敗した場合は既存mark RPCでfailedを記録し、レスポンスをgoogleSync=pendingにする。UIは削除済み・同期未完了の警告と再取得を行う。
- `get_google_sync_target`/`mark_shift_google_sync`は既存のJWT/session/org/権限チェック付きRPCで、論理削除後のrowも対象にできることを照合。service role利用を増やさない。RLS/permissions/migrationは変更なし。
- Google全体の同期方式や他のbatch経路は変更しない。
- 現在Issue branchだけのVercel deployment抑止を追加。branchSuppressionOnly/readSuppressedDeploymentで他設定の保全を確認。

元worktreeの未commit差分はprivate backupへ保存し、session/base/retry/quota/stateを変更していない。

## 検証

修正後worktreeのunit 516件（76ファイル）成功、typecheck/lint成功、CI合成環境でbuild成功、git diff --check成功。DB本体/RLS/E2Eや実Google接続は実行していない。既存RPCを使ったmock境界テストと実コードのscope照合として扱う。

Codex CLIは0.160.0、workerと同じCodex専用envでlogin statusがChatGPT認証、exec/resumeのhelpに必要なschema/json/sandbox機能を確認。保存credentialの存在確認であり、実model呼出・session resume成功の証明ではない。Sol/mediumを維持し、API key authへ切り替えていない。

## ローカルGit保存

local-ai-manageを`codex/initial-controller`へ保存した。初期実装は33c20c3、patch contextの属性とengine EOFの整備は18ba9d7。履歴全体のdiff whitespace検査と、整備後のtypecheck/lintが成功。private registry/state、credential、検証ログは追跡対象外。GitHubへのpushやPR作成は未実施。

## 次の実運用段階

#55の差分レビュー・Draft PRと実worker trialが残る。保存needs-human/currentを単にresetして次Issueへ移らない。controllerは全体/repo Pauseのまま。実投稿、queue label変更、PR merge、deployは行っていない。

一次資料（2026-10-04）: Context7でNext.js 16のbuild-time環境変数とSupabase JSのupdate/select/maybeSingle zero-row behaviorを確認。OpenAI Docsスキルで [CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli) と [Authentication](https://learn.chatgpt.com/docs/auth) を確認した。
