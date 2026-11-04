#!/usr/bin/env bash
# 90-verify.sh: docs/pi-setup.md §7 の 8 項目のうち、Pi の上で自動で確かめられるものを流して表にする。
# 流し方: ssh nda-pi 'bash -s' < deploy/pi/90-verify.sh
# 結果: 合格 / 不合格 / 手動（人の目や Mac からの操作が要る）。不合格が 1 つでもあれば終了コード 1。
# .env は権限(stat)だけ見る。中身は読まない。
# 実機で確かめる: 各判定の文字列（vcgencmd、arecord -l の Jabra の表記）が実機の出力と合うか。
set -euo pipefail

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
  # 8（権限だけ。中身は読まない）
  f="$HOME/nda/.env"
  if [ ! -e "$f" ]; then add 8 "秘密の値" 不合格 "~/nda/.env が無い（P4 で鹿内さんが作る）"
  else
    m=$(stat -c %a "$f")
    if [ "$m" = "600" ]; then add 8 "秘密の値" 合格 "権限 600（中身は読まない）"
    else add 8 "秘密の値" 不合格 "権限 ${m}"; fi
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
