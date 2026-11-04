#!/usr/bin/env bash
# 50-service.sh: nDa 本体を systemd のサービスにする（docs/pi-setup.md §6-5）
#   nda.service: User=nda、WorkingDirectory=~/nda、Restart=always。
#   秘密の値は ~/nda/.env を EnvironmentFile として systemd が読む。
#   このスクリプトは .env の中身を読まない・作らない（権限だけ見る）。
# 流し方: ssh nda-pi 'bash -s' < deploy/pi/50-service.sh
#
# 仮: ExecStart は `pnpm start`（nDa 本体の起動命令が決まったら UNIT の ExecStart を直す）。
# 実機で確かめる:
#   - Node と pnpm が Pi に入っているか（このスクリプトは入れない。別の作業）
#   - pnpm の場所（ここでは bash -lc 経由で PATH から拾う）
#   - 停電後の復帰（sudo reboot の 2 分後に systemctl is-active nda が active）
set -euo pipefail

say() { printf '%s\n' "$*"; }
UNIT_PATH=/etc/systemd/system/nda.service
APP_DIR=/home/nda/nda

main() {
  sudo -n true 2>/dev/null || { say "[失敗] パスワードなしの sudo が使えない"; exit 1; }
  [ "$(id -un)" = "nda" ] || { say "[失敗] nda ユーザーで流す想定（今は $(id -un)）"; exit 1; }

  if [ -d "$APP_DIR" ]; then
    say "[済] ${APP_DIR} がある"
  else
    mkdir -p "$APP_DIR"
    say "[変更] ${APP_DIR} を作った（中身はまだ空。本体の配置は別の作業）"
  fi

  # .env は権限だけ見る（読まない・作らない・変えない）
  if [ -e "$APP_DIR/.env" ]; then
    mode=$(stat -c %a "$APP_DIR/.env")
    if [ "$mode" = "600" ]; then
      say "[済] ${APP_DIR}/.env の権限は 600"
    else
      say "[警告] ${APP_DIR}/.env の権限が ${mode}（600 にする。chmod 600 ~/nda/.env を鹿内さんが実行）"
    fi
  else
    say "[情報] ${APP_DIR}/.env はまだ無い（P4 で鹿内さんが書く。EnvironmentFile は '-' 付きなので無くても起動は試みる）"
  fi

  unit=$(cat <<'UNIT'
# deploy/pi/50-service.sh が管理する（手で編集しない）
[Unit]
Description=nDa (Next.js + libSQL)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=nda
WorkingDirectory=/home/nda/nda
EnvironmentFile=-/home/nda/nda/.env
Environment=NODE_ENV=production
Environment=PORT=3000
# 仮: 起動命令は本体が決まったら直す
ExecStart=/bin/bash -lc 'exec pnpm start'
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
)
  if [ -f "$UNIT_PATH" ] && [ "$(cat "$UNIT_PATH")" = "$unit" ]; then
    say "[済] ${UNIT_PATH}"
  else
    printf '%s\n' "$unit" | sudo tee "$UNIT_PATH" >/dev/null
    sudo systemctl daemon-reload
    say "[変更] ${UNIT_PATH} を書いて daemon-reload した"
  fi

  if systemctl is-enabled --quiet nda.service 2>/dev/null; then
    say "[済] nda.service は enable 済み"
  else
    sudo systemctl enable nda.service
    say "[変更] nda.service を enable した（停電から戻ったら自動で上がる）"
  fi

  # 本体が置かれる前に起動すると落ち続けるので、package.json がある時だけ起動する
  if [ ! -f "$APP_DIR/package.json" ]; then
    say "[情報] ${APP_DIR}/package.json が無いので start しない（本体を置いてから sudo systemctl start nda）"
  elif systemctl is-active --quiet nda.service; then
    say "[済] nda.service は active"
  else
    sudo systemctl start nda.service
    say "[変更] nda.service を start した"
  fi
}
main </dev/null
