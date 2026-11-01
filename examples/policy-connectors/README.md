# AIへ有効方針を渡す

正本はContextHubのKNW/APR/適用停止記録です。共通の`readPolicies`で同期された一貫した版を確認し、Codex・Claude Code・整理処理・クライアントへ同じ方針を渡します。参考知識と未承認メモは必須方針に含めません。

## 設定準備

本体をbuildした後、実設定の外の新規フォルダーへ準備します。

```sh
node scripts/prepare-policy-setup.mjs --config /absolute/path/config.json --out /absolute/path/new-preparation
```

`--codex-dir`/`--claude-dir`で端末の設定ディレクトリ、`--node`でNodeの絶対パスを指定できます。既存の指示・hook・Claude設定を保持したbefore/after/patchとhash一覧、復元手順だけを作り、設定を上書きしません。CodexにAGENTS.override.mdがある場合は優先されるそのファイルを対象にします。管理範囲の区切りが壊れていれば準備を止めます。

準備結果を確認し、Mini本体とクライアント・新しい方針集約を先に導入した後、別途承認して設定を反映します。Codexのhook trustは本人の通常操作で行い、迂回しません。設定への反映後は新規・再開・compaction・次依頼・子タスクで実入力に全文が届くことを確認します。

ローカルconfigの追加例（パスは端末だけで管理し、Vaultや公開資料へ実パスを入れません）:

```json
{"policy":{"projectRoots":[{"path":"/absolute/path/worktree","projectId":"example-project"}]}}
```

最深の実パス境界で選びます。別worktreeは別登録、同根の複数IDはエラー、未登録は共通方針だけです。名前やgit remoteから推定しません。明示IDで読むときは`ctx policies --project example-project`、作業フォルダーで読むときは`ctx policies --cwd /absolute/path/worktree`です。どちらも読取専用でモデルを呼びません。

## 実行方式の違い

| 経路 | 用意する連携 | 確認状況・制限 |
|---|---|---|
| Codexのローカルorchestration/execution | SessionStart/UserPromptSubmit/SubagentStart | 合成stdin/stdoutを検証。additionalContextLimit:0と68KiB出力上限を併用。実セッションは導入後のゲート |
| Codexのcloud orchestration | 共通指示からCLIで全文読取 | ローカルcommand hookは非対応。自動注入と同等としない |
| Claude Code | 同じ3イベントのadditionalContext | 合成契約を検証。UserPromptSubmitは読取失敗をblock。子タスクは既存contextを保持する間は起動時の版を使い、compaction後の再注入はホスト仕様に従う。実セッションは別ゲート |
| OpenClaw 2026.9.9 | opt-in agentのbefore_prompt_build | 導入版SDKと合成APIで検証。Gateway/モデルでは未検証。context追加だけではツールや子タスクの停止を強制できない |

SessionStart/SubagentStartはホストによって停止を保証しません。失敗contextと共通指示で未読のまま変更・外部操作を始めないよう案内し、UserPromptSubmitが対応する経路では依頼をblockします。任意のAI実行環境全体に対する強制的なアクセス制御ではありません。復旧相談は続けられます。失敗を空の方針や古い成功キャッシュへ変えません。

方針の版は依頼開始時点のsnapshotです。次の依頼から更新版を読み、進行中のツール呼出へ割り込みません。過去の会話の文字列自体を消去せず、最新版にない旧IDを無効と明示します。

## OpenClaw

プラグイン設定の`policyAgents`は省略時に無効です。本人専用のagentだけを明示登録します。共有agentへ入れず、Discord経路では既存のchannel/sender/host許可設定も照合します。他agentや未許可利用者へ方針を追加しません。明示projectIdと作業フォルダーの対応が食い違えば読取失敗にします。

```json
{"policyAgents":[{"agentId":"private-agent","projectId":"example-project"}]}
```

`systemPrompt`を置換せず、`prependContext`へ過去の本人採用方針を渡します。OpenClaw本体はforkしません。設定変更、Gateway再起動、実Vault初回新形式書込、実モデル検証は具体差分を確認した別操作です。

## 根拠

[Codex hooks](https://learn.chatgpt.com/docs/hooks)、[共通指示](https://learn.chatgpt.com/docs/agent-configuration/agents-md)、[Claude Code hooks](https://code.claude.com/docs/en/hooks)、[Claude Code memory](https://code.claude.com/docs/en/memory)。OpenClawはインストール版2026.9.9のローカルdocsと公開型を正とします。
