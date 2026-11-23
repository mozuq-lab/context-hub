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

## MCPで読み書きする

Vaultのファイルを直接読ませる代わりに、ContextHubのMCPサーバーを登録すると、エージェントは現在地・方針・検索の結果を決まった手順で受け取れる。読む順序や「読まない記録」の約束をモデルに任せずに済む。MCPを使えない環境では、上の直接参照の方法をそのまま使う。

### 出すツール

| ツール | 種類 | 中身 |
|---|---|---|
| `contexthub_resume` | 読取 | 望む結果・現在地・次の一手・未解決（`ctx resume`） |
| `contexthub_context` | 読取 | 有効方針を含む文脈。`max_chars`の既定は設定の`retrieve.contextMaxChars`（`ctx context`） |
| `contexthub_find` | 読取 | 原文・アイデア・知識・NOWの検索（`ctx find`） |
| `contexthub_policies` | 読取 | 有効方針（`ctx policies`） |
| `contexthub_pending` | 読取 | 未整理・整理失敗の入力（`ctx pending`） |
| `contexthub_save_work_summary` | 書込 | 作業要約を`Input/`へREQとして新規作成（`submit-input.mjs --kind work-summary`と同じ形式） |

- 読取の結果は同名のCLIと同じ。別のAIへ渡るため、秘密情報らしい文字列は`[伏せ字:種類]`に置き換える（`context`は元から伏せている）。読取ツールはVaultに書き込まない。
- `resume`・`context`・`policies`でプロジェクトを省くと、クライアントが渡す作業フォルダー（MCPのroots。渡さないクライアントではサーバーを起動したフォルダー）を設定の`policy.projectRoots`に照らして決める。対応がない、複数のプロジェクトに分かれる、または対応付けたプロジェクトが未登録のときは、`resume`・`context`は登録済みプロジェクトの一覧を返して指定を求め、勝手に選ばない。`policies`は共通の方針だけを返す。`find`は作業フォルダーで絞らない。
- 書込は作業要約の保存だけ。整理・承認・却下・訂正・状態変更・完了報告などの本人操作は出さず、モデルも呼ばない。保存前に、この端末の設定で受付と同じ検証（本文1〜`capture.maxInputChars`文字、作業日の範囲、指定したプロジェクトが登録済みか）を通し、通らなければREQを作らない。Miniの設定（上限など）がこの端末と違うと、ここで通ってもMiniで断られることがある。作業フォルダーから決めたプロジェクトが未登録（未作成・未同期）なら、未指定で保存する。結果はREQ IDと「端末保存済み（Mini未受領）」で、同期後にMiniが受け付けて整理する。受け付けた後の整理待ちは`contexthub_pending`に出るが、REQ IDは出ず、受付で断られたものも出ない。断られたかどうかは本人がHOMEで確かめる。
- **書込ツールは、本人が「ContextHubへ保存して」と頼んだときだけ使う。** ツールの説明にも同じことを書いているが、自動許可にはしない（下の設定例）。

### 準備

この端末でリポジトリを取得してビルドする（Node 24）。

```sh
git clone https://github.com/mozuq-lab/context-hub.git
cd context-hub
npm ci && npm run build
```

起動コマンドは`node <リポジトリの絶対パス>/packages/mcp-server/dist/index.js`。Vaultの場所と`policy.projectRoots`は既存の設定ファイルから読む（`--config <設定ファイル>`、省くと`CONTEXT_HUB_CONFIG`か`~/.config/context-hub/config.json`）。Vaultだけを同期している開発用Macで設定ファイルがなければ、`--vault <この端末のVaultの絶対パス>`だけでも起動できる。その場合は作業フォルダーの対応がないため、プロジェクトはツールの`project`引数で指定する。作業フォルダーから決めたい場合は、この端末用の設定ファイルを作り、`vaultPath`と`policy.projectRoots`（この端末のリポジトリの絶対パス）を書く。設定を変えたら、エージェントのセッションを開き直してサーバーを起動し直す。

### Claude Codeに登録する

山括弧の値をこの端末の絶対パスに置き換える。`--scope user`で全プロジェクトから使える。

```sh
claude mcp add --scope user context-hub -- node "<リポジトリの絶対パス>/packages/mcp-server/dist/index.js" --config "<設定ファイルの絶対パス>"
```

読取ツールだけを確認なしで使わせる場合は、`~/.claude/settings.json`の`permissions.allow`に加える。書込ツールは加えず、呼び出しのたびに確認を出す。

```json
{
  "permissions": {
    "allow": [
      "mcp__context-hub__contexthub_resume",
      "mcp__context-hub__contexthub_context",
      "mcp__context-hub__contexthub_find",
      "mcp__context-hub__contexthub_policies",
      "mcp__context-hub__contexthub_pending"
    ]
  }
}
```

### Codexに登録する

`~/.codex/config.toml`に加える。`default_tools_approval_mode = "writes"`は、読取専用の印（`readOnlyHint`）がないツールだけ確認を出す設定で、このサーバーでは書込ツールだけが確認の対象になる。

```toml
[mcp_servers.context-hub]
command = "node"
args = ["<リポジトリの絶対パス>/packages/mcp-server/dist/index.js", "--config", "<設定ファイルの絶対パス>"]
default_tools_approval_mode = "writes"

[mcp_servers.context-hub.tools.contexthub_save_work_summary]
approval_mode = "prompt"
```

`codex mcp add context-hub -- node "<リポジトリの絶対パス>/packages/mcp-server/dist/index.js" --config "<設定ファイルの絶対パス>"`でも登録できる。承認の設定は上のように`config.toml`へ書く。

### 使い方

「ContextHubで今のプロジェクトの現在地と方針を確認して」のように頼むと、エージェントは`contexthub_policies`と`contexthub_resume`を呼ぶ。作業の終わりに「今回の作業結果をContextHubへ保存して」と頼むと、[作業要約の形式](handoff-summary.md)で`contexthub_save_work_summary`を呼ぶ。ツール名（`codex`・`claude-code`）は接続しているクライアントから決まり、プロジェクトは指定か作業フォルダーの対応から決まる（決まらなければ未指定で保存し、整理で判断する）。

## 結果を保存する

MCPを使わない場合、「今回の作業結果をContextHubへ保存して」と依頼すれば、AIは共通AGENTS.mdのコマンドでInputへ新しい作業要約を保存する。通常の参照だけで保存を指示しなかった場合は、Vaultを変更しない。Codexでは`--tool codex`、Claude Codeでは`--tool claude-code`を使う。

返されたREQ IDと「端末保存済み」を確認し、同期後にHOMEでMiniの受領・整理状況を見る。毎時・limit 2で定期処理を設定した場合は、AI整理・回復・再関連付けを合計最大2件ずつ扱う。実際の間隔と上限は導入時の設定を確認する。端末がオフラインなら同期再開後の処理になる。通常の保存のために、AIから追加のorganize/cycleやジョブ操作を実行しない。

Nodeや保存ツールが使えない場合は、生成された短い作業要約を本人がQuickAddで保存できる。訂正・承認・却下は本人操作を使う。

## 選択肢を選んで記録・壁打ちする

「選んで深掘りで今日の作業を記録したい」「質問に答えてまとめたい」のように頼むと、AIが問いと選択肢を1問ずつ出し、本人は選ぶだけで記録・壁打ち・アイデア出しを進められる。手順は[選んで深掘り](guided-capture.md)にある。Claude Codeでは、Vaultに `.claude/skills/guided-capture/` を置くと `/guided-capture 記録 <プロジェクトID>` でも始められ、問いは選択式の画面で出る。まとめは本人が確認してから、メモとしてInputへ保存する。

## 公式仕様

- [CodexのAGENTS.md探索](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [Claude Codeの共通指示・import](https://code.claude.com/docs/en/memory#share-one-file-with-other-coding-tools)
- [Claude CodeのMCP](https://code.claude.com/docs/en/mcp)
- [CodexのMCP](https://developers.openai.com/codex/mcp)
