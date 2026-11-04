#!/usr/bin/env bash
# 20-power-check.sh: 電源の確認（docs/pi-setup.md §6-2、§7-1/7-2）。設定は変えない。
# 流し方: ssh nda-pi 'bash -s' < deploy/pi/20-power-check.sh
# 合格で終了コード 0、不合格で 1。
# 実機で確かめる: Pi 5 で get_config usb_max_current_enable が 5A 認識を正しく映すか。
#   映さない場合は、起動時の警告（dmesg / モニター）と下の「補助」の値で判断する。
set -euo pipefail

say() { printf '%s\n' "$*"; }

main() {
  command -v vcgencmd >/dev/null || { say "[失敗] vcgencmd が無い（Raspberry Pi OS で流しているか確認）"; exit 1; }
  fail=0

  cur=$(vcgencmd get_config usb_max_current_enable | tr -d '\r')
  if [ "$cur" = "usb_max_current_enable=1" ]; then
    say "[合格] 5A 認識: ${cur}"
  else
    say "[不合格] 5A 認識: ${cur:-（値なし）}（期待は usb_max_current_enable=1）。電源を Traskit の単品（5.1V/5A、PSE 認証）に替える"
    fail=1
  fi

  thr=$(vcgencmd get_throttled | tr -d '\r')
  if [ "$thr" = "throttled=0x0" ]; then
    say "[合格] 電圧: ${thr}"
  else
    say "[不合格] 電圧: ${thr}（期待は throttled=0x0。0x50005 など = 電圧低下／制限の履歴あり）"
    fail=1
  fi

  # 補助（合否には使わない）
  if [ -r /proc/device-tree/chosen/power/max_current ]; then
    ma=$(od -An -tu1 -N4 /proc/device-tree/chosen/power/max_current | awk '{print $1*16777216+$2*65536+$3*256+$4}')
    say "[情報] ネゴシエートされた最大電流: ${ma} mA（実機で確かめる。5A なら 5000）"
  fi
  if journalctl -k --no-pager 2>/dev/null | grep -qiE 'under-voltage|usb_max_current|5A power supply'; then
    say "[情報] カーネルログに電源関連の警告がある: journalctl -k | grep -iE 'under-voltage|5A'"
  fi

  exit "$fail"
}
main </dev/null
