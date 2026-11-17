# 取得済みリポジトリから更新する

`npm run deploy`は、取得済みのGit commitから運用コードを別のディレクトリへ準備し、確認した更新だけを適用します。開発用checkoutをbuildしても、分離後の運用コードは変わりません。

操作は`plan`・`apply`・`status`の3つです。Gitの取得は利用者が行います。新しい常駐サービスや配布サービスは不要です。

## 対応範囲

- Node 24以上、npm、Git、tarを使用します。初版のサービス制御はmacOSの利用者LaunchAgentとOpenClaw **2026.9.9**が対象です。pluginのSDK互換範囲とは別の対応条件です。
- 既存のOpenClaw plugin、1つの`cycle` command automation、指定した同期・日次backup・週次backup-verifyのLaunchAgentを扱います。ジョブや認証は新規登録しません。
- OpenClawを使わない構成では`openclaw: null`を明示できます。各LaunchAgentも未使用なら`null`にします。外部のWriterや同期を使っているのに未使用と指定しないでください。宣言したサービスだけを停止します。
- Vault形式の変換、Windows/Linuxのサービス管理、Flutterアプリ更新、Codex/Claude Codeのグローバル設定・hook、独自の起動スクリプトは対象外です。

## 1. 一度だけ設定する

[設定例](../examples/deployment.sample.json)をリポジトリ外へコピーし、パスと既存ジョブIDを自分の値に置き換えます。例のパスをそのまま実行しないでください。未使用のサービスは、項目を残して`null`にします。`openclaw.automationId`、`workspacePath`も未使用なら`null`です。

| 項目 | 内容 |
|---|---|
| `hubConfigPath` | 現在使っているHub設定の絶対パス |
| `installDir` | 運用コード・更新記録の保存先。Vaultと取得元checkoutの外 |
| `previousRuntimePath` | 初回移行前にplugin・ジョブ・backupが参照しているリポジトリの絶対パス |
| `openclaw` | 実行ファイル、実設定、既存Gatewayのplist、既存automation ID。使用しなければ`null` |
| `launchd` | 制御する同期・backup・backup-verifyのplist。それぞれ使用しなければ`null` |
| `workspacePath` | 配布するhub workspaceの絶対パス。配布しなければ`null` |
| `preserveAssets` | 独自管理として更新対象から外す配布IDの配列 |

設定と制御ファイルもリポジトリ・Vault・`installDir`の外に置きます。管理対象の所有者と書き込み権限、symlinkを経由しないことを確認します。認証を含む設定・バックアップ・更新領域をGitや公開フォルダーへ入れないでください。

Hub設定の`statePath`と`logging.dir`は、入れ替える`runtime`や`updates`内に置けません。ディレクトリ名の大文字・小文字の違いも含めて配置を検査します。

automationを指定する場合は、Gatewayの稼働中に始めます。`payload.argv`がNode・旧CLI・`cycle`で始まり、`payload.env.CONTEXT_HUB_CONFIG`が同じHub設定を参照する既存ジョブが対象です。それ以外は既存構成を変更せず停止します。

初回には、版が記録されていない既存環境も「既存版不明・初回の基準登録」として確認します。明示した旧参照との一致と新版の`doctor`を確認し、適用前バックアップ後に移行します。旧checkoutやその未コミット変更は保持します。

## 2. 更新内容を確認する

リポジトリで実行します。

```sh
git pull --ff-only
npm run deploy -- plan --config "<deployment.jsonの絶対パス>"
```

未コミット変更のないHEADを`git archive`で候補へ取り出します。無視されている個人設定、既存`dist`、`node_modules`、worktreeはコピーしません。候補内で依存導入・check・全テスト（並列数2）・build・mock demoを行い、OpenClaw使用時は導入済みパッケージに対するSDK検査も行います。npmの依存取得にはネットワークが必要です。

`plan`は運用コードや配布先を書き換えず、サービスも停止しません。Hub設定は新版で読み取り専用検査します。実モデルや`cycle`・`organize`は呼び出しません。候補・ログは`installDir/updates/<plan-id>/`に保存します。

出力のcommit、変更対象、制御するサービス、保持対象を確認してください。配布物に独自変更があれば、IDを示して止まります。手動で内容を統合するか、そのIDを`preserveAssets`へ追加してからplanを作り直します。例えば`vault-agents`を指定するとVaultのAGENTS.mdを独自管理として保持します。ID一覧は[scripts/deploy/manifest.json](../scripts/deploy/manifest.json)にあります。

## 3. 確認したplanを適用する

出力された`applyCommand`を実行します。

```sh
npm run deploy -- apply --plan "<表示されたplan.json>" --confirm "<表示されたplanHash>"
```

確認後に設定・配布物・候補・取得元が変わっていれば、サービス操作前に止まります。変更があればplanを作り直してください。AIに依頼する場合も、具体的なplanを確認して適用を指示します。

適用では元のサービス状態を記録し、ジョブ・同期等を一時停止して共通Vaultロックを取得します。Vaultと変更対象をバックアップし、アーカイブを最後まで読めることを確かめてからコードと配布物を切り替えます。`doctor`・設定・Gateway/pluginを検査して、元が稼働中だったものだけを再開します。追加の手動整理やDiscord送信はしません。

Gateway内のcontext-hub登録エラーがないことと、同期等の常駐サービスが稼働状態へ戻ったことを確認してから完了します。backup等の予定実行型ジョブは登録状態の復帰を確認します。

初回だけ、plugin・automation・backup等のコード参照先を`installDir/runtime/`内の固定パスへ変更します。以降は停止中にruntimeを入れ替えます。前版は更新領域の`previous-runtime/`へ保持します。同じcommitで変更がなければ再配置せず終了します。

内容と記録の整合を確認できる既存の受付失敗・受付の停止回復待ちは、`plan`の`existingIntakeIssues`に表示して保持します。適用直前と更新後に、診断が増えていないことと、残っている対象の受付ファイル・停止回復・失敗記録の内容を照合します。再試行時刻だけの変更と問題の解消は許可します。破損・競合・ロック異常など、それ以外の診断は更新を止めます。更新処理が受付を再実行したり、失敗記録を削除したりすることはありません。

## 状態・復旧

```sh
npm run deploy -- status --config "<deployment.jsonの絶対パス>"
```

現在のcommit、管理対象の変更（`drift`）、保持対象、未完了操作をJSONで返します。未完了または変更があれば終了コード1です。未導入の`commit: null`は終了コード0です。

新Writerを再開する前の通常エラーでは、確認できる範囲だけ元へ戻します。Gateway等を再開した後の失敗は、旧コードやVaultを自動復元せず、対象サービスすべての停止を試みて復旧待ち状態を残します。`status`の`pending.stopResults`で各停止の確認結果を返します。未確認の対象は停止済みと判断せず、設定・バックアップ・journalを保存先で確認してください。バックアップにはHub設定・deployment設定・OpenClaw設定・指定したplistも含まれます。

元の版へ戻す復旧でも、サービス再開前にjournalへ記録します。その再開が失敗した場合も停止を試み、`pending.failure`に元の失敗、`pending.recoveryFailure`に復旧中の失敗を残します。再開を始めた後の復旧待ちは自動再実行しません。

強制終了などで途中に止まった場合は、まず`status`を確認します。全Writer停止と所有PIDの終了を確認したうえで、共通Vaultロックの残骸は既存の`ctx doctor --unlock`で回収します。その後、同じplanとhashでapplyを再実行します。更新専用ロックは同じplan・死亡PID・journalの一致が確認できる場合だけ回収します。別の変更や再開済みWriterがある場合は自動再開しません。ロックを手で削除して処理を強行しないでください。

Vault形式の異なる更新と旧commitへの巻き戻しは通常のapplyでは扱いません。[復元手順](operations.md#復元テスト)で別のVaultへ復元して確かめます。初回に指定した旧checkoutを削除する前に、独自のhook等から参照されていないことも確認してください。方針hookを利用している場合は、初回移行後にruntime内の`prepare-policy-setup.mjs`から差分を準備する[既存の設定手順](policies.md)を使います。

更新領域は自動削除しません。運用版、未完了操作、必要な復元点を確認したうえで、不要な**完了済み**更新領域をVault外の通常のファイル管理で整理してください。`runtime`と`deployment-state.json`、未完了操作の領域は残します。
