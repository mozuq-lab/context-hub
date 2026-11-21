#!/bin/sh
# Context Hub 実Vaultの日次スナップショット。
# Vault外の保存先へ tar.gz を原子的に作り、保持日数を過ぎた正規のスナップショットだけ削除する。
# 上書き: CTX_VAULT / CTX_BACKUP_DIR / CTX_BACKUP_KEEP_DAYS（既定 30）。
# 暗号化（任意）: CTX_BACKUP_AGE_RECIPIENTS にageの受取人（公開鍵 age1…）のファイルを指定すると、
# vault-日付-時刻.tar.gz.age を作る。指定しなければ今までどおり暗号化しない tar.gz を作る。
# CTX_BACKUP_AGE はageのコマンド（既定 age。launchdではPATHが短いため絶対パスにする）。
# CTX_BACKUP_WORK_DIR は暗号化の前に平文のtar.gzを一時的に置く親フォルダー（既定 TMPDIR、なければ /tmp）。
set -eu
umask 077
VAULT="${CTX_VAULT:-$HOME/ContextHub/vault}"
DEST="${CTX_BACKUP_DIR:-$HOME/ContextHub/backups}"
KEEP_DAYS="${CTX_BACKUP_KEEP_DAYS:-30}"
case "$KEEP_DAYS" in ''|*[!0-9]*) echo "保持日数が不正です: $KEEP_DAYS" >&2; exit 2;; esac
[ -d "$VAULT/00_inbox" ] || { echo "Vaultが見つかりません: $VAULT" >&2; exit 1; }
RECIPIENTS="${CTX_BACKUP_AGE_RECIPIENTS:-}"
AGE="${CTX_BACKUP_AGE:-age}"
WORK_PARENT="${CTX_BACKUP_WORK_DIR:-${TMPDIR:-/tmp}}"
if [ -n "$RECIPIENTS" ]; then
  [ -f "$RECIPIENTS" ] && [ -r "$RECIPIENTS" ] || { echo "暗号化の受取人ファイルを読めません: $RECIPIENTS" >&2; exit 2; }
  # 秘密鍵を受取人ファイルとして渡す取り違えは、秘密鍵をMac miniの設定に残す原因になるため止める。
  if grep -q 'AGE-SECRET-KEY-' "$RECIPIENTS"; then echo "受取人ファイルに秘密鍵が入っています。公開鍵（age1…）だけを書いたファイルを指定してください" >&2; exit 2; fi
  grep -q '^[[:space:]]*age1' "$RECIPIENTS" || grep -q '^[[:space:]]*ssh-' "$RECIPIENTS" || { echo "受取人ファイルに公開鍵（age1…）がありません: $RECIPIENTS" >&2; exit 2; }
  command -v "$AGE" >/dev/null 2>&1 || { echo "ageのコマンドが見つかりません: $AGE（CTX_BACKUP_AGEに絶対パスを指定してください）" >&2; exit 2; }
fi
# 存在する各要素のリンクを解決する。未作成の保存先も、mkdirの前に同じ基準で比較する。
physical_directory_path() {
  ctx_remaining=$1
  case "$ctx_remaining" in /*) ;; *) ctx_remaining="$(pwd -P)/$ctx_remaining";; esac
  ctx_resolved=/
  while [ -n "$ctx_remaining" ]; do
    ctx_component=${ctx_remaining%%/*}
    case "$ctx_remaining" in */*) ctx_remaining=${ctx_remaining#*/};; *) ctx_remaining=;; esac
    case "$ctx_component" in
      ''|.) ;;
      ..) ctx_resolved=${ctx_resolved%/*}; [ -n "$ctx_resolved" ] || ctx_resolved=/;;
      *)
        ctx_next="${ctx_resolved%/}/$ctx_component"
        if [ -d "$ctx_next" ]; then
          ctx_resolved=$(CDPATH= cd -P "$ctx_next" && pwd -P) || return 2
        elif [ -e "$ctx_next" ] || [ -L "$ctx_next" ]; then
          echo "ディレクトリとして解決できません: $1" >&2
          return 2
        else
          ctx_resolved=$ctx_next
        fi
        ;;
    esac
  done
  printf '%s\n' "$ctx_resolved"
}
VAULT=$(physical_directory_path "$VAULT")
DEST=$(physical_directory_path "$DEST")
# 大小文字を同一視するファイルシステムでも、同じディレクトリを親に持つ場所を拒否する。
# reject_inside <場所> <基準のフォルダー> <メッセージ>
reject_inside() {
  ctx_ancestor=$1
  while :; do
    if [ "$ctx_ancestor" -ef "$2" ]; then
      echo "$3: $1" >&2
      exit 2
    fi
    [ "$ctx_ancestor" != / ] || break
    ctx_ancestor=${ctx_ancestor%/*}
    [ -n "$ctx_ancestor" ] || ctx_ancestor=/
  done
}
reject_inside "$DEST" "$VAULT" 保存先がVaultの中です
if [ -n "$RECIPIENTS" ]; then
  WORK_PARENT=$(physical_directory_path "$WORK_PARENT")
  [ -d "$WORK_PARENT" ] || { echo "一時フォルダーが見つかりません: $WORK_PARENT" >&2; exit 2; }
  # 暗号化の前の平文を、同期されるVaultや、別の場所へ複製するかもしれない保存先に置かない。
  reject_inside "$WORK_PARENT" "$VAULT" 一時フォルダーがVaultの中です
  # 保存先がまだないときは、パスの文字列で比べる。
  case "$WORK_PARENT/" in "$DEST"/*) echo "一時フォルダーが保存先の中です: $WORK_PARENT" >&2; exit 2;; esac
  reject_inside "$WORK_PARENT" "$DEST" 一時フォルダーが保存先の中です
  # 電源断などで前回の後片付けができずに残った平文（2日以上前のもの）を消す。
  find "$WORK_PARENT" -maxdepth 1 -type d -name 'ctx-backup-??????' -user "$(id -u)" -mtime +1 -exec rm -rf {} + 2>/dev/null || true
fi
# 中断（Ctrl-C・launchdの停止など）でも、EXITの後片付けで一時ファイルと平文を消してから終わる。
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$DEST"
TS=$(date +%Y%m%d-%H%M%S)
# 書き込み途中の一時ファイルは除外する。原文は一時ファイル→renameで公開されるため、tarには完成したファイルだけが入る。
# Writerロックは取らない。複数のファイルにまたがる操作の途中の状態が入りうるが、各操作は記録を先に書き、
# 復元後のcycle（停止回復）で続きを行う。整合した復元点が必要なときはWriterと同期を止めてから実行する（docs/operations.md）。
if [ -n "$RECIPIENTS" ]; then
  TMP="$DEST/.vault-$TS.tar.gz.age.tmp"
  OUT="$DEST/vault-$TS.tar.gz.age"
  WORK=$(mktemp -d "$WORK_PARENT/ctx-backup-XXXXXX")
  trap 'rm -f "$TMP"; rm -rf "$WORK"' EXIT
  # 平文のtar.gzは一時フォルダーで作って読めることを確かめ、暗号化した結果だけを保存先へ置く。
  tar --exclude='.ctx-tmp-*' --exclude='*.tmp' -czf "$WORK/vault.tar.gz" -C "$VAULT" .
  tar -tzf "$WORK/vault.tar.gz" >/dev/null
  "$AGE" -e -R "$RECIPIENTS" -o "$TMP" "$WORK/vault.tar.gz"
  [ -s "$TMP" ] || { echo "暗号化したアーカイブが空です" >&2; exit 1; }
  rm -rf "$WORK"
  mv "$TMP" "$OUT"
else
  TMP="$DEST/.vault-$TS.tar.gz.tmp"
  OUT="$DEST/vault-$TS.tar.gz"
  trap 'rm -f "$TMP"' EXIT
  tar --exclude='.ctx-tmp-*' --exclude='*.tmp' -czf "$TMP" -C "$VAULT" .
  tar -tzf "$TMP" >/dev/null
  mv "$TMP" "$OUT"
fi
trap - EXIT
# 暗号化したものとしないものは、どちらも同じ保持日数で消す（途中で暗号化に切り替えても古い平文が残り続けない）。
find "$DEST" -maxdepth 1 -type f \( -name 'vault-*.tar.gz' -o -name 'vault-*.tar.gz.age' \) -mtime +"$KEEP_DAYS" -delete
COUNT=$(find "$DEST" -maxdepth 1 -type f \( -name 'vault-*.tar.gz' -o -name 'vault-*.tar.gz.age' \) | wc -l | tr -d ' ')
# statの書式はBSDとGNUで異なるため、バイト数はwc -cで数える。
SIZE=$(wc -c < "$OUT" | tr -d ' ')
echo "$(date '+%Y-%m-%dT%H:%M:%S%z') ok $OUT $SIZE bytes kept=$COUNT"
