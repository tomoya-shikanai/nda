#!/usr/bin/env bash
# 50-service.sh: nDa 本体を systemd のサービスにする（docs/pi-setup.md §6-5）
#   本体は管理用の nda ではなく、専用の nda-app（--system、sudo なし、ログインシェルなし）で動かす。
#   置き場:
#     /opt/nda           本体（nda が配置する。nda-app は読むだけ）
#     /var/lib/nda       データ（libSQL のファイル・録音。nda-app だけが書ける。nda-app のホーム）
#     /etc/nda/nda.env   秘密の値（nda-app:nda-app、600。systemd が EnvironmentFile として読む）
#   このスクリプトは .env の中身を読まない・作らない（権限だけ見る）。
# 流し方: ssh nda-pi 'bash -s' < deploy/pi/50-service.sh
#   Node の場所が /usr/local/bin でないとき: ssh nda-pi 'NDA_NODE_BIN_DIR=/usr/bin bash -s' < deploy/pi/50-service.sh
#
# 仮: ExecStart は `pnpm start`（nDa 本体の起動命令が決まったら UNIT の ExecStart を直す）。
# 実機で確かめる:
#   - Node と pnpm の入れ方と場所（このスクリプトは入れない。NODE_BIN_DIR を合わせる）
#   - systemd の保護を入れた状態で next start が動くか（systemd-analyze security nda.service も見る）
#   - 停電後の復帰（sudo reboot の 2 分後に systemctl is-active nda が active）
set -euo pipefail

say() { printf '%s\n' "$*"; }
UNIT_PATH=/etc/systemd/system/nda.service
APP_USER=nda-app
APP_DIR=/opt/nda
DATA_DIR=/var/lib/nda
ENV_DIR=/etc/nda
ENV_FILE=/etc/nda/nda.env
# node と pnpm の置き場はここ 1 か所で決める（入れ方は実機で決める。README 参照）
NODE_BIN_DIR="${NDA_NODE_BIN_DIR:-/usr/local/bin}"

# ディレクトリを 所有者:グループ と権限つきで用意する（すでに正しければ何もしない）
ensure_dir() { # パス 所有者 グループ 権限 説明
  local p=$1 o=$2 g=$3 m=$4 what=$5
  if [ -d "$p" ] && [ "$(stat -c '%U:%G %a' "$p")" = "${o}:${g} ${m}" ]; then
    say "[済] ${p}（${o}:${g} ${m}、${what}）"
  else
    sudo install -d -o "$o" -g "$g" -m "$m" "$p"
    say "[変更] ${p} を ${o}:${g} ${m} にした（${what}）"
  fi
}

main() {
  sudo -n true 2>/dev/null || { say "[失敗] パスワードなしの sudo が使えない"; exit 1; }
  [ "$(id -un)" = "nda" ] || { say "[失敗] nda ユーザーで流す想定（今は $(id -un)）"; exit 1; }

  # --- 本体を動かす専用のユーザー ---
  nologin=$(PATH="$PATH:/usr/sbin:/sbin" type -P nologin || echo /usr/sbin/nologin)
  if id "$APP_USER" >/dev/null 2>&1; then
    say "[済] ${APP_USER} ユーザーがある"
  else
    sudo useradd --system --user-group --home-dir "$DATA_DIR" --no-create-home \
      --shell "$nologin" "$APP_USER"
    say "[変更] ${APP_USER} を作った（--system、ホーム ${DATA_DIR}、シェル ${nologin}）"
  fi
  shell=$(getent passwd "$APP_USER" | cut -d: -f7)
  case "$shell" in
    */nologin|/bin/false|/usr/bin/false) say "[済] ${APP_USER} のシェルは ${shell}（ログインできない）" ;;
    *) say "[失敗] ${APP_USER} のシェルが ${shell}（nologin にする: sudo usermod -s ${nologin} ${APP_USER}）"; exit 1 ;;
  esac
  for grp in sudo adm; do
    if id -nG "$APP_USER" | tr ' ' '\n' | grep -qx "$grp"; then
      say "[失敗] ${APP_USER} が ${grp} グループに入っている（sudo gpasswd -d ${APP_USER} ${grp}）"; exit 1
    fi
  done
  say "[済] ${APP_USER} は sudo・adm のグループに入っていない"

  # --- 置き場 ---
  ensure_dir "$APP_DIR" nda nda 755 "本体。nda が配置し、${APP_USER} は読むだけ"
  ensure_dir "$DATA_DIR" "$APP_USER" "$APP_USER" 750 "データ。${APP_USER} だけが書ける"
  ensure_dir "$ENV_DIR" root root 755 "秘密の値の置き場"

  # .env は権限だけ見る（読まない・作らない・変えない）
  if [ -e "$ENV_FILE" ]; then
    st=$(stat -c '%U:%G %a' "$ENV_FILE")
    if [ "$st" = "${APP_USER}:${APP_USER} 600" ]; then
      say "[済] ${ENV_FILE} は ${st}"
    else
      say "[警告] ${ENV_FILE} が ${st}（期待は ${APP_USER}:${APP_USER} 600。鹿内さんが sudo chown ${APP_USER}:${APP_USER} ${ENV_FILE} && sudo chmod 600 ${ENV_FILE}）"
    fi
  else
    say "[情報] ${ENV_FILE} はまだ無い（P4 で鹿内さんが書く。EnvironmentFile は '-' 付きなので無くても起動は試みる）"
  fi
  if [ -e /home/nda/nda/.env ]; then
    say "[警告] 旧い置き場の /home/nda/nda/.env がある（もう使わない。中身を ${ENV_FILE} へ移すのは鹿内さん）"
  fi

  # --- node と pnpm ---
  node_ok=1
  for b in node pnpm; do
    if [ -x "$NODE_BIN_DIR/$b" ]; then
      say "[済] ${NODE_BIN_DIR}/${b} がある"
    else
      say "[警告] ${NODE_BIN_DIR}/${b} が無い（Node と pnpm を入れるか、NDA_NODE_BIN_DIR で場所を合わせる）"
      node_ok=0
    fi
  done

  # ExecStart は絶対パス（bash -lc を使わない）。pnpm は中で node と next を呼ぶので、PATH は NODE_BIN_DIR を先頭に固定する。
  # MemoryDenyWriteExecute は V8 の JIT を壊すので入れない。
  unit=$(cat <<UNIT
# deploy/pi/50-service.sh が管理する（手で編集しない）
[Unit]
Description=nDa (Next.js + libSQL)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=-${ENV_FILE}
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=PATH=${NODE_BIN_DIR}:/usr/bin:/bin
# 仮: 起動命令は本体が決まったら直す
ExecStart=${NODE_BIN_DIR}/pnpm start
Restart=always
RestartSec=5
UMask=0027

# 保護（本体の不具合が他へ広がらないように）
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=${DATA_DIR}
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictSUIDSGID=yes
RestrictNamespaces=yes
RestrictRealtime=yes
LockPersonality=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
CapabilityBoundingSet=
AmbientCapabilities=
SystemCallArchitectures=native
SystemCallFilter=@system-service

[Install]
WantedBy=multi-user.target
UNIT
)
  if [ -f "$UNIT_PATH" ] && [ "$(cat "$UNIT_PATH")" = "$unit" ]; then
    say "[済] ${UNIT_PATH}"
  else
    printf '%s\n' "$unit" | sudo tee "$UNIT_PATH" >/dev/null
    sudo chmod 644 "$UNIT_PATH"
    sudo systemctl daemon-reload
    say "[変更] ${UNIT_PATH} を書いて daemon-reload した（User=${APP_USER}、ExecStart=${NODE_BIN_DIR}/pnpm start）"
    # verify は ExecStart の実体が無いときも文句を言うので、警告にとどめる
    if ! systemd-analyze verify "$UNIT_PATH" >/dev/null 2>&1; then
      say "[警告] systemd-analyze verify ${UNIT_PATH} が通らない（node・pnpm が無い間は正常。あれば内容を見る）"
    fi
    if systemctl is-active --quiet nda.service; then
      sudo systemctl restart nda.service
      say "[変更] nda.service を restart した（新しい設定で動かすため）"
    fi
  fi

  if systemctl is-enabled --quiet nda.service 2>/dev/null; then
    say "[済] nda.service は enable 済み"
  else
    sudo systemctl enable nda.service
    say "[変更] nda.service を enable した（停電から戻ったら自動で上がる）"
  fi

  # 本体が置かれる前に起動すると落ち続けるので、package.json と node がある時だけ起動する
  if [ ! -f "$APP_DIR/package.json" ]; then
    say "[情報] ${APP_DIR}/package.json が無いので start しない（本体を置いてから sudo systemctl start nda.service）"
  elif [ "$node_ok" -eq 0 ]; then
    say "[情報] node か pnpm が無いので start しない"
  elif systemctl is-active --quiet nda.service; then
    say "[済] nda.service は active"
  else
    sudo systemctl start nda.service
    say "[変更] nda.service を start した"
  fi
}
main </dev/null
