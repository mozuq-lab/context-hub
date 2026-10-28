---
name: ctx_recent
description: Context Hubに最近保存した入力を表示する。
user-invocable: true
disable-model-invocation: true
command-dispatch: tool
command-tool: ctx_recent
command-arg-mode: raw
---

`/ctx_recent [件数]` で最近の入力を取得します。件数は1〜50、省略時10です。引数は `ctx_recent` ツールへ直接渡します。
