#!/bin/sh
# Context Hub 実Vaultの日次スナップショット。
# Vault外の保存先へ tar.gz を原子的に作り、保持日数を過ぎた正規のスナップショットだけ削除する。
# 上書き: CTX_VAULT / CTX_BACKUP_DIR / CTX_BACKUP_KEEP_DAYS（既定 30）。
set -eu
umask 077
VAULT="${CTX_VAULT:-$HOME/ContextHub/vault}"
DEST="${CTX_BACKUP_DIR:-$HOME/ContextHub/backups}"
KEEP_DAYS="${CTX_BACKUP_KEEP_DAYS:-30}"
case "$KEEP_DAYS" in ''|*[!0-9]*) echo "保持日数が不正です: $KEEP_DAYS" >&2; exit 2;; esac
[ -d "$VAULT/00_inbox" ] || { echo "Vaultが見つかりません: $VAULT" >&2; exit 1; }
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
# 大小文字を同一視するファイルシステムでも、同じディレクトリを親に持つ保存先を拒否する。
ctx_ancestor=$DEST
while :; do
  if [ "$ctx_ancestor" -ef "$VAULT" ]; then
    echo "保存先がVaultの中です: $DEST" >&2
    exit 2
  fi
  [ "$ctx_ancestor" != / ] || break
  ctx_ancestor=${ctx_ancestor%/*}
  [ -n "$ctx_ancestor" ] || ctx_ancestor=/
done
mkdir -p "$DEST"
TS=$(date +%Y%m%d-%H%M%S)
TMP="$DEST/.vault-$TS.tar.gz.tmp"
OUT="$DEST/vault-$TS.tar.gz"
trap 'rm -f "$TMP"' EXIT
# 書き込み途中の一時ファイルは除外する。原文は一時ファイル→renameで公開されるため、tarには完成したファイルだけが入る。
tar --exclude='.ctx-tmp-*' --exclude='*.tmp' -czf "$TMP" -C "$VAULT" .
tar -tzf "$TMP" >/dev/null
mv "$TMP" "$OUT"
trap - EXIT
find "$DEST" -maxdepth 1 -type f -name 'vault-*.tar.gz' -mtime +"$KEEP_DAYS" -delete
COUNT=$(find "$DEST" -maxdepth 1 -type f -name 'vault-*.tar.gz' | wc -l | tr -d ' ')
echo "$(date '+%Y-%m-%dT%H:%M:%S%z') ok $OUT $(stat -f %z "$OUT") bytes kept=$COUNT"
