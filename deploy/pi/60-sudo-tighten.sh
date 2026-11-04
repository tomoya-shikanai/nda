#!/usr/bin/env bash
# 60-sudo-tighten.sh: パスワードなしの sudo を systemctl・reboot・apt だけに絞る（docs/pi-setup.md §3-5、§6-6）
#   /etc/sudoers.d/020_nda-tight を作り、Imager が作る全許可の 010_pi-nopasswd を無効にする
#   （削除せず 010_pi-nopasswd.nda-disabled に改名。名前に "." があるファイルは sudo が読まない）。
#   apt は apt-get も含める（apt の中身は apt-get と同じ仕事。SETENV は DEBIAN_FRONTEND を渡すため）。
#   パスワード付きの sudo は %sudo グループ経由で残る（締め出されない）。
# 流し方: ssh nda-pi 'bash -s' < deploy/pi/60-sudo-tighten.sh   （最後の段。他のセットアップが済んでから）
# 流した後は、10・30・40 など sudo で書くスクリプトはパスワードなしでは流せない。README の戻し方を見る。
#
# 実機で確かめる:
#   - 010_pi-nopasswd という名前が OS の版で同じか（ls /etc/sudoers.d）
#   - /etc/sudoers 本体や他のファイルに NOPASSWD が無いか（このスクリプトが一覧を出す）
#   - reboot / systemctl / apt の実体のパス（type -P で拾う）
set -euo pipefail

say() { printf '%s\n' "$*"; }
TIGHT=/etc/sudoers.d/020_nda-tight
OLD=/etc/sudoers.d/010_pi-nopasswd

main() {
  if ! sudo -n true 2>/dev/null; then
    # すでに絞られた後かもしれない
    if sudo -n "$(type -P systemctl)" --version >/dev/null 2>&1; then
      say "[済] すでに絞られている（sudo -n true は拒否、systemctl は通る）"
      exit 0
    fi
    say "[失敗] パスワードなしの sudo が使えない。Pi 上で sudo 付きの手で状態を確認"
    exit 1
  fi

  sc=$(type -P systemctl); rb=$(PATH="$PATH:/usr/sbin:/sbin" type -P reboot)
  ap=$(type -P apt); ag=$(type -P apt-get)
  rule="nda ALL=(root) NOPASSWD: ${sc}, ${rb}, SETENV: ${ap}, ${ag}"
  content=$(printf '# deploy/pi/60-sudo-tighten.sh が管理する（手で編集しない）\n%s' "$rule")

  # 1. 新しい規則を先に置く（検証してから入れる）
  if [ -f "$TIGHT" ] && [ "$(sudo cat "$TIGHT")" = "$content" ]; then
    say "[済] ${TIGHT}"
  else
    tmp=$(mktemp)
    printf '%s\n' "$content" > "$tmp"
    if ! sudo visudo -cf "$tmp" >/dev/null; then
      rm -f "$tmp"; say "[失敗] sudoers の文法エラー。何も変えていない"; exit 1
    fi
    sudo install -m 440 -o root -g root "$tmp" "$TIGHT"
    rm -f "$tmp"
    say "[変更] ${TIGHT}: ${rule}"
  fi

  # 2. 他に NOPASSWD が残っていないか（表示だけ。無効化の前に読む。後だと sudo が通らない）
  others=$(sudo grep -rn 'NOPASSWD' /etc/sudoers /etc/sudoers.d 2>/dev/null | grep -v "^${TIGHT}:" | grep -v "^${OLD}:" | grep -v ':[0-9]*:#' || true)
  if [ -n "$others" ]; then
    say "[警告] 他に NOPASSWD の記述が残っている（実機で確かめる）:"
    printf '%s\n' "$others" | sed 's/^/    /'
  fi

  # 3. 全許可の規則を無効にする
  if [ -f "$OLD" ]; then
    sudo mv "$OLD" "${OLD}.nda-disabled"
    say "[変更] ${OLD} を ${OLD}.nda-disabled に改名した（無効）"
  else
    say "[済] ${OLD} は無い"
  fi

  # 4. 結果の確認（ここからは絞った後の権限で）
  if sudo -n true 2>/dev/null; then
    say "[失敗] sudo -n true がまだ通る。上の NOPASSWD の残りを確認"; exit 1
  fi
  sudo -n "$sc" --version >/dev/null && say "[合格] sudo -n systemctl は通る"
  sudo -n "$ap" --version >/dev/null && say "[合格] sudo -n apt は通る"
  say "[合格] sudo -n true は拒否される（絞れた）"
}
main </dev/null
