#!/usr/bin/env bash
# 90-verify.sh: docs/pi-setup.md §7 の 11 項目のうち、Pi の上で自動で確かめられるものを流して表にする。
# 流し方: ssh nda-pi 'bash -s' < deploy/pi/90-verify.sh
# 結果: 合格 / 不合格 / 手動（人の目や Mac からの操作が要る）。不合格が 1 つでもあれば終了コード 1。
# .env は権限(stat)だけ見る。中身は読まない。
# 実機で確かめる: 各判定の文字列（vcgencmd、arecord -l の Jabra の表記、sudo -l の表示）が実機の出力と合うか。
set -euo pipefail

APP_USER=nda-app
ENV_FILE=/etc/nda/nda.env

# sudo -n -l の出力から、NOPASSWD で許された命令を 1 行に 1 つずつ並べる（60-sudo-tighten.sh と同じ）
nopasswd_cmds() {
  sudo -n -l 2>/dev/null \
    | sed -n '/may run the following commands/,$p' \
    | grep 'NOPASSWD:' \
    | sed 's/.*NOPASSWD: *//' \
    | sed 's/, /\n/g' \
    | sed 's/^ *//; s/ *$//' \
    | sort -u
}

rows=()
fail=0
add() { # 番号 項目 結果 詳細
  rows+=("$1|$2|$3|$4")
  [ "$3" = "不合格" ] && fail=1
  return 0
}

main() {
  # 1
  v=$(vcgencmd get_config usb_max_current_enable 2>/dev/null | tr -d '\r' || true)
  if [ "$v" = "usb_max_current_enable=1" ]; then add 1 "電源が 5A で認識された" 合格 "$v"
  else add 1 "電源が 5A で認識された" 不合格 "${v:-vcgencmd の出力なし}"; fi
  # 2
  v=$(vcgencmd get_throttled 2>/dev/null | tr -d '\r' || true)
  if [ "$v" = "throttled=0x0" ]; then add 2 "電圧が落ちていない" 合格 "$v"
  else add 2 "電圧が落ちていない" 不合格 "${v:-vcgencmd の出力なし}"; fi
  # 3
  rec=$(arecord -l 2>/dev/null | grep -ci 'jabra' || true)
  ply=$(aplay -l 2>/dev/null | grep -ci 'jabra' || true)
  if [ "$rec" -ge 1 ] && [ "$ply" -ge 1 ]; then add 3 "Jabra が見える" 合格 "arecord/aplay の両方に出る"
  else add 3 "Jabra が見える" 不合格 "arecord=${rec} 件、aplay=${ply} 件"; fi
  # 4
  add 4 "録音と再生" 手動 "30-audio.sh の末尾の手順で 5 秒録って聞く"
  # 5（自動で見られるのは、起動の仕込みと Chromium が動いているかまで）
  if pgrep -f -- '--kiosk' >/dev/null; then add 5 "モニター" 手動 "Chromium(kiosk) は動作中。全画面で出ているか、10 分消えないかは目で見る"
  elif [ -f "$HOME/.config/labwc/autostart" ]; then add 5 "モニター" 手動 "kiosk は未起動（再起動か再ログイン前なら正常）。目で見る"
  else add 5 "モニター" 不合格 "~/.config/labwc/autostart が無い（40-display.sh）"; fi
  # 6
  ts=$(tailscale status --json 2>/dev/null | grep -o '"BackendState": *"[A-Za-z]*"' || true)
  add 6 "外からの接続" 手動 "工場の外の Mac から ssh nda-pi。Pi 側: ${ts:-tailscale の状態を取れない}"
  # 7
  en=$(systemctl is-enabled nda.service 2>/dev/null || true)
  ac=$(systemctl is-active nda.service 2>/dev/null || true)
  if [ "$en" = "enabled" ] && [ "$ac" = "active" ]; then add 7 "停電からの復帰" 手動 "enabled/active。reboot の 2 分後の再確認は人が行う"
  elif [ "$en" = "enabled" ]; then add 7 "停電からの復帰" 手動 "enabled だが ${ac}（本体を置く前なら正常）。reboot 後の確認は人が行う"
  else add 7 "停電からの復帰" 不合格 "nda.service が ${en:-無い}（50-service.sh）"; fi
  # 8（権限と所有者だけ。中身は読まない）
  if [ ! -e "$ENV_FILE" ]; then add 8 "秘密の値" 不合格 "${ENV_FILE} が無い（P4 で鹿内さんが作る）"
  else
    st=$(stat -c '%U:%G %a' "$ENV_FILE")
    if [ "$st" = "${APP_USER}:${APP_USER} 600" ]; then add 8 "秘密の値" 合格 "${st}（中身は読まない）"
    else add 8 "秘密の値" 不合格 "${st}（期待は ${APP_USER}:${APP_USER} 600）"; fi
  fi
  # 9 nda-app に sudo の権限が無い
  if ! id "$APP_USER" >/dev/null 2>&1; then add 9 "nda-app に sudo が無い" 不合格 "${APP_USER} が無い（50-service.sh）"
  else
    grps=$(id -nG "$APP_USER")
    shell=$(getent passwd "$APP_USER" | cut -d: -f7)
    # -U で他人の権限を見られるのは全許可のときだけ。60 の後は見られないので、グループとシェルで判定する
    lst=$(sudo -n -l -U "$APP_USER" 2>/dev/null || true)
    if printf '%s\n' "$grps" | tr ' ' '\n' | grep -qxE 'sudo|admin|wheel'; then
      add 9 "nda-app に sudo が無い" 不合格 "グループ: ${grps}"
    elif printf '%s\n' "$lst" | grep -q 'may run the following commands'; then
      add 9 "nda-app に sudo が無い" 不合格 "sudo -l -U に許可がある"
    else
      case "$shell" in
        */nologin|/bin/false|/usr/bin/false) add 9 "nda-app に sudo が無い" 合格 "グループ: ${grps}、シェル: ${shell}${lst:+、sudo -l -U でも許可なし}" ;;
        *) add 9 "nda-app に sudo が無い" 不合格 "シェルが ${shell}（nologin にする）" ;;
      esac
    fi
  fi
  # 10 nda.service が nda-app で動いている
  u=$(systemctl show -p User --value nda.service 2>/dev/null || true)
  pid=$(systemctl show -p MainPID --value nda.service 2>/dev/null || true)
  if [ "$u" != "$APP_USER" ]; then add 10 "本体が nda-app で動く" 不合格 "User=${u:-（未設定）}（50-service.sh）"
  elif [ -n "$pid" ] && [ "$pid" != "0" ]; then
    pu=$(ps -o user= -p "$pid" 2>/dev/null | tr -d ' ' || true)
    if [ "$pu" = "$APP_USER" ]; then add 10 "本体が nda-app で動く" 合格 "User=${u}、PID ${pid} は ${pu}"
    else add 10 "本体が nda-app で動く" 不合格 "PID ${pid} が ${pu:-不明} で動いている"; fi
  else add 10 "本体が nda-app で動く" 手動 "User=${u}。動いていないので実プロセスは未確認（本体を置いた後に流し直す）"; fi
  # 11 nda のパスワードなしの sudo は固定の命令だけ（60-sudo-tighten.sh と同じ一覧）
  sc=$(type -P systemctl); rb=$(PATH="$PATH:/usr/sbin:/sbin" type -P reboot)
  expected=$(printf '%s\n' "$sc start nda.service" "$sc stop nda.service" "$sc restart nda.service" "$rb" | sort -u)
  if sudo -n true 2>/dev/null; then add 11 "sudo は固定の命令だけ" 不合格 "sudo -n true が通る（60-sudo-tighten.sh を流していない）"
  else
    got=$(nopasswd_cmds || true)
    if [ "$got" = "$expected" ]; then add 11 "sudo は固定の命令だけ" 合格 "start/stop/restart nda.service と reboot"
    else add 11 "sudo は固定の命令だけ" 不合格 "sudo -l の NOPASSWD: $(printf '%s' "${got:-なし}" | tr '\n' ';')"; fi
  fi

  printf '%-2s | %-22s | %-4s | %s\n' '#' 項目 結果 詳細
  printf -- '---|------------------------|------|------\n'
  for r in "${rows[@]}"; do
    IFS='|' read -r n item res det <<<"$r"
    printf '%-2s | %-22s | %-4s | %s\n' "$n" "$item" "$res" "$det"
  done
  exit "$fail"
}
main </dev/null
