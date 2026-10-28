# ContextHubの開発規約

このリポジトリはContextHubのソースと架空サンプルを配布します。利用者の実Vault・認証情報・個人設定・会話履歴を置かないでください。

- TypeScript ESM、Node 24、npm workspaces、Vitestを使います。
- 開発前にREADMEとdocs/development.mdを読み、git statusを確認します。
- 原文は不変です。IDとパスはコードが決め、生成物は出典・日時・未検証表示を保持します。
- Vault書き込みは共通のパス検証・耐久書き込み・ロックを使います。人の承認をAIの出力で代用しません。
- テストとデモには一時Vault、架空サンプル、MockLlmを使います。実Vault・Gateway・実モデルに接続しません。
- 識別子とコード以外の報告・文書・コメントは日本語で書きます。
- 修正時は該当テストを先に失敗させ、実装後に全テストを確認します。文書だけの変更には実装をなぞるテストを追加しません。
- 既存の認証・サービス・自動化・実Vaultを変える操作は、利用者の具体的な依頼に基づいて行います。設定例を実設定へ自動適用しません。
- CIと導入例へ個人のID・絶対パス・トークンを埋め込みません。公開前に履歴と著者情報を含む公開対象を確認します。

基本検証はnpm ci、npm run check、npm test、npm run build、npm run demoです。OpenClaw導入環境でのcheck:sdkは追加の互換検査として行います。VaultをAIから使うルールはexamples/vault-instructionsにあります。
