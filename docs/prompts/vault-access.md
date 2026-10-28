# Codex・Claude CodeからContextHubを読む

同期済みVaultのAGENTS.mdを共通ルールとし、Claude Codeは隣のCLAUDE.mdから`@AGENTS.md`で読み込む。開発リポジトリのAGENTS.mdは開発用の規約なので、Vaultへそのままコピーしない。

配布元は[共通AGENTS.md](../../examples/vault-instructions/AGENTS.md)と[CLAUDE.md](../../examples/vault-instructions/CLAUDE.md)。本番への新規配置・既存指示の変更は、対象と内容を確認した本人の依頼に基づいて行う。端末のVaultの実際の保存先を使い、Miniの絶対パスを別Macへそのまま流用しない。

## Vaultを作業フォルダーとして開く

CodexまたはClaude Codeで、この端末に同期されたVaultのルートを作業フォルダーにして新しいセッションを始める。初回は次の依頼で、読み込んだ場所とルールを確認する。

```text
このフォルダーのContextHub利用指示を読み、Vaultの場所、参照する順序、保存方法を短く説明してください。今回は読み取りだけにしてください。
```

その後は「ContextHubを読んで、対象プロジェクトの現在地と次の一手を教えて」のように依頼する。AIはHOME→対象プロジェクトのNOW→必要な原文を参照する。対象が不明ならプロジェクト候補を確認する。

ローカルファイルを直接参照する場合も、読んだ本文は選択したAIモデルで処理される。対象を絞って参照する。ファイルへのアクセス可否は各アプリの権限設定にも依存し、指示書の配置だけでは権限は変わらない。

## 普段の開発プロジェクトから参照する

Vaultを別の場所に置いたまま開発する場合、その開発プロジェクトで読み込まれる既存指示に、下記を追記する。既存指示は置き換えず、本人が指定したプロジェクトだけを設定する。

CodexのAGENTS.mdに加える例。山括弧の値を、この端末のVaultの絶対パスへ置き換える。

```markdown
## ContextHub

ContextHubのVaultは `<この端末のVaultの絶対パス>` にあります。
ContextHubを参照する依頼や保存依頼では、まずVault直下のAGENTS.mdを読んで、その利用ルールに従ってください。
記録の参照はHOME.mdから始め、対象プロジェクトのNOWと必要な原文へ進んでください。
```

Claude CodeのCLAUDE.mdに加える例。パスを置換し、空白を含む場合は各空白をバックスラッシュでエスケープする。実際のファイルでは`@...`を引用符やコードブロックで囲まない。

```markdown
@/この端末のVaultの絶対パス/AGENTS.md

ContextHubを参照する依頼では、上記VaultのHOME.mdから対象プロジェクトと必要な原文へ進んでください。
```

Codexは主な作業フォルダーに応じてAGENTS.mdを探索する。Claude Codeも追加ディレクトリへのアクセス許可だけでは、そこのCLAUDE.mdが標準で読み込まれるとは限らない。別プロジェクトから使う際は上記の参照を明示する。Claude Codeの外部importの確認画面が出た場合は、本人が表示されたパスを確認する。

## 結果を保存する

「今回の作業結果をContextHubへ保存して」と依頼すれば、AIは共通AGENTS.mdのコマンドでInputへ新しい作業要約を保存する。通常の参照だけで保存を指示しなかった場合は、Vaultを変更しない。Codexでは`--tool codex`、Claude Codeでは`--tool claude-code`を使う。

返されたREQ IDと「端末保存済み」を確認し、同期後にHOMEでMiniの受領・整理状況を見る。毎時・limit 2で定期処理を設定した場合は、AI整理・回復・再関連付けを合計最大2件ずつ扱う。実際の間隔と上限は導入時の設定を確認する。端末がオフラインなら同期再開後の処理になる。通常の保存のために、AIから追加のorganize/cycleやジョブ操作を実行しない。

Nodeや保存ツールが使えない場合は、生成された短い作業要約を本人がQuickAddで保存できる。訂正・承認・却下は本人操作を使う。

## 公式仕様

- [CodexのAGENTS.md探索](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [Claude Codeの共通指示・import](https://code.claude.com/docs/en/memory#share-one-file-with-other-coding-tools)
