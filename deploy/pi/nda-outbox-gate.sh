#!/usr/bin/env bash
# nda-outbox-gate.sh: 事務所の PC が SSH で Pi の送り箱へ取りに来るときの門番（#53・#56、office/box/pull.py が相手）。
#   事務所の PC の鍵は、Pi の取り出し用のユーザー（例 nda-pull。nda グループ）の authorized_keys に、次の形でだけ登録する:
#     command="/usr/local/bin/nda-outbox-gate /var/lib/nda/outbox",restrict ssh-ed25519 AAAA... nda-office
#   restrict でシェル・転送・pty を閉じ、command= で、事務所の PC が何を頼んでもこのスクリプトだけが動く。
#   受けるのは SSH_ORIGINAL_COMMAND の次の 3 つだけ。名前は <uuid>.json の形だけ（それ以外は何もせず終わる）。
#     list          送り箱の <uuid>.json の名前（. で始まる書きかけは出さない）。50 件まで
#     get <名前>    その中身（256KB まで。リンクは読まない）
#     ack <名前>    受け取った印に、送り箱の中で .sent-<名前> へ名前を変える（もう無ければ何もしない）。7 日で消す
#                   別のフォルダへは移さない（移す先を差し替えられて外へ出る道をなくす。Codex の指摘）
#   送り箱は本体（nda-app）が書く。nda-app:nda 2770 のフォルダに、. で始まる一時の名前で書いて rename し、
#   ファイルは 0640（nda グループが読める）にする。
set -euo pipefail
umask 027

OUTBOX="${1:-/var/lib/nda/outbox}"
MAX_BYTES=262144
NAME_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$'
cmd="${SSH_ORIGINAL_COMMAND:-}"

[ -d "$OUTBOX" ] && [ ! -L "$OUTBOX" ] || exit 3

name_ok() { [[ "$1" =~ $NAME_RE ]]; }

case "$cmd" in
  list)
    find "$OUTBOX" -mindepth 1 -maxdepth 1 -type f -name '*.json' -printf '%f\n' \
      | { grep -E "$NAME_RE" || true; } | sort | awk 'NR <= 50'  # head だと多いとき sort が SIGPIPE で落ちる（Codex の指摘）
    ;;
  "get "*)
    n="${cmd#get }"
    name_ok "$n" || exit 2
    f="$OUTBOX/$n"
    [ -f "$f" ] && [ ! -L "$f" ] || exit 4
    # 確かめた後に差し替えられても外を読まないよう、先に開き、開いた先が送り箱のそのファイルかを確かめてから読む（Codex の指摘）
    exec 3<"$f" || exit 4
    [ "$(readlink -- "/proc/$$/fd/3")" = "$(realpath -- "$OUTBOX")/$n" ] || exit 4
    [ -f "/proc/$$/fd/3" ] || exit 4
    head -c "$((MAX_BYTES + 1))" <&3  # 大きいものは 256KB＋1 で切る。事務所の PC が「大きすぎる」で断る
    ;;
  "ack "*)
    n="${cmd#ack }"
    name_ok "$n" || exit 2
    f="$OUTBOX/$n"
    if [ -f "$f" ] && [ ! -L "$f" ]; then
      mv -T -f -- "$f" "$OUTBOX/.sent-$n"  # 同じフォルダの中の名前の付け替え。-T で、先がリンクでもたどらない
    fi
    find "$OUTBOX" -mindepth 1 -maxdepth 1 -type f -name '.sent-*.json' -mtime +7 -delete 2>/dev/null || true
    ;;
  *)
    exit 64
    ;;
esac
