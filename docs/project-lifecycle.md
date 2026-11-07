# プロジェクトの状態とふりかえり

数日〜1週間あいた後に「何が動き、何が止まっているか」を確認するための機能です。どちらもモデルを使わず、受領・整理の記録から決定的に生成します。要約や抽出はAI生成・未検証のまま表示します。

## プロジェクトの状態

`project.md`の`status`は、本人が切り替える次の3つの状態を持ちます。

| status | 表示 | 扱い |
|---|---|---|
| `active` | 進行中 | HOMEの一覧に表示し、整理と再関連付けの帰属候補としてAIへ渡す |
| `paused` | 休止 | HOMEの「休止・完了」へまとめ、AIの帰属候補から外す |
| `done` | 完了 | 休止と同じ |

旧版で書いた`active`以外の自由記述は進行中として扱い、HOMEに元の値を併記します。休止・完了のプロジェクトでも、入力で人が明示した`--project`はそのまま帰属し、すでに付いている関連付けも保持します。休止・完了は、これから整理する入力へAIが提示する候補だけを変えます。AIが状態を変えることはなく、AIに状態変更の依頼ファイルを代作させないでください。

状態の変更は、確認した`project.md`のハッシュに結び付けて行います。ハッシュは`project list`で確認できます。

```sh
node packages/core/dist/cli.js --config "<設定ファイル>" project list
node packages/core/dist/cli.js --config "<設定ファイル>" project status <project-id> --set paused --hash <sha256> --confirm
```

[Mac・Androidアプリ](https://github.com/mozuq-lab/context-hub-flutter-client)の対応版からは`operation: project-status`の受付ファイルとして依頼し、次の`cycle`（または`ingest`）で反映します。0.3.0までのアプリは状態変更の依頼とREVIEW.mdの表示に対応していません。定義が確認後に変わっていた場合や、すでに同じ状態の場合は受け付けず、HOMEの「失敗と競合」に表示します。

変更は`project.md`のfrontmatterの`status`行だけを書き換え、ほかの行・コメント・改行は保持します。変更ごとに`90_system/project-status/PST-*.json`へ変更前後のハッシュを記録し、書き込み途中で停止しても、同じ受付ID（CLIでは同じ引数での再実行）で回復します。

状態を変えると`project.md`のハッシュが変わります。変更前のハッシュで確認していた採用先付き方針の候補は、再確認が必要になります。状態だけの変更では再関連付け（モデル呼び出し）は起きません。

## 名前・別名・キーワードの手入れ

AIがメモをどのプロジェクトに結び付けるかは、`project.md`の名前（`title`）・別名（`aliases`）・キーワード（`keywords`）に左右されます。作った後の定義は、状態と同じく確認したハッシュに結び付けて書き換えます。

```sh
node packages/core/dist/cli.js --config "<設定ファイル>" project list
node packages/core/dist/cli.js --config "<設定ファイル>" project edit <project-id> \
  --add-alias ベランダ菜園 --remove-keyword 栽培 --add-keyword 苗 --hash <sha256> --confirm
```

`--title`で名前を変え、`--add-alias`・`--remove-alias`・`--add-keyword`・`--remove-keyword`は何度でも指定できます。前後の空白を除き、大文字小文字や全角・半角だけが違う重複は最初の1つにまとめます。名前は1〜200文字、別名とキーワードはそれぞれ50件まで・1件100文字までです。定義にない語の削除や、変更のない指定は受け付けません。

[Mac・Androidアプリ](https://github.com/mozuq-lab/context-hub-flutter-client)の対応版からは`operation: project-definition`の受付ファイル（`project_id`・確認した`project_hash`・変更後の`title`・`aliases`・`keywords`の全体・`confirmed: true`、本文なし）として依頼し、次の`cycle`（または`ingest`）で反映します。定義が確認後に変わっていた場合は受け付けず、HOMEの「失敗と競合」に表示します。

書き換えるのは`title`・`aliases`・`keywords`だけで、ほかのキー・コメント・本文は保持します。変更ごとに`90_system/project-definitions/PDEF-*.json`へ変更前後の定義とハッシュを記録し、書き込み途中で停止しても、同じ受付ID（CLIでは同じ引数での再実行）で回復します。

定義が変わるとプロジェクト登録簿のハッシュが変わるため、帰属未確定のメモ（プロジェクトを指定せず、AIの確信度もしきい値未満だったもの）は、次の`cycle`で新しい定義に対する再関連付け（モデル呼び出し）の対象になります。件数は`cycle --limit`の枠に含まれます。

### 定義が壊れたとき

Obsidianなどで`project.md`を手で書き換えて形式が崩れると、プロジェクトの一覧を組み立てられません。不正な定義を除いて続けると登録簿のハッシュが変わり、帰属未確定の全メモが再関連付けの対象になってしまうため、ContextHubは整理を止め、モデルを呼びません。そのかわりに、どのファイルのどの項目が不正かを次の場所に示します。

- `ctx doctor`: `プロジェクト定義が不正です: 10_projects/<id>/project.md（別名（aliases））`のように、ファイルと項目を1件ずつ表示します。
- HOME: `cycle`・`dashboard`は「プロジェクト定義の不正」だけのHOMEを書き、直すべきファイルと項目を一覧にします。
- `cycle`などのコマンドのエラー: 同じファイルと項目を示します。

端末からのメモは受け付けて記録し、失われません（プロジェクトへの関連付けは定義を直すまで待ちます）。定義の不正があるあいだは、ほかのプロジェクトの名前・別名・キーワードの変更も受け付けません。定義を直すと、次の`cycle`で通常のHOMEに戻り、整理を再開します。

## 停滞の表示

HOMEの一覧には各プロジェクトの最終根拠（NOWの`last_evidence_at`）と経過日数を表示します。進行中で、最終根拠から`retrieve.staleDays`（既定14日）を超えたプロジェクトは「停滞しているプロジェクト」に分けて、長く止まっている順に並べます。再開するか、休止・完了にするかを判断する目安です。NOWが未生成のプロジェクトは停滞に含めません。

## ふりかえり（REVIEW.md）

`cycle`はHOMEの前にVault直下の`REVIEW.md`を生成し、HOMEからリンクします。単独では`digest`で生成できます。

```sh
node packages/core/dist/cli.js --config "<設定ファイル>" digest
node packages/core/dist/cli.js --config "<設定ファイル>" digest --days 30
```

既定の期間は直近`retrieve.digestDays`日（既定7日）です。次の内容を含みます。

- 期間内に届いた入力の件数（整理済み・整理待ち・整理失敗）と、プロジェクト未帰属の件数
- 動きのあったプロジェクトごとの新しい入力、主な入力の要約、「現在地」「次の一手」の変化
- 期間より前から残っている未解決（解決済みかは判定しません）
- 動きのなかった進行中のプロジェクトと、休止・完了のプロジェクト
- 確認待ちの候補と、候補が作られてからの日数

「現在地」「次の一手」の変化は、NOWと同じく最新の作業要約の確認済み項目を、期間開始の時点で有効だった解釈（開始までに届いた原文・訂正のうち最後に整理されたもの）と比べたものです。期間は受領日時で区切り、期間内に届いた訂正も入力として数えます。経過日数は24時間単位です。HOMEと同じく生成物として扱い、手で編集された`REVIEW.md`は上書きせず`90_system/conflicts/`へ退避します。
