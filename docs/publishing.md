# Fixed status publisher / independent heartbeat monitor

2026-10-04。最新の2repo実投稿・schedule登録は完了済みです。[運用手順](live-operation.md)を参照してください。以下の直接publisherとread-only monitorは代替経路で、現在の運用ではActions sole writerを使用します。

## 事前準備

管理者が専用Status Issueと固定コメントを1つ用意し、Issue本文に `<!-- codex-worker-status -->`、コメントの先頭行にも同じmarkerを置く。Status Issueにはcodex:* labelを付けない。publisherはIssue/commentを自動作成・検索しない。IDを固定することでrestartや通信結果不明時も重複を作らず、削除済み/誤ったIDは停止して人へ戻す。

専用0700 directoryを用意し、0600 `targets.json`を保存する。clone/stateとは別の領域に置く。秘密値は不要。

```json
{
  "version": 1,
  "registryFingerprint": "<canonical registry fingerprint>",
  "targets": [{
    "repositoryId": "owner--repo",
    "repo": "owner/repo",
    "issue": 100,
    "comment": 123456789
  }]
}
```

fingerprintはregistry全体と照合し、targetは登録repositoryと一致する必要がある。IDはplaceholderを置換する。最大32repo、同じrepo/commentの重複とunknown fieldsは拒否。`--preflight`でregistry fingerprintを確認できる。publisherとmonitorの設定は同じ専用directoryを使える。

## Publisherの明示起動

```sh
npm start -- --registry registry.local.json --github --status-publisher /absolute/private/status
```

これは実際にGitHubの指定コメントを書き換えるcommand。通常launcher、GUI、worker/schedulerから自動起動しない。実運用のsourceとtargetをレビューした後だけ実行する。自動回帰はmock GitHubを使用する。実運用では後述のActions sole writerを有効化した。

独立したpublisher.lockをexclusive取得。多重起動は拒否し、残ったlockをPIDや時刻で奪取しない。SIGINT/TERMは新たなtarget更新を止め、現在targetのbounded GET/PATCH完了後にlockを解放する。GitHub commandは各10秒/1MiB上限、targetを順に処理する。worker/Codexにはsignalを送らない。異常終了のlockはpublisherと子ghの停止確認後に管理者が扱う。

30秒ごとに共通snapshotを観測し、状態変化を次の観測で更新。通常heartbeatは最大5分ごとで、queue pollごとに書き込まない。再起動ではremote updated_atを確認し、表示状態が同じなら早すぎるheartbeat更新を抑える。失敗後も同じ状態では5分間隔で再試行する。更新結果が不明でもPOSTで再作成せず、次回GETで同じIDを照合する。

PATCH前にopen Issue/非PR/marker/queue label不在、comment ID/issue_url/markerを確認し、さらにcommentを読み直す。途中で変化したcomment、ローカルより新しいremote heartbeat、対象変更は更新しない。PATCHの応答も本文とIDを確認。ghにはGitHub用credential allowlistだけを渡し、bodyはJSON stdin、raw errorを出力しない。worker state/session/quota/実装retryは更新せず、失敗はpublisherのunavailableに留める。

このcommentはpublisherだけが書く運用を必須とする。同じtargetへ別Mac/publisherを動かさない。lockは同じ専用directoryを使うプロセス間の排他であり、別ホストの分散lockではない。管理者編集もPATCHの最終GET後に競合し得るため、編集時はpublisherを停止する。GitHub comment更新のcompare-and-swapを保証とは扱わない。

## 独立したread-only stale監視

```sh
npm start -- --status-monitor /absolute/private/status
```

clone/registry/Codex/stateを必要とせず、remoteの指定Issue/commentだけをGETする。共通heartbeat parserで15分超をstale、正常終了をstopped、不正/未来/複数timestampをunknown、取得失敗をunavailableとする。stale/unknown/unavailableはexit 2、observed/stoppedはexit 0。stdoutは固定statusとtimestampのみ。

監視はコメントをPATCHしないため、新しいworker heartbeatを古いstale判定で上書きしない。このread-only経路ではcommentを書き換えない。同一コメントのstale自動表示は後述のActions sole writerが実装する。

## Actionsでの独立監視（未有効化テンプレート）

`docs/templates/status-monitor.yml.example`と依存なしの`engine/status-monitor.mjs`を用意した。対象Status Issueと同じrepositoryにreviewしたscriptを配置し、workflowを `.github/workflows/`へ設置して初めて有効になる。既存repositoryへのcopy/cron登録は今回実行しない。

repository variables `CODEX_STATUS_ISSUE` / `CODEX_STATUS_COMMENT`だけを設定する。workflowの標準GITHUB_TOKENとcontents:read/issues:readを使い、新PAT・secretは要求しない。Node24、default branchのreview済みscript、10分間隔のschedule、3分job timeout。依存install不要。Actionsのschedule遅延はあり得る。watcher停止や15分staleは実process終了の証明ではない。

scriptはGITHUB_REPOSITORYと正整数のIDを検証して固定GETだけを行い、publisherと同じheartbeat classifierを使用する。GitHub tokenは当該repositoryだけなので、別private repoの観測はそのrepo側へmonitorを設置する。

## このMacの運用

producer移植、2repoのStatus Issue/comment準備、Actions有効化、実worker trialと移管は完了。idle時は別のcontroller heartbeatを明示して表示する。実worker telemetryや実行権限の代用には使わない。

一次資料: [GitHub issue comments REST](https://docs.github.com/en/rest/issues/comments)、[gh api](https://cli.github.com/manual/gh_api)、[actions/setup-node](https://github.com/actions/setup-node)、[actions/checkout](https://github.com/actions/checkout)。Context7でGET/PATCH/comment bindingと権限を確認した。

## 同一コメントのstale自動表示: Actions sole writer（2026-10-04）

直接PATCH publisherと別の選択肢として、`--status-actions`を追加した。全writer停止後、`engine/status-monitor.mjs`と`engine/status-writer.mjs`を対象repoのdefault branchにレビューして配置し、`docs/templates/codex-worker-status.yml.example`を `.github/workflows/codex-worker-status.yml` として設置する。固定variablesは上記と同じ。このMacの2repoではレビュー済みworkflowをdefault branchへ配置し、schedule登録済み。配布用example自体は無効なまま。

```sh
npm start -- --registry registry.local.json --github --status-actions /absolute/private/status
```

このcommandは実際のworkflow dispatchを行う。単一の専用lockとtargets.jsonを使用し、通常GUI/launcherからは起動しない。Mac側はcommentをPATCHせず、固定workflow/default branchにcanonical formatterの本文・観測時刻・repo identity・固定Issue/comment IDだけをJSON stdinで送る。rawログ・title/body・session・credentialをpayloadへ含めない。dispatch成功はqueuedであり、コメント更新成功とは宣言しない。既存GitHub認証にはworkflow dispatchに必要な権限が必要で、不足時はunavailable。新PATやscope変更は自動で行わない。

workflowはdefault branchのみで動き、標準GITHUB_TOKENのcontents:read/issues:writeを使用する。dispatchとscheduled stale判定を同じconcurrency groupに置き、実行中runをcancelしない。全てのcomment更新はこのworkflowだけに集約する。直接publisher・旧writer・別workflowは同時に動かさない。管理者編集時もwriter停止が必要。最終GETとPATCHを分散compare-and-swapとは扱わない。

payloadは16KiB本文上限、厳密schema、canonical timestamp、固定ID照合、列挙値・数字だけの本文grammarで検証する。workflow実行順序は保証されないため、remote observation marker以上の時刻だけを受け付ける。同じtimestampと古いobservation/newer remote heartbeatはsuperseded。遅延して既に15分を超えたpayloadは最初からheartbeat staleへ描画する。scheduled runはその時点の同じcommentを読み、heartbeat observedからstaleへだけ変更する。stoppedやunknownをonlineにしない。

Actionsのpending runは後続runで置換され得るため、全eventの配送や5分以内の表示を保証しない。Mac側は5分cadenceで再送し、次の実行で最新観測を反映する。schedule遅延・workflow未実行もあり得る。従来のread-only monitorは追加監視として併用できる。

この経路はmock transport / fake ghの回帰に加え、両repoの実dispatchと固定コメント更新を確認済み。workflowはcheckoutを使わず、`${{ github.sha }}`を40桁SHAとして検証し、固定2scriptのみContents APIで取得する。idle supervisor heartbeatを使用する場合は `--controller-state /absolute/private/controller` をstatus-actionsに追加する。これはread-onlyの観測入力で、実行許可は与えない。

一次資料: [Actions concurrency](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments)、[workflow dispatch](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)。Context7でconcurrencyのpending置換とstdin入力を確認した。
