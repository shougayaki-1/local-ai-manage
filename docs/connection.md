# CareRecord接続と移管前点検

2026-10-03。local-ai-manage内だけの実装。CareRecordの稼働source/state/LaunchAgentを変更しない。

## 既存workerの観測

registryに既存stateDirectoryとclonePathを登録する。`--status`とGUIは同じallowlist projectorを使い、保存status/current Issue/stage、paused、quota/retryを表示する。raw CLIの`codex:worker:status`はbranch/worktree/自由文を含むため、その出力を管理画面や遠隔statusへ取り込まない。

旧workerに有効なtelemetry.jsonがなければ、heartbeatとCLI実測modelは未取得。state mtimeで代用しない。固定bridgeへの移管後はproducer sidecarを観測できる。旧sourceへのproducer移植は別PRとして残る。

## 読み取り専用の点検

```sh
npm start -- --registry registry.local.json --controller-state /absolute/private/controller --preflight
```

既存private controller directoryを明示する。点検はdirectory/fileを新規作成せず、lockを取得・削除せず、state/controlを更新しない。registryのcanonical identity/origin検証の後、次を診断する。

- private controller/state directory、symlink・path変更・重複
- registry fingerprintに一致するprivate handoff
- controller/dispatch/worker lock、復旧gate
- 固定profile/package/check scriptsとSol / medium
- state schema、保存profile/sessionの不一致、quota期限・不明quota
- current/paused/needs-human/failed、人の確認が必要な既存controller journals
- sidecarの有無。heartbeatはdispatch gateに使わない

各項目はpass / blocked / review-required / unavailable。reportにはregistry fingerprintと固定reasonだけを出し、絶対path、秘密値、PID、session、raw errorを含めない。blockedならexit 2、それ以外はexit 0。全項目がpassになる仕組みではない。`authorizesDispatch`は常にfalse。診断後にも設定/stateは変化し得るので、実dispatchの再検証を置換しない。

`--github`を加えた場合だけ、既存credential boundaryのfixed `gh auth status --hostname github.com`で認証を点検する。shellなし・5秒・64KiB上限、raw stdout/stderrを出力しない。repositoryへのwrite権限、queue、Codex認証を確認するcommandではない。

CodexのChatGPT loginとinstalled CLI互換性、全standalone/controller/worker/Codex子processの停止、LaunchAgent等の再起動防止は管理者が別途確認する。lock不在から停止済みとは推測しない。保存state/current/quotaやjournalを自動解除しない。handoff/recoveryの実手順はREADMEとrecovery.mdを参照。

## Issue #73との表示契約

[CareRecord Issue #73](https://github.com/shougayaki-1/care-record/issues/73)を2026-10-03にread-onlyで確認した。固定1コメント、5分のpublication heartbeat、15分stale、state正本、PHI/タイトル/本文/session/raw error非公開という仕様。今回実装したのはtransportから独立した本文formatterとCLI previewのみ。

```sh
npm start -- --registry registry.local.json --remote-status
npm start -- --registry registry.local.json --remote-status --github
```

JSON配列のrepositoryId/bodyが返る。デフォルトはnetworkなし。`--github`は既存read-only observerでqueueを取得する。1回の観測は1repoだけなので、他repoはunavailableのままになり得る。

本文に`<!-- codex-worker-status -->`と、有効なproducer時刻があれば`<!-- codex-worker-heartbeat: ISO timestamp -->`を含める。heartbeat観測から15分を超えるとheartbeat stale、producerの通常終了はstopped、有効なsidecarがなければunknown。local GUI側の60秒staleとは用途を区別する。保存時刻をheartbeatにしない。

queueはobservedかつ5分以内でrepository一致の場合だけ表示し、eligibleのready件数とpriority/Issue番号順の最大5件を出す。partial/stale/unavailableはunavailable。quotaはwaitingかunknownのみで、期限なしからaccount capacityを推測しない。pausedは既存stateの別fieldとして表示する。自由文の理由は転記しない。

marker付きstatus Issueはready labelが誤って付いてもconsumerと固定workerの新規queue選択から除外する。既存CareRecordの稼働workerにはこの変更を反映していないため、実publisherを導入する前に旧writerへの反映/停止を確認する必要がある。

2026-10-04: 固定IDのopt-in publisher、5分publication cadence、独立read-only monitorと無効Actions templateを追加した。詳細はpublishing.md。自動Issue/comment作成とコメント自体のstale書換は実装していない。#73全体の完了とは扱わない。

## GUIの切替前確認（2026-10-04）

認証済み固定GET `/api/readiness`でpreflightとproducer catalogueの照合を取得する。HTTP入力からregistryやpathを指定できず、GitHub/Codex認証も呼ばない。30秒cacheと同時要求の集約を使用する。起動中dashboardが保持するcontroller lockは識別するが、dispatch/worker lockや保存needs-humanを無視しない。CareRecordのdeployment抑止設定も診断する。repoを選択すると全体項目と対象repoだけ表示する。authorizesDispatchは常にfalse。
