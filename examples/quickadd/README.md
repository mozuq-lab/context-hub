# ObsidianとQuickAddでContextHubへ入力する

各端末のVaultをSyncthingの「送受信」で共有し、ObsidianでそのVaultを開く。入力は `Input/` へ新規保存する。原文・プロジェクト定義・生成物はMac miniが管理する。

## 設定する操作

1. 各端末でQuickAddをインストールし有効にする。
2. `context-hub.js` をVaultの `_ContextHub/scripts/context-hub.js` へコピーする。隠しフォルダや `.obsidian/` へ置かない。
3. QuickAdd設定で下表のMacro Choiceを作る。Macro BuilderのUser Scriptでファイルを選び、公開関数を `context-hub::関数名` として指定する。
4. 各Choiceの稲妻を有効にし、コマンドパレットやモバイルのツールバーへ登録する。

| 名前 | 公開関数 | 操作 |
|---|---|---|
| メモ追加 | `captureMemo` | 複数行の自由入力 |
| 作業要約追加 | `captureSummary` | AIの作業報告を貼り付け |
| 入力を訂正 | `correctInput` | 同期済みの最新IDを選んで訂正文を入力 |
| プロジェクト案を承認 | `approveProject` | 候補を選び、詳細を確認して承認 |
| プロジェクト案を却下 | `rejectProject` | 候補を選び、確認して却下 |

キャンセル時はファイルを作らない。本文は1〜8000文字。保存通知は端末内の保存を表し、Miniの受領・整理完了は同期された `HOME.md` で確認する。承認情報や根拠が未同期なら操作を止める。古い候補はMini側でも拒否する。

別端末の訂正が先に登録された場合、HOMEの受付失敗欄に古い対象だったことと最新IDを表示する。結果を再同期して「入力を訂正」で最新対象を選び、新しい要求として送る。既存の受付ファイルを直接編集しない。

承認時の内容照合はWebCrypto、読み書きはObsidian Vault APIを使う。Nodeのrequireと外部通信は使わない。Androidでは2026-10-11にサンプルVaultとMockでメモ・作業要約・訂正・プロジェクト案承認の保存から結果表示まで確認済み。iOSの実UIと本番Vaultでの操作は未確認で、導入時に確認する。ファイル選択や確認ダイアログはAPI相当の自動テストでも検証している。

モバイルでJSファイルを編集しづらい場合は、ノートへJS全体を通常の `js` コードブロックで入れ、そのノートのパス `::captureMemo` などをUser Scriptに指定できる。[QuickAdd公式のユーザースクリプト](https://quickadd.obsidian.guide/docs/UserScripts/)

## 標準テンプレートだけでメモを追加する場合

`templates/memo.md` または `templates/work-summary.md` をVaultの `_ContextHub/templates/` へコピーし、Template Choiceのテンプレートに指定する。作成先を `Input`、ファイル名を `REQ-{{RANDOM:32}}` とする。ファイル名の固定IDは `{{TITLE}}` から本文内へ渡す。複数行入力・訂正・承認には上のMacroを使う。

## 設定の同期

共有スクリプト・テンプレートはVault内なので同期する。初期設定では `.obsidian/` を全体除外し、QuickAddのChoiceを各端末で登録する。端末別ワークスペースや有効プラグイン設定を相互に上書きしない。設定を後から共有する場合はQuickAdd公式のパッケージexport/importで内容を確認して行う。秘密情報やOpenClaw設定をVaultへ置かない。

同期端末とローカルプロセスを信頼する運用を前提とする。確認トークンは表示内容を結び付ける情報であり、同じVaultへ任意書き込みできるプログラムへの本人認証ではない。AIには承認操作を自動発行させない。

API参照: [QuickAdd API](https://quickadd.obsidian.guide/docs/QuickAddAPI/)、[Obsidian公開API](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)。
