# GitHub Issue で確認・承認・再評価する (Issue #8)

`--execute --github` の managed controller は、handoff 済みの registered repository の保存された needs-human 作業を確認し、Issue ごとに一つの `Codex Worker Review` comment を作成・更新する。通常の操作は Issue を読み、表示された current request の確認済みカテゴリに 👍 を付けるだけ。最後の条件が揃うと、global/repository が Enabled/Resumed の場合に同じ session/worktree を bounded dispatch で再開する。追加の Resume、ready の付け直し、queue 投入は不要。

管理画面は詳細確認・緊急復旧の補助手段として保持する。Pause/Disable、quota、不明な完了、worker/dispatch lock、dependency、closed/blocked/failed Issue、関連 PR、branch/worktree/profile の安全確認は承認と独立であり、👍 で解除しない。

## Request と reaction の安全契約

manager の既存 GitHub 認証主体が comment を作成する（使用する token の主体によって bot またはユーザー表示になる）。private `github-reviews.json` に opaque request ID、登録 repository/Issue、comment ID、作成主体の stable user ID、Issue digest、saved diff/base/HEAD binding、固定カテゴリ・表示状態、操作 UUID を保存する。0600、controller の単一 write lane、atomic rename/fsync、registry topology の照合を使用する。本文・diff・session・path・raw log は保存しない。

受理には、保存された current request の comment ID・作者 ID・Issue URL・固定 schema body の完全一致、fresh repository owner または設定済み reviewer の stable user ID、👍 の reaction ID/時刻、current Issue/diff binding の一致が全て必要。login の一致、任意コメント、自由文 approved、ラベル、marker のコピーだけでは承認しない。API pagination は bounded で、不完全な一覧や不明な actor は成功扱いしない。

受理した reaction は #5 の private grant と操作 receipt に変換する。カテゴリごとに UUID/revision を保持して冪等に保存し、既存 requireApprovals と検証・publication guard を通す。reaction 自体を worker authorization にしない。API/actor/binding/grant 保存が不明なら dispatch しない。保存または comment 更新結果が不明なら controller を blocked にして、未確定 request を通常 restart で再利用・重複投稿しない。

diff または Issue body が変われば、同じ comment を新しい request ID で更新し、既存 reaction ID を baseline として拒否する。反応は current request 公開後の時刻に限る。#5 の diff grant が本文変更後も有効な場合でも、#8 の request は stale として新しい確認を要求する。worker にも current Issue/diff の追加 binding を渡し、dispatch 時と検証・commit/publication 前に照合する。

comment の安全な表示は category/status、固定 check、Worker waiting/resuming/running/idle、retry exhausted のみ。E2E は固定 spec/project の名前と retry=0 を表示する。diff内容、absolute path、session ID、raw stdout/stderr、credential、PHI を出さない。実行中も30秒の固定 poll で同じ comment の状態を更新する。終了時は新規 poll を停止して進行中の write を待つ。

## Reviewer と manual E2E の初期設定

個人 repository の owner は GitHub repository API の stable numeric owner ID で照合する。組織 ID は human actor として認めない。組織 repository または追加 reviewer は管理者が登録時に stable user ID を指定する。Issue や reaction から設定を変更できない。

```json
"githubReview": {
  "reviewerIds": [123456],
  "e2e": {"specs": ["auth"], "projects": ["chromium", "mobile-chrome"]}
}
```

`e2e` は #5 の既存 enum allowlist に限定し、受入条件に必要な範囲を管理者が事前設定する。不要なら null。care-record-v1 のみで、既存 pinned config、専用 local 環境、skip/retry/expected failure 拒否を維持する。未設定の manual_e2e は scope required と表示して承認・実行しない。path/glob/CLI flags/shell を入力できない。設定は registry fingerprint に束縛されるため、既存 handoff/状態との整合を通常の安全手順で確認する。この実装作業では live registry、handoff、controller、credentials を変更していない。

## specification と operational blockers

specification は grant 対象ではない。owner が **Issue 本文**に canonical decision を記録し、その変更後に current request に 👍 を付けると、Issue digest/revision 時刻の変化と saved diff の一致を確認して一度だけ再評価する。古い 👍、本文変更のない 👍 はトリガーにしない。GitHub の秒単位時刻で順序が不明な場合も受理せず、本文更新より後の秒の reaction を要求する。canonical spec ファイルの変更検出は本版では自動読取せず、決定を Issue 本文に記録する。自由文コメントは仕様の正本にしない。

worker は同じ saved session/worktree/base を保ち、再評価した Issue digest を private state に保存して replay を拒否する。仕様確認を approval 扱いせず、Codex が再び specification を返せば停止し、同じ comment を次の decision request に更新する。他の human guard、有限 verification repair、必須 checks は維持する。

local_verification / sandbox_capability / verification_retry_limit は #7 の固定 parent verification に従い、👍 を要求しない。automatic retry または failed / human investigation を表示する。production/deploy/credential/destructive/auto-merge の権限は追加しない。実装により sandbox/network 制約を変更しない。

## 検証範囲

合成 Git・mock GitHub/Codex と loopback HTTP/IPC で、正規 owner/reviewer、偽 author/comment/marker、旧 reaction、Issue/diff変更、race、API/永続化失敗、restart、duplicate poll、auto resume、仕様再停止、禁止カテゴリを回帰確認する。実 GitHub の承認 reaction、live worker dispatch、CareRecord E2E/DB、production/deploy は実施しない。導入は人が Draft PR をレビューして行う。
