#!/usr/bin/env bash
# 30-audio.sh: Jabra Speak 510 を既定の録音・再生にする（docs/pi-setup.md §6-3）
#   1. snd_usb_audio の index を固定して、Jabra を常にカード 0 にする（再起動後に効く）。
#   2. /etc/asound.conf で既定の機器を Jabra にし、plug 経由（rate/channels/format を変換）で流す。
#      16kHz の音で音程がおかしくなる報告があるため、アプリが何を出しても Jabra の形式に合わせる。
# 流し方: ssh nda-pi 'bash -s' < deploy/pi/30-audio.sh   （Jabra を USB-A に挿した状態で）
# 環境変数: NDA_AUDIO_RATE（既定 16000。Jabra が対応する形式に合わせる）
#
# 実機で確かめる:
#   - Jabra のカード名（/proc/asound/cards の ID。ここでは "Jabra" を含む行から自動で拾う）
#   - USB の vid:pid（lsusb から自動で拾う。Speak 510 は 0b0e:0420 のはずだが未確認）
#   - 対応する rate/channels（このスクリプトが /proc/asound/card*/stream0 を表示する）
#   - Bookworm 以降の PipeWire がカードを掴んでいて、既定を asound.conf で上書きしても
#     arecord が "busy" にならないか（なる場合は wpctl で既定を設定する方式に切り替える）
set -euo pipefail

say() { printf '%s\n' "$*"; }

# 内容が違うときだけ root で書く。戻り値 0 = 変更した、1 = すでに同じ
install_file() {
  local dest=$1 content=$2
  if [ -f "$dest" ] && [ "$(cat "$dest")" = "$content" ]; then
    return 1
  fi
  if [ -f "$dest" ] && [ ! -f "${dest}.nda-orig" ]; then
    sudo cp -p "$dest" "${dest}.nda-orig"
    say "[変更] ${dest} を ${dest}.nda-orig に退避した"
  fi
  printf '%s\n' "$content" | sudo tee "$dest" >/dev/null
  return 0
}

main() {
  sudo -n true 2>/dev/null || { say "[失敗] パスワードなしの sudo が使えない"; exit 1; }
  rate=${NDA_AUDIO_RATE:-16000}

  # --- Jabra の検出 ---
  usbline=$(lsusb | grep -i 'jabra' | head -n1 || true)
  if [ -z "$usbline" ]; then
    say "[失敗] lsusb に Jabra が無い。USB-A（青い端子）に挿しているか確認"
    exit 1
  fi
  vidpid=$(printf '%s' "$usbline" | sed -E 's/.*ID ([0-9a-f]{4}:[0-9a-f]{4}).*/\1/')
  vid="0x${vidpid%%:*}"; pid="0x${vidpid##*:}"
  say "[情報] USB: ${usbline}"

  cardline=$(grep -i 'jabra' /proc/asound/cards | head -n1 || true)
  if [ -z "$cardline" ]; then
    say "[失敗] /proc/asound/cards に Jabra が無い（cat /proc/asound/cards を確認）"
    exit 1
  fi
  cardno=$(printf '%s' "$cardline" | awk '{print $1}')
  cardid=$(printf '%s' "$cardline" | sed -E 's/^ *[0-9]+ \[([^] ]+) *\].*/\1/')
  say "[情報] ALSA カード: 番号 ${cardno} / ID ${cardid}"

  # --- 1. カード番号は固定しない ---
  # 以前は snd_usb_audio に index=0 を渡していたが、Pi 5 では 0 番を HDMI（vc4hdmi0）が先に取るため、
  # 再起動の後に Jabra の登録そのものが失敗した（dmesg: cannot find the slot for index 0, error -16。2026-11-08）。
  # 下の asound.conf は CARD=<ID> の名前で Jabra を指すので、番号は要らない。
  reboot_needed=0
  if [ -f /etc/modprobe.d/nda-audio.conf ]; then
    sudo rm -f /etc/modprobe.d/nda-audio.conf
    say "[変更] /etc/modprobe.d/nda-audio.conf を消した（index=0 の固定は Jabra の登録を壊すため）"
  else
    say "[済] カード番号は固定しない（名前で指す）"
  fi

  # --- 2. 既定の機器と変換 ---
  asound=$(cat <<ASOUND
# nDa: Jabra Speak 510 を既定にする。deploy/pi/30-audio.sh が管理する（手で編集しない）。
# plug が rate / channels / format を Jabra の形式に変換する。
pcm.nda_out {
  type plug
  slave { pcm "hw:CARD=${cardid},DEV=0"; rate ${rate}; channels 1; format S16_LE }
}
pcm.nda_in {
  type plug
  slave { pcm "hw:CARD=${cardid},DEV=0"; rate ${rate}; channels 1; format S16_LE }
}
pcm.!default {
  type asym
  playback.pcm "nda_out"
  capture.pcm "nda_in"
}
ctl.!default { type hw; card "${cardid}" }
ASOUND
)
  if install_file /etc/asound.conf "$asound"; then
    say "[変更] /etc/asound.conf: 既定を Jabra（CARD=${cardid}、${rate}Hz モノ、plug で変換）にした"
  else
    say "[済] /etc/asound.conf"
  fi

  # --- 参考表示 ---
  say "[情報] Jabra が対応する形式（stream0）:"
  sed 's/^/    /' "/proc/asound/card${cardno}/stream0" 2>/dev/null || say "    （読めない）"

  cat <<GUIDE

== 5 秒録って再生する確認（手で行う。docs/pi-setup.md §7-3/7-4）==
  ssh nda-pi
  arecord -l; aplay -l                       # どちらにも Jabra が出る
  arecord -D nda_in -f S16_LE -r ${rate} -c 1 -d 5 /tmp/jabra-test.wav
  aplay -D nda_out /tmp/jabra-test.wav       # 音程と速さが正しいか
  aplay -D default /tmp/jabra-test.wav       # 既定でも同じか
  rm /tmp/jabra-test.wav                     # 録音は残さない
  録音中は 2m 離れて話し、作業場の騒音の中でも聞き取れるか確かめる。
  音程がおかしいときは NDA_AUDIO_RATE を stream0 の値に変えて、このスクリプトを流し直す。
GUIDE
  [ "$reboot_needed" -eq 1 ] && say "[要再起動] modprobe の設定を反映するため" || true
}
main </dev/null
