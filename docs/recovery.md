# Offline recovery of controller ownership

対象は `--execute` を明示的に使用し、有効なhandoffを保存済みのmanaged controllerです。復旧コマンドはHTTP/GUI、Launch.command、heartbeat、PID判定から呼び出しません。既存CareRecord workerの移管を自動実行するものでもありません。

## Plan and scope

旧controller/bridge/Codex children、登録全体のstandalone workersとそのchildrenを管理者が停止し、自動再起動を無効にします。PID不在・lock不在・stopped heartbeatだけを全childrenの終了証明には使いません。`worker.lock`が残る状態はこのツールでは復旧できません。lockは削除せず、そのworkerの既存運用に従って独立に確認してください。

旧private管理ディレクトリと新規の置換先を指定し、読み取り専用planを取得します。両方ともcanonicalな絶対path、clone/worker stateとの非重複が必要です。旧ディレクトリは所有者限定、新規先の親は自分が所有しgroup/othersから書込不能である必要があります。置換先は未作成でなければなりません。

```sh
node dist/server/cli.js \
  --registry /absolute/path/managed-registry.json \
  --controller-state /absolute/path/old-controller \
  --recovery-plan /absolute/path/new-controller
```

planには登録repoの固定status/Issue/stage、lock/journalの有無、既知quota期限、未知quotaの有無、registry/plan fingerprintだけを返します。本文、session、worktree path、ログ、token、エラー本文は返しません。固定filesを最大1MiBで読み、symlink、不適切な権限、読めないworker stateやquota証跡を拒否します。

`ready-for-attestation`は人が停止確認を行える状態であり、プロセス終了を自動検証した意味ではありません。planは旧controllerのstate/lock/journals/handoffと登録全体のworker state/lockの内容・file identity、registry、置換先に結び付きます。確認後にこれらが変われば再取得が必要です。

## Concrete confirmation file

停止と自動再起動禁止を実際に確認した管理者が、所有者限定0600のJSONを作成します。placeholderをそのまま使わないでください。確認ファイルを自動生成するコマンドは提供しません。

```json
{
  "version": 1,
  "requestId": "<new UUID v4>",
  "registryFingerprint": "<from plan>",
  "planFingerprint": "<from plan>",
  "replacementDirectory": "/absolute/path/new-controller",
  "scope": "all-registered-workers",
  "allControllersAndWorkersStopped": true,
  "restartsDisabled": true
}
```

```sh
node dist/server/cli.js \
  --registry /absolute/path/managed-registry.json \
  --controller-state /absolute/path/old-controller \
  --reconcile /absolute/path/new-controller \
  --attestation /absolute/path/recovery-confirmation.json
```

これはoffline専用です。`--github`、`--execute`、`--status`、`--demo`、`--open`との併用を拒否します。確認fileの未知field、別registry/置換先/plan、falseまたは未指定の停止確認は拒否します。実際の停止は管理者による確認であり、自動証明ではありません。quotaをリセットする承認は含みません。

## Completed rotation

旧管理ディレクトリにretirementと復旧のマーカーを追加し、そこからのcontroller startup/dispatchを禁止します。元のcontroller/dispatch locks、journals、command receipt履歴はbyte単位で保持します。worker state/lock、session/base/worktree、quota/retry、needs-human、GitHub labels/PR、LaunchAgentには書き込みません。

新管理ディレクトリは0700、controller.json/handoff.json/recovery-quota.json/recovery-receipt.jsonは0600です。controller設定は全体・各repoともPause、revision=0から開始します。enabled値はregistryに従います。旧control receiptsは旧ディレクトリで保持し、新revisionへ移植しません。旧実行をcompletedとして記録することもしません。新directoryと旧directoryはreceiptで関連付けます。

既知のscheduler/dispatch quota期限は新controllerでも引き継ぎます。worker stateのquotaも通常のshared gateで引き続き確認します。解除時刻不明のquotaは新controllerでもblockedです。Resumeでは解除されません。

切替後は新管理ディレクトリを明示して起動します。起動自体はdispatchをResumeしません。

```sh
node dist/server/cli.js \
  --registry /absolute/path/managed-registry.json \
  --controller-state /absolute/path/new-controller \
  --github --execute --open
```

旧directoryは再利用せず、既存launcherの引数や自動起動設定も自動変更しません。worker自身のneeds-human等の確認を終えた後、利用者が新controllerのglobal/repoをResumeします。

## Incomplete rotation

保存失敗・中断ではsource recovery.lock、target recovery.lock、置換先の親にある `.<name>.recovery.lock` を保持します。通常startupと追加の自動復旧を拒否します。marker/lockの自動削除、旧controllerへのrollback、途中のtargetの無条件再利用は行いません。version 2 journalがある場合は、以下の明示的な再開plan・新しい確認fileに基づくreplayを利用できます。旧形式の中断は引き続き人の確認が必要です。

これらのmarkerは旧controllerを起動させないためのgateです。markerを削除したり、古いアプリ版やstandalone workerを起動すると保護を迂回し得るため、自動再起動禁止の管理者確認が必須です。本機能の検証はtemporary synthetic reposに限定し、live復旧/移管は実施していません。

## Resume an interrupted rotation

新しい復旧処理は、置換先の作成より前にsourceへversion 2の `recovery-journal.json` をsync保存します。停止確認、元データのfingerprint、置換先を保持します。sourceの元journals/locksとworker dataは保持します。journalがない旧形式の中断markerは自動移行・再開しません。

```sh
node dist/server/cli.js \
  --registry /absolute/path/managed-registry.json \
  --controller-state /absolute/path/old-controller \
  --recovery-resume-plan /absolute/path/new-controller
```

再開planはread-onlyで、resume fingerprint、元request id、保存済みfiles数、以前のattempt claim数を返します。rawデータは返しません。元のstate/journals/worker dataが変わっていたり、置換先にcontroller lock/schedulerなどの実行file、未知file、別内容の保存fileがあれば拒否します。

管理者がcontroller/worker/Codex childrenの停止、自動再起動禁止に加えて、**以前の復旧CLIも終了済み**であることを改めて確認し、0600の確認fileを作成します。

```json
{
  "version": 1,
  "requestId": "<new UUID v4>",
  "registryFingerprint": "<from resume plan>",
  "resumeFingerprint": "<from resume plan>",
  "replacementDirectory": "/absolute/path/new-controller",
  "scope": "all-registered-workers",
  "allControllersAndWorkersStopped": true,
  "restartsDisabled": true,
  "recoveryCommandsStopped": true
}
```

```sh
node dist/server/cli.js \
  --registry /absolute/path/managed-registry.json \
  --controller-state /absolute/path/old-controller \
  --resume-recovery /absolute/path/new-controller \
  --attestation /absolute/path/resume-confirmation.json
```

既存fileは期待値と一致する場合だけ再利用し、上書きしません。不足fileはexclusiveな作成で補完します。作成直前にsource・target・claimsを再照合し、同じplanの並行再開は一つだけclaimできます。作業中はsource/target/親directoryのgateを維持し、全filesとreceiptの永続化後にtarget側だけを開放します。新controllerはPause状態です。

再開自体も中断された場合はattempt claimを残します。古い確認fileのまま再試行はできません。新planのfingerprintを使い、以前の復旧CLIが終了したことを再確認してください。claimは最大128件、directory読取とfile sizeもboundedです。claims/markerの時刻やPIDからプロセス終了を推測しません。gateの手動削除・rollbackは行いません。

完了後の再呼び出しはreceiptを返すだけで、稼働を始めた新controllerの設定を上書きしません。その場合の結果は `alreadyCompleted: true`、`dispatchPaused: null`（現在のPause状態は未観測）です。初回の再開完了は `alreadyCompleted: false`、`dispatchPaused: true` です。

既知quota・未知quotaの保持は再開でも同じです。また復旧後、schedulerを起動する前にもう一度rotationしても、継承済みquota floorを保持します。
