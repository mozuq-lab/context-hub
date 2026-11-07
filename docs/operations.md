# 運用・停止・バックアップ・復元

## 普段の確認

HOMEで受領、整理待ち、失敗、競合、停滞しているプロジェクトを確認します。数日あいたときは[REVIEW.md](project-lifecycle.md#ふりかえりreviewmd)で直近の変化を確認します。片付いた次の一手・未解決は[完了・解決](work-records.md)として報告し、コミット履歴から作った[作業記録の下書き](work-records.md#コミット履歴からの作業記録の下書き)はHOMEで確認します。NOWは生成時点と最終根拠の日時を持つビューです。同期100%と本人の表示確認、AI内容の正しさはそれぞれ別に確認します。

```sh
node packages/core/dist/cli.js --config "<設定ファイル>" doctor
node packages/core/dist/cli.js --config "<設定ファイル>" pending
node packages/core/dist/cli.js --config "<設定ファイル>" find "<検索語>"
node packages/core/dist/cli.js --config "<設定ファイル>" find --project "<project-id>" --kind memo,work-summary --since 2026-10-01
node packages/core/dist/cli.js --config "<設定ファイル>" context "<project-id>" --max-chars 6000
node packages/core/dist/cli.js --config "<設定ファイル>" digest
```

`find`は空白区切りの語をすべて含む記録を、一致数の多い順に最大50件返します。`--project`（帰属・関連するプロジェクト。AI推定の関連は「関連候補（AI推定、帰属未確定）」と表示）、`--kind`（`memo`・`work-summary`・`correction`・`idea`・`knowledge`・`now`のカンマ区切り）、`--since`・`--until`（`YYYY-MM-DD`は日本時間の日付、またはタイムゾーン付き日時）で絞り込めます。絞り込み条件があれば検索語は省略でき、その場合は新しい順に並べます。`--sort newest`で新しい順、`--limit`（1〜200）と`--offset`で続きを読めます。期間と新しい順は、原文は発生日時、NOWは最終根拠の日時、アイデアは元のメモの発生日時、知識は採用日時で判断します。共通の知識はプロジェクトで絞り込んだ結果に含めず、分類を取り消したアイデアは`--kind idea`に含めません。

原文や生成物を手動で書き換える前に、訂正履歴と競合を確認してください。生成物の競合は[生成版に戻す](#nowの更新が止まったとき生成物の競合)手順で片付け、退避ファイルを手で削除しないでください。同期による削除はほかの端末にも伝わるため、同期だけをバックアップとして扱いません。

## NOWの更新が止まったとき（生成物の競合）

NOW・HOME・REVIEWの生成領域を手で書き換えると、本体は手で書いた内容を上書きせず、新しい生成版を`90_system/conflicts/`へ退避します。そのNOWは手で書き換えた時点から更新されません。HOMEの「失敗と競合」に「NOWの更新が止まっています」と出たら、差分を確認して生成版に戻します。

```sh
node packages/core/dist/cli.js --config "<設定ファイル>" conflict list
node packages/core/dist/cli.js --config "<設定ファイル>" conflict resolve 10_projects/<project-id>/NOW.md --hash <sha256> --confirm
```

- `conflict list`は対象ごとに、最新の退避、止まった時点、確認用ハッシュ、手で変えた行を表示します。手で変えた行は、最後に書いたNOWの自動領域（`90_system/now-generated/`）と比べます。基準がない旧版のNOWは最新の退避と比べるため、生成側の変化も含まれることがあります。
- `resolve`はNOWで手で変えた行を、そのプロジェクトのメモ（`memo`）として先に保存します。保存しない場合は`--no-memo`を付けます。次に最新の入力からNOWを作り直し（自動領域の外の手動領域は保持）、退避を`90_system/conflict-archive/`へ移します。置き換える前の全文は`90_system/conflict-resolutions/CRS-*.json`に残ります。
- HOME.md・REVIEW.mdは派生の一覧なので、メモは作らずに作り直します。それ以外（アイデア・候補など）の競合は対象外です。
- 確認後に対象が変わっていれば受け付けません。アプリからは`operation: conflict-resolve`（`target`、`target_hash`、`confirmed: true`）の受付ファイルで依頼します。
- 同じ対象の退避は再生成のたびに増やさず、最新の1件を書き直します。

本人のメモはNOWの自動領域の外（手動領域）に書けば、再生成しても保持されます。

## 停止と再開

導入時に登録したジョブID・サービス・プロファイルを記録します。定期ジョブの状態は、導入版の`openclaw automations get <job-id>`で確認し、停止は同じIDのdisableを使います。取得や状態確認のためにモデルを実行する必要はありません。

SyncthingがKeepAliveで管理されている場合、GUIの終了だけでは再起動されることがあります。登録元のサービス管理から停止し、同じプロファイルの親子プロセスがすべて終了してから再開します。起動済みの同じプロファイルを別の方法でも起動しません。

ロック残骸がある場合は、全Writer停止と所有PIDの終了を確認してからdoctorのunlock手順を検討します。doctorはWriterロックと整理用ロックを区別して報告し、`--unlock`は両方の死亡PIDの残骸を回収します。設定の`organize.lockStaleSec`は使われていないため、設定例から削除しました。旧設定に残っていても読み込めます。稼働中のロックを手動削除しません。失敗した整理の再試行は対象と送信情報を確認して`--retry-failed`を明示し、成功済み入力を繰り返しモデルへ送らないでください。

## バックアップ

`scripts/vault-backup.sh`はmacOS向けの例です。BSD statとtarを使い、既定30日を超えた所定名のアーカイブを削除します。保存先と保持日数を確認し、必要なら別媒体にも複製してください。このスクリプト自身はWriterや同期を停止しません。

整合した復元点を作るときは、まずWriterと同期を止め、書き込みがないことを確認します。実行例のパスを自分のものへ置換してください。

```sh
CTX_VAULT="<Vaultの絶対パス>" CTX_BACKUP_DIR="<Vault外のバックアップ先>" CTX_BACKUP_KEEP_DAYS=30 sh scripts/vault-backup.sh
```

launchd例を使う場合は、EnvironmentVariablesの`__VAULT_PATH__`と`__BACKUP_DIR__`へ、上の手動実行と同じ値を指定し、保持日数も確認してから登録します。バックアップには個人情報が含まれるため、ソースrepoや同期Vaultへ保存しません。

## 復元テスト

1. 信頼できるアーカイブのハッシュと一覧を確認し、絶対パス、親ディレクトリへ抜けるパス、リンク、特殊ファイルがないことを確認する。
2. 元Vaultを上書きせず、同期対象外の新しい空フォルダーへ展開する。
3. 別の設定・state・ログを用意し、provider=mockと復元先の絶対パスを明示する。
4. 展開後の正本ファイルのハッシュ、doctor、検索、プロジェクト再開、訂正・承認履歴を確認する。
5. 切り替えの対象と影響を確認してから、Writerと同期を再開する。

macOSのtarにはAppleDouble付加メタデータが含まれる場合があります。別の展開方法で`._`ファイルが現れたときは、原文やJSON記録と混同せず、内容を確認してVault外へ保全します。doctorのエラーを消すために正本を削除・改変しないでください。

古い実装へ戻す場合、新しい形式のreceiptや訂正記録をそのまま渡せるとは限りません。読む全ファイルの形式と内容を旧版で確認するか、別Vaultへ旧スナップショットを復元して検証します。

## 情報と費用

Discord入口の本文はDiscordを経由し、実AI整理の対象原文・出典・プロジェクト定義は設定済みのモデルで処理されます。Codex・Claude Codeが直接読んだ本文も、それぞれ選択したモデルで扱われます。必要な範囲だけを参照し、秘密情報や全文履歴を集めません。

CLIのタイムアウトがGateway側の推論停止や課金停止まで保証するものではありません。厳密な費用上限はモデル提供側の設定と契約でも確認してください。ローカルのプロセス引数や同期フォルダーを読める利用者・プログラムは信頼する運用を前提とします。
