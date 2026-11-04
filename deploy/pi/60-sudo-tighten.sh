#!/usr/bin/env bash
# 60-sudo-tighten.sh: nda のパスワードなしの sudo を、引数まで固定した命令だけに絞る（docs/pi-setup.md §3-5、§6-6）
#   許すのは次の 4 つだけ（90-verify.sh の EXPECTED と同じ。変えるときは両方直す）:
#     systemctl start nda.service / systemctl stop nda.service / systemctl restart nda.service / reboot
#   systemctl の任意の操作や apt・apt-get（フックで root を取れる）は許さない。SETENV も付けない。
#   状態とログは sudo なしで見る: systemctl status nda.service、journalctl -u nda.service
#   （journal を読むために nda を systemd-journal グループに入れる）。
#   OS の更新は unattended-upgrades（10-base.sh）か、パスワード付きの sudo で行う。
#   /etc/sudoers.d/020_nda-tight を作り、Imager が作る全許可の 010_pi-nopasswd を無効にする
#   （削除せず 010_pi-nopasswd.nda-disabled に改名。名前に "." があるファイルは sudo が読まない）。
#   パスワード付きの sudo は %sudo グループ経由で残る（締め出されない）。
# 流し方: ssh nda-pi 'bash -s' < deploy/pi/60-sudo-tighten.sh   （最後の段。他のセットアップが済んでから）
# 流した後は、10・30・40・50 など sudo で書くスクリプトはパスワードなしでは流せない。README の戻し方を見る。
#
# 実機で確かめる:
#   - 010_pi-nopasswd という名前が OS の版で同じか（ls /etc/sudoers.d）
#   - /etc/sudoers 本体や他のファイルに NOPASSWD が無いか（このスクリプトが一覧を出す）
#   - systemctl / reboot の実体のパス（type -P で拾う）と、sudo -l の表示の形（下の nopasswd_cmds が読める形か）
set -euo pipefail

say() { printf '%s\n' "$*"; }
TIGHT=/etc/sudoers.d/020_nda-tight
OLD=/etc/sudoers.d/010_pi-nopasswd

# sudo -n -l の出力から、NOPASSWD で許された命令を 1 行に 1 つずつ並べる（90-verify.sh と同じ）
nopasswd_cmds() {
  sudo -n -l 2>/dev/null \
    | sed -n '/may run the following commands/,$p' \
    | grep 'NOPASSWD:' \
    | sed 's/.*NOPASSWD: *//' \
    | sed 's/, /\n/g' \
    | sed 's/^ *//; s/ *$//' \
    | sort -u
}

main() {
  sc=$(type -P systemctl); rb=$(PATH="$PATH:/usr/sbin:/sbin" type -P reboot)
  expected=$(printf '%s\n' \
    "$sc start nda.service" "$sc stop nda.service" "$sc restart nda.service" "$rb" | sort -u)

  if ! sudo -n true 2>/dev/null; then
    # すでに絞られた後かもしれない。許された命令が固定の一覧と同じかを見る
    got=$(nopasswd_cmds || true)
    if [ "$got" = "$expected" ]; then
      say "[済] すでに絞られている（パスワードなしは固定の 4 命令だけ）"
      exit 0
    fi
    say "[失敗] パスワードなしの sudo が全許可でも、固定の 4 命令だけでもない。今の許可:"
    printf '%s\n' "${got:-（なし）}" | sed 's/^/    /'
    say "       README の「60 の戻し方」で一時的に緩めてから、60 を流し直す"
    exit 1
  fi

  rule="nda ALL=(root) NOPASSWD: ${sc} start nda.service, ${sc} stop nda.service, ${sc} restart nda.service, ${rb}"
  content=$(printf '# deploy/pi/60-sudo-tighten.sh が管理する（手で編集しない）\n%s' "$rule")

  # 1. ログを sudo なしで読めるようにする（絞る前に。グループは次のログインから効く）
  if id -nG nda | tr ' ' '\n' | grep -qx systemd-journal; then
    say "[済] nda は systemd-journal グループに入っている（journalctl -u nda.service を sudo なしで読める）"
  else
    sudo usermod -aG systemd-journal nda
    say "[変更] nda を systemd-journal グループに入れた（次の SSH から journalctl -u nda.service を sudo なしで読める）"
  fi

  # 2. 新しい規則を先に置く（検証してから入れる）
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
    # 全体（/etc/sudoers と sudoers.d）としても通るかを見る。通らなければ戻す
    if ! sudo visudo -c >/dev/null; then
      sudo rm -f "$TIGHT"; say "[失敗] 入れた後の visudo -c が通らないので ${TIGHT} を消した"; exit 1
    fi
    say "[変更] ${TIGHT}: ${rule}"
  fi

  # 3. 他に NOPASSWD が残っていないか（表示だけ。無効化の前に読む。後だと sudo が通らない）
  others=$(sudo grep -rn 'NOPASSWD' /etc/sudoers /etc/sudoers.d 2>/dev/null | grep -v "^${TIGHT}:" | grep -v "^${OLD}:" | grep -v ':[0-9]*:#' | grep -v '\.nda-disabled:' || true)
  if [ -n "$others" ]; then
    say "[警告] 他に NOPASSWD の記述が残っている（実機で確かめる）:"
    printf '%s\n' "$others" | sed 's/^/    /'
  fi

  # 4. 全許可の規則を無効にする
  if [ -f "$OLD" ]; then
    sudo mv "$OLD" "${OLD}.nda-disabled"
    say "[変更] ${OLD} を ${OLD}.nda-disabled に改名した（無効）"
  else
    say "[済] ${OLD} は無い"
  fi

  # 5. 結果の確認（ここからは絞った後の権限で。命令は実行せず sudo -l で許可だけ見る）
  if sudo -n true 2>/dev/null; then
    say "[失敗] sudo -n true がまだ通る。上の NOPASSWD の残りを確認"; exit 1
  fi
  say "[合格] sudo -n true は拒否される"
  got=$(nopasswd_cmds || true)
  if [ "$got" = "$expected" ]; then
    say "[合格] パスワードなしで通るのは固定の 4 命令だけ"
    printf '%s\n' "$got" | sed 's/^/    /'
  else
    say "[失敗] パスワードなしの許可が期待と違う（sudo -l の表示の形が違う可能性もある）。期待:"
    printf '%s\n' "$expected" | sed 's/^/    /'
    say "       実際:"
    printf '%s\n' "${got:-（なし）}" | sed 's/^/    /'
    exit 1
  fi
}
main </dev/null
