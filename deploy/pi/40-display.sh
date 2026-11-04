#!/usr/bin/env bash
# 40-display.sh: Chromium のキオスク表示と、画面が消えない設定（docs/pi-setup.md §6-4）
#   Raspberry Pi OS（Bookworm 以降）は Wayland の labwc が既定。自動起動は
#   ~/.config/labwc/autostart に書く（ログイン時に labwc が実行する）。
#   画面は自動ログイン（デスクトップ）で上がる。
# 流し方: ssh nda-pi 'bash -s' < deploy/pi/40-display.sh   （nda ユーザーで）
# このスクリプトはブラウザを今すぐ起動しない。反映は再起動（鹿内さんに伝えてから）か、再ログイン。
#
# 実機で確かめる:
#   - OS の版と既定のセッションが labwc か（echo $XDG_CURRENT_DESKTOP / ps -e | grep labwc）。
#     Bookworm の初期の版が wayfire だった場合は ~/.config/wayfire.ini の [autostart] に書く必要がある。
#   - Chromium の実行名（Bookworm は chromium-browser、新しい版は chromium。自動で拾う）
#   - 画面が消えないこと（labwc に既定の idle 処理は無いはずだが、10 分以上待って確かめる）
#   - raspi-config nonint の B4（デスクトップ自動ログイン）が版で同じ意味か
set -euo pipefail

say() { printf '%s\n' "$*"; }
URL=${NDA_KIOSK_URL:-http://localhost:3000/monitor}

# ファイルの中身が違うときだけ書く。戻り値 0 = 変更した、1 = すでに同じ
put_file() {
  local dest=$1 mode=$2 content=$3
  if [ -f "$dest" ] && [ "$(cat "$dest")" = "$content" ]; then
    return 1
  fi
  mkdir -p "$(dirname "$dest")"
  if [ -f "$dest" ] && [ ! -f "${dest}.nda-orig" ]; then
    cp -p "$dest" "${dest}.nda-orig"
    say "[変更] ${dest} を ${dest}.nda-orig に退避した"
  fi
  printf '%s\n' "$content" > "$dest"
  chmod "$mode" "$dest"
  return 0
}

main() {
  if [ "$(id -un)" != "nda" ]; then
    say "[失敗] nda ユーザーで流す想定（今は $(id -un)）"; exit 1
  fi

  browser=$(command -v chromium-browser || command -v chromium || true)
  [ -n "$browser" ] || { say "[失敗] Chromium が無い（デスクトップ付きの OS か確認。sudo apt install chromium）"; exit 1; }
  say "[情報] Chromium: ${browser}"
  command -v labwc >/dev/null || say "[警告] labwc が無い。この OS のセッションが違う可能性（実機で確かめる）"

  # --- キオスク用の起動スクリプト ---
  # 本体が上がるまで待ってから開く（待たないと起動直後にエラーページが固まる）。
  # 接続できれば 404 でも開く（仮のページが無い間も落ちない）。
  kiosk=$(cat <<KIOSK
#!/usr/bin/env bash
# nDa: Chromium のキオスク表示。deploy/pi/40-display.sh が管理する（手で編集しない）。
URL="${URL}"
until curl -s -o /dev/null --max-time 2 "\$URL"; do sleep 2; done
# 前回の異常終了の「復元しますか」を出さない
prefs="\$HOME/.config/chromium/Default/Preferences"
[ -f "\$prefs" ] && sed -i 's/"exited_cleanly":false/"exited_cleanly":true/; s/"exit_type":"Crashed"/"exit_type":"Normal"/' "\$prefs"
exec ${browser} --kiosk --noerrdialogs --disable-infobars --disable-session-crashed-bubble \\
  --no-first-run --disable-translate --overscroll-history-navigation=0 \\
  --ozone-platform=wayland "\$URL"
KIOSK
)
  if put_file "$HOME/.local/bin/nda-kiosk.sh" 755 "$kiosk"; then
    say "[変更] ~/.local/bin/nda-kiosk.sh: ${URL} を全画面で開く"
  else
    say "[済] ~/.local/bin/nda-kiosk.sh"
  fi

  # --- labwc の自動起動 ---
  # ユーザーの autostart を置くとシステム既定（パネルやデスクトップ）の代わりに使われる。
  # キオスクなので Chromium だけを出す。元のファイルは .nda-orig に残る。
  autostart=$(cat <<'AUTO'
# nDa: deploy/pi/40-display.sh が管理する（手で編集しない）。
# swayidle 等の画面オフの仕組みは起動しない。
"$HOME/.local/bin/nda-kiosk.sh" &
AUTO
)
  if put_file "$HOME/.config/labwc/autostart" 644 "$autostart"; then
    say "[変更] ~/.config/labwc/autostart: nda-kiosk.sh を自動起動に入れた（再起動か再ログインで反映）"
  else
    say "[済] ~/.config/labwc/autostart"
  fi

  # --- 自動ログイン（デスクトップ） ---
  if command -v raspi-config >/dev/null; then
    if [ "$(raspi-config nonint get_autologin 2>/dev/null || echo 1)" = "0" ]; then
      say "[済] デスクトップ自動ログイン"
    else
      sudo -n raspi-config nonint do_boot_behaviour B4
      say "[変更] デスクトップ自動ログインにした（B4）"
    fi
    # --- 画面を消さない（1 = 無効にする） ---
    if [ "$(raspi-config nonint get_blanking 2>/dev/null || echo 1)" = "1" ]; then
      say "[済] 画面のブランキング: 無効"
    else
      sudo -n raspi-config nonint do_blanking 1
      say "[変更] 画面のブランキングを無効にした"
    fi
  else
    say "[警告] raspi-config が無い。自動ログインと画面オフを手で確認（実機で確かめる）"
  fi

  say "[情報] 確認: 再起動後、モニターに ${URL} が全画面で出て、10 分たっても消えないこと（目で見る）"
}
main </dev/null
