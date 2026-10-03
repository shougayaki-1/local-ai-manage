# CareRecord standalone producer migration bundle

更新: ユーザー承認後にこのMacの停止・再起動防止、専用producer適用、Pause状態の管理設定を実施した。以下には準備時点の記録も含む。現在の運用状態とbuild制約は [運用移管記録](operation-record.md) を正本とする。

2026-10-04。レビュー用パッチとread-only照合CLIをlocal-ai-manageに追加した。CareRecord開発ツリー、専用worker clone、state、LaunchAgent、GitHubには適用していない。

## Bundle

固定catalogueに2種類のbundleを収録する。開発snapshot用は `integrations/care-record-producer/`、専用clone用は `integrations/care-record-dedicated-producer/`。どちらもproducer.patchは5ファイルの差分。

- continuous-worker: optional producerをworker lock取得・state再読込・repo一致確認後に開始。state保存後にsidecarを更新し、終了時はproducerを閉じてからlock解放。
- codex-runner:成功したOS spawn通知のみでCLI model/effortを記録するcallbackを追加。既存args/prompt/sandbox/credential/session処理は変更しない。
- queue: status marker付きIssueを新規候補から除外。
- lib/telemetry:固定bridgeと同じallowlist/0600 sidecar/15秒heartbeat/固定イベント最大100件。ストレージ失敗でworkerの処理・retry・quotaを変えない。
- telemetry.test:secret不含有、OS spawn成功、storage failure、default opt-out、paused stateのbyte保全、status/dry-run read-only、lock拒否、保存済みstatus Issueの保護、長時間fake Codex中のheartbeat。

CLIは `--telemetry` を明示した時だけ有効。既存flags/npm scripts/LaunchAgentは変更しない。status/dry-runにflagを付けてもsidecarを作らない。既存needs-human/paused/sessionをtelemetry目的で解除しない。

保存currentがstatus Issueなら、resumeでもworktree/Codex/publicationへ進めず、needs-human/pausedを保存する。status Issueのqueue label変更やコメント投稿は行わない。これは新規queue除外だけでは守れない既存currentへの保護。

manifest.jsonは開発版14ファイル、専用clone版16ファイルのbefore/after SHA256とパッチSHA256を記録する。beforeは各working-treeのsnapshotであり、リリースcommitや稼働codeの証明ではない。baselineはテスト再現用の静的 `.txt`で、認証/state/環境変数/LaunchAgentは含まない。state writerや親verificationを丸ごと置換するパッチではない。

## Read-only plan

```sh
npm start -- --registry registry.local.json --producer-plan
```

registryのcanonical path/origin確認後、package identity、bundle integrity、source hashesを照合する。出力はrelative source filenamesと固定status/fingerprintだけ。GitHub/Codexを呼ばず、Git hook、patch適用、state/lock変更を行わない。

- ready-for-review: before hashesが一致する。一部sourceが一致しただけではreadyにしない。
- already-present:全after hashesが一致する。
- blocked:変更、symlink、読取不良、一部だけ適用済みなど。
- unsupported: CareRecord packageではない。

blockedはexit 2。他はexit 0だが、authorizesApplyは常にfalse。確認後のsource変更もあり得るため、plan成功だけでlive適用しない。

### 現在の実環境との照合

2026-10-04の初回照合では開発版との相違でblockedだった。差異レビューで、専用cloneのVercel branch deployment抑止とcomponents全体の検証を確認した。これらを保持する専用bundleを追加し、現在の登録済みcloneの照合はready-for-review、basis=dedicated。patch SHA256は `4534935d791a5451f717e7529b943cd3dc3e0a47e4f772000bbe349931811868`。publication.mjsとverification.mjsはパッチ前後でbyte一致を検証する。2つのbundleを無条件に重ねず、全hashが一致する候補が1つだけの場合に選ぶ。稼働プロセスがどの版をロードしているかは、この照合だけでは確認できない。

## 適用前の運用手順（未実施）

1. 開発ツリーのbundle差分をレビューし、approved sourceを決める。cloneとの既存差異を別途確認する。機械的にfuzz/3-wayで押し込まない。
2. standalone/controller/worker/Codex子processの停止と、LaunchAgent等の自動再起動禁止を確認する。lock/heartbeat不在から停止を推測しない。
3. 最新sourceに対してplanと `git apply --check` を再実行する。blockedなら適用しない。動いているentrypointを編集せず、review済みsource更新を別作業で行う。
4. 適用対象でAGENTS.mdの検証条件を満たす。worker tests以外にCareRecordのtypecheck/lint/関連unit/build等も必要。E2Eは独断で実行しない。
5. 最新state pathを維持し、session/base/failure/quotaをresetしない。safe boundaryで移管/telemetry起動の運用確認を行う。

今回の検証はsourceだけを一時Git repositoryへ複製し、git apply --check→apply→after hashes→patched worker testsを実行。開発版101件、専用clone版103件成功。実stateへの適用、CareRecordの実起動・実Codex/GitHub操作はしていない。Node nested test subprocessはNODE_TEST_CONTEXTを外し、実際に内側のテストが実行された件数を確認する。

## 次の段階

運用で採用するbundle/releaseの承認、実停止/再起動防止の確認、Status Issue/comment準備とpublisher/monitor有効化、限定trial。パッチを準備したこととlive移管完了を区別する。
