# 導入手順

まずREADMEのデモを試し、生成物と原文が分かれていることを確認してください。以下は自分の環境へ手動で導入する手順です。設定例とテンプレートは、そのまま常駐サービスへ登録しません。

## 1. Vaultと設定を決める

実データのない専用フォルダーを選びます。Vault、statePath、logging.dir、バックアップを分離してください。設定例は`examples/config.production.json`（mock）と`config.production.openclaw-infer.json`（実AI用）です。`YOUR_DISCORD_USER_ID`は自分の値へ置換し、Discordを使わない場合はcapture.allowedSenderIdsを空配列にできます。

設定ファイルをリポジトリの外へコピーし、パスと値を確認します。下記の山括弧は実際の値へ置き換えます。

```sh
node packages/core/dist/cli.js --config "<設定ファイルの絶対パス>" init
node packages/core/dist/cli.js --config "<設定ファイルの絶対パス>" doctor
```

最初はprovider=mockを使います。実AIへ切り替える場合は、モデルへ送る内容と利用枠・料金を確認し、設定済みのOpenClawを使うopenclaw-inferへ変更します。配布する設定例はagentを指定せず、OpenClawの設定済みの既定モデル/エージェントを使います。organize.llm.agentを追加する場合は、実在してモデル設定済みのIDを指定してください。ファイル入力だけで利用するためにDiscord用hubを新設する必要はありません。常駐実行ではPATHに依存せず、organize.llm.executableへ`command -v openclaw`で確認した実行ファイルの絶対パスを設定します。

## 2. ファイル同期と入力を設定する

Syncthingで新しいVaultを共有し、各端末は専用フォルダーで受け入れます。標準の除外例は[examples/syncthing.stignore](../examples/syncthing.stignore)です。除外は端末ごとに確認し、Input、90_system、HOMEを同期対象に残します。サンプルと実Vaultは別の共有にしてください。

以下の配布物をVaultへコピーします。

| ソース | Vault内の配置先 |
|---|---|
| examples/quickadd/context-hub.js | _ContextHub/scripts/context-hub.js |
| scripts/submit-input.mjs | _ContextHub/scripts/submit-input.mjs |
| examples/quickadd/templates/ | _ContextHub/templates/ |
| docs/prompts/file-input.md | _ContextHub/docs/file-input.md |
| docs/prompts/handoff-summary.md | _ContextHub/docs/handoff-summary.md |
| examples/vault-instructions/AGENTS.md | AGENTS.md |
| examples/vault-instructions/CLAUDE.md | CLAUDE.md |

各端末のObsidianでQuickAddを登録します。[QuickAdd手順](../examples/quickadd/README.md)を参照してください。モバイルでは同期アプリの提供状況と、Obsidianから共有フォルダーへアクセスできることを自分の端末で確認します。

Codex・Claude Codeは[Vault参照手順](prompts/vault-access.md)に従い、この端末の実パスで開きます。端末保存、同期、Miniの受領、AI整理は別の状態です。HOMEで確認してください。

## 3. Miniで受付と整理を試す

初回は確認用の短いメモだけを保存し、mockで受付からHOMEまで確認します。

```sh
node packages/core/dist/cli.js --config "<設定ファイルの絶対パス>" cycle --limit 2
node packages/core/dist/cli.js --config "<設定ファイルの絶対パス>" doctor
```

保存直後2秒未満のREQは書き込み安定待ちで次回へ回ります。失敗・競合・訂正未反映を確認し、原文を直接編集して解消しないでください。

実AIを試すときは入力IDを固定し、`organize --id <IN-ID> --limit 1 --thinking low --dry-run`で対象を確認します。その後、意図した送信と利用枠の消費を確認してdry-runなしで実行し、dashboardとdoctor、結果の同期を確認します。成功済みメモを実AIで再実行して検証し直しません。

## 4. OpenClaw連携を追加する場合

互換宣言は範囲で持ち、検査済み版はSDKスクリプトで別に管理します。導入版の公式docsと型で確認し、未検証版を推測で有効にしません。ホスト導入環境では[追加SDK検査](development.md)を実行します。

Discord入口を使う場合、既存OpenClawのDiscordが有効で、groupPolicyがallowlist、本人のメッセージを受け取れる状態を先に確認します。この条件を満たさない設定では補助スクリプトは停止します。トークンや既存の認可設定を推測で追加しません。

専用channel、guild、許可ユーザーのIDを自分の値で明示します。`--hub-config`には手順1でCLIに指定した同じHub設定ファイルの絶対パスを渡します。次は差分の生成例であり、設定を適用しません。

```sh
node scripts/openclaw-proposal.mjs "<既存OpenClaw設定の絶対パス>" --hub-config "<手順1と同じHub設定の絶対パス>" --guild-id "<guild ID>" --channel-id "<channel ID>" --allowed-sender-id "<本人のuser ID>"
```

複数の許可ユーザーは`--allowed-sender-id`を繰り返します。IDは17〜20桁の文字列です。この補助スクリプトは明示mainと追加hubの限定構成だけを扱い、未知のエージェント構成や既存値の競合では止まります。出力内容と既存経路への影響を確認し、設定バックアップを取ってから自分の環境へ手動で適用してください。

プラグインのリンク先はこのrepoの`packages/openclaw-plugin`です。導入版の`openclaw plugins install --link`等の手順に従います。

続いてhubの実設定でworkspaceを確認し、次のファイルを配置します。補助スクリプトの提案先は`~/.openclaw/workspace-hub`ですが、設定差分を適用するだけではファイルは配置されません。

| ソース | hub workspace内の配置先 |
|---|---|
| examples/openclaw-workspace/AGENTS.md | AGENTS.md |
| examples/openclaw-workspace/skills/ | skills/（各ctx_*のSKILL.mdを保持） |

リポジトリのルートで実行する例です。workspaceを変更した場合は変数を合わせてください。既存のAGENTS.mdや同名スキルはコピーせず保持するため、先に差分を確認し、必要な内容を自分で統合します。mainや別エージェントのworkspaceへコピーしないでください。

```sh
CTX_HUB_WORKSPACE="$HOME/.openclaw/workspace-hub"
for CTX_HUB_FILE in examples/openclaw-workspace/AGENTS.md examples/openclaw-workspace/skills/*/SKILL.md; do
  CTX_HUB_REL=${CTX_HUB_FILE#examples/openclaw-workspace/}
  CTX_HUB_TARGET="$CTX_HUB_WORKSPACE/$CTX_HUB_REL"
  if [ -e "$CTX_HUB_TARGET" ] || [ -L "$CTX_HUB_TARGET" ]; then
    printf '既存ファイルを保持: %s\n' "$CTX_HUB_TARGET"
    continue
  fi
  mkdir -p "$(dirname "$CTX_HUB_TARGET")"
  cp -n "$CTX_HUB_FILE" "$CTX_HUB_TARGET"
done
```

設定と配置を確認後、サービス再起動や実接続は影響を確認してから実施します。導入版の公式手順で`openclaw skills list --agent hub`等を使い、hubからctx_find、ctx_resume、ctx_recent、ctx_pending、ctx_helpの5スキルが見えることを確認してください。Discordのコマンド一覧への登録も確認し、本人用チャンネルで`/ctx_help`と`/ctx_find <確認用キーワード>`を試します。表示されない場合はworkspaceとスキルの読み込み、`commands.nativeSkills`等の導入版の設定を調べ、通常モデルの返信をコマンド実行成功と扱わないでください。

## 5. 定期化と自動起動

手動での受付・実AI整理・結果返送を確認後、導入版のOpenClaw automationsでcommandジョブを登録します。nodeとCLIは絶対パス、設定はCONTEXT_HUB_CONFIGで指定し、初回はdisabledで内容を確認します。

構成例は60分ごと、`cycle --limit 2 --thinking low --quiet-empty`、300秒、通知なしです。既存IDを記録して二重登録せず、最初の自然な自動実行を履歴とHOMEで確認します。モデル不要の受付は設定のmaxItemsPerRun、AI処理枠はlimitで別に制限されます。

launchdの例は`examples/launchd/`にあります。`__HOME__`、`__REPO_PATH__`、`__SYNCTHING_BIN__`、`__SYNCTHING_PROFILE_PATH__`を実際の絶対パスへ置換し、既存プロファイルや端末IDを確認してから使用します。バックアップ用の`__VAULT_PATH__`と`__BACKUP_DIR__`は、手動バックアップで確認した同じVault・保存先にします。EnvironmentVariablesの保持日数も確認します。未展開のテンプレートをそのまま登録しないでください。

XMLの特殊文字を含むパスは適切にエスケープし、展開したplistを`plutil -lint`で検査してから登録します。
