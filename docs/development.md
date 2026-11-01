# 開発と検証

Node 24とnpm workspacesを使います。coreはTypeScript ESM、検証はVitestです。

```sh
npm ci
npm run check
npm test
npm run build
npm run demo
npm audit
npm audit --omit=dev
```

checkはビルドと型検査、testのpretestもビルドを行います。テストは一時VaultとMockLlmを使い、実モデルや実設定を使いません。demoは`.demo/`、sampleは`sample-vault/`を扱います。`npm run sample`は追跡している架空サンプルを生成するため、差分とハッシュの整合を確認してください。

## 変更の進め方

- 不具合や振る舞いの変更は、先にその挙動のテストを失敗させて確認する。
- coreの外部接続はアダプターに隔離し、既存の原文・出典・承認・競合保護を維持する。
- ドキュメントだけの変更では、実装をなぞるテストを作らず、リンク、設定、掲載コマンドをサンプルで確認する。
- 依存更新は本体と開発用を分けて監査し、lockfileと全テストを確認する。
- テストのCLI入力は一時ディレクトリのファイルを明示し、個人設定の既定パスへフォールバックさせない。

## SDKの追加検査

OpenClawホストを導入した環境では、そのインストールディレクトリを指定します。ホストコードは実行せず、公開型と互換宣言・検証済み版を確認します。

```sh
npm run check:sdk --workspace=@context-hub/openclaw-plugin -- "<OpenClawパッケージの絶対パス>"
```

検証済み版は`packages/openclaw-plugin/scripts/plugin-api-range.mjs`で管理します。未登録版では、導入版のdocsと型を確認し、実際に検査してから追加します。package.jsonの互換範囲を単一の版へ固定しません。

## CIと公開物

GitHub ActionsはNode 24でcheck/test/build/demoと監査を行います。キーや個人設定は不要です。

`client-contract`ジョブは[Flutterクライアント](https://github.com/mozuq-lab/context-hub-flutter-client)の既定ブランチを取得し、固定submoduleの代わりにこのcommitを置いて、fixtureの形式比較とDartテスト（クライアントが保存した依頼を本体で受理する検査を含む）を実行します。Vaultの形式・候補一覧・方針manifestを変更して失敗した場合は、意図した変更かを確認し、merge後にクライアント側でfixtureの再生成と読取の更新を行います。このジョブは`continue-on-error`で、失敗しても本体のPRは止めません。ホストのSDK検査と実機のDiscord・同期・モデル接続はCIとは別に確認します。

公開するソースと例には架空のIDを使います。実Vault、個人設定、依存ディレクトリ、生成デモ、ログ、バックアップ、個人の運用記録をコミットしません。初期公開ではライセンス、著作権表示、公開先、コミットの名前とメールも確認します。
