#!/usr/bin/env bash
# 50-service.sh: nDa 本体を systemd のサービスにする（docs/pi-setup.md §6-5）。一度だけの土台。本体の更新と build は 52-deploy.sh。
#   本体は管理用の nda ではなく、専用の nda-app（--system、sudo なし、ログインシェルなし）で動かす。
#   置き場:
#     /opt/nda                本体（公開リポジトリを nda が clone する。nda-app は読むだけ）
#     /var/lib/nda            データ（nda-app だけが書ける。nda-app のホーム）
#       sessions/             作業の状態（NDA_SESSION_DIR）
#       ledger.json           料金表（NDA_LEDGER_PATH。初回だけ /opt/nda/data/ledger.json から写す）
#       next-cache/           next start が書くキャッシュ（/opt/nda/.next/cache をここへ向ける。52 が張る）
#       logs/                 出来事の記録（NDA_LOG_DIR。nda-app:nda 2770。本体と聞き役（nda）の両方が書く。docs/logging.md）
#     /etc/nda/nda.env        秘密の値（nda-app:nda-app、600。systemd が EnvironmentFile として読む）
#     /mnt/nda-office         事務所の受け箱（58-office-share.sh が mount する。nda.service はここにも書ける）
#   このスクリプトは .env の中身を読まない・作らない（権限だけ見る）。
#   本体（next start）は 127.0.0.1:3000 だけで待つ。LAN に出すのは関所 nda-office-gate.service（0.0.0.0:3001）だけで、
#   POST /api/office/reply だけを本体へ中継する（scripts/office-gate.ts）。
# 流し方: ssh nda-pi 'bash -s' < deploy/pi/50-service.sh
# 環境変数:
#   NDA_NODE_BIN_DIR  node の置き場（既定 /usr/local/bin。既定のときだけ Node を公式の tar から入れる）
#   NDA_REPO_URL      本体の取り元（既定 https://github.com/tomoya-shikanai/nda.git）
#
# 実機で確かめる:
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
OFFICE_MNT=/mnt/nda-office
NODE_BIN_DIR="${NDA_NODE_BIN_DIR:-/usr/local/bin}"
GATE_UNIT_PATH=/etc/systemd/system/nda-office-gate.service
REPO_URL="${NDA_REPO_URL:-https://github.com/tomoya-shikanai/nda.git}"
# Node は版と SHA-256 を固定する（https://nodejs.org/dist/v24.22.1/SHASUMS256.txt の linux-arm64.tar.xz の行。Mac の開発と同じ版）
NODE_VERSION=24.22.1
NODE_SHA256=dbabf7a1cbf947e6059ffad2c27b80041db97dea1e553b62afdee7f13fca336e

# ディレクトリを 所有者:グループ と権限つきで用意する（すでに正しければ何もしない）
ensure_dir() { # パス 所有者 グループ 権限 説明
  local p=$1 o=$2 g=$3 m=$4 what=$5
  if sudo test -d "$p" && [ "$(sudo stat -c '%U:%G %a' "$p")" = "${o}:${g} ${m}" ]; then
    say "[済] ${p}（${o}:${g} ${m}、${what}）"
  else
    sudo install -d -o "$o" -g "$g" -m "$m" "$p"
    say "[変更] ${p} を ${o}:${g} ${m} にした（${what}）"
  fi
}

ensure_pkgs() { # パッケージ...
  local missing=() p
  for p in "$@"; do dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p"); done
  if [ "${#missing[@]}" -eq 0 ]; then
    say "[済] apt: $*"
  else
    sudo apt-get update -qq
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${missing[@]}"
    say "[変更] apt で入れた: ${missing[*]}"
  fi
}

install_node() {
  if [ "$("$NODE_BIN_DIR/node" -v 2>/dev/null || true)" = "v${NODE_VERSION}" ]; then
    say "[済] node v${NODE_VERSION}（${NODE_BIN_DIR}/node）"
    return
  fi
  if [ "$NODE_BIN_DIR" != /usr/local/bin ]; then
    say "[警告] ${NODE_BIN_DIR}/node が v${NODE_VERSION} でない（NDA_NODE_BIN_DIR を指定したときは自分で入れる）"
    return
  fi
  [ "$(uname -m)" = aarch64 ] || { say "[失敗] aarch64 でない（$(uname -m)）"; exit 1; }
  local name="node-v${NODE_VERSION}-linux-arm64" tmp b
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/$name.tar.xz" "https://nodejs.org/dist/v${NODE_VERSION}/$name.tar.xz"
  if ! printf '%s  %s\n' "$NODE_SHA256" "$tmp/$name.tar.xz" | sha256sum -c --status; then
    rm -rf "$tmp"; say "[失敗] Node の tar の SHA-256 が合わない"; exit 1
  fi
  sudo install -d -m 755 /usr/local/lib/nodejs
  sudo rm -rf "/usr/local/lib/nodejs/$name"
  sudo tar -xJf "$tmp/$name.tar.xz" -C /usr/local/lib/nodejs --no-same-owner
  rm -rf "$tmp"
  for b in node npm npx corepack; do
    sudo ln -sfn "/usr/local/lib/nodejs/$name/bin/$b" "/usr/local/bin/$b"
  done
  say "[変更] Node v${NODE_VERSION} を /usr/local/lib/nodejs/$name に入れ、/usr/local/bin に node・npm・npx・corepack を張った"
}

main() {
  sudo -n true 2>/dev/null || { say "[失敗] パスワードなしの sudo が使えない"; exit 1; }
  [ "$(id -un)" = "nda" ] || { say "[失敗] nda ユーザーで流す想定（今は $(id -un)）"; exit 1; }

  ensure_pkgs git curl xz-utils ca-certificates
  install_node

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
  # 751: 他のユーザーは中を一覧できないが、logs/ へは通れる（聞き役の nda が記録を書くため）
  ensure_dir "$DATA_DIR" "$APP_USER" "$APP_USER" 751 "データ。${APP_USER} だけが書ける（logs へ通るだけは誰でも）"
  ensure_dir "$DATA_DIR/sessions" "$APP_USER" "$APP_USER" 750 "作業の状態（NDA_SESSION_DIR）"
  ensure_dir "$DATA_DIR/next-cache" "$APP_USER" "$APP_USER" 750 "next start のキャッシュ"
  # setgid で、中に作るファイルのグループを nda にそろえる（ファイルは書き手が 600 で作る）
  ensure_dir "$DATA_DIR/logs" "$APP_USER" nda 2770 "出来事の記録（NDA_LOG_DIR）。本体と聞き役が書く"
  ensure_dir "$ENV_DIR" root root 755 "秘密の値の置き場"
  # 受け箱の mount 先（mount は 58。先に作っておくと nda.service の ReadWritePaths が効く）
  if findmnt -n "$OFFICE_MNT" >/dev/null 2>&1; then
    say "[済] ${OFFICE_MNT} は mount 済み（58-office-share.sh）"
  else
    ensure_dir "$OFFICE_MNT" root root 755 "事務所の受け箱の mount 先"
  fi

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

  # --- 本体のコード（初回だけ clone。更新は 52-deploy.sh） ---
  if [ -d "$APP_DIR/.git" ]; then
    say "[済] ${APP_DIR} は clone 済み（$(git -C "$APP_DIR" rev-parse --short HEAD)。更新は 52-deploy.sh）"
  elif [ -z "$(ls -A "$APP_DIR")" ]; then
    git clone --quiet "$REPO_URL" "$APP_DIR"
    say "[変更] ${REPO_URL} を ${APP_DIR} に clone した（$(git -C "$APP_DIR" rev-parse --short HEAD)）"
  else
    say "[失敗] ${APP_DIR} が空でなく git でもない（中を確かめてから空にする）"; exit 1
  fi

  # --- 料金表（初回だけ写す。その後は /var/lib/nda の方が正。直すときはパスワード付きの sudo で） ---
  if sudo test -f "$DATA_DIR/ledger.json"; then
    say "[済] ${DATA_DIR}/ledger.json がある（上書きしない）"
  elif [ -f "$APP_DIR/data/ledger.json" ]; then
    sudo install -o "$APP_USER" -g "$APP_USER" -m 640 "$APP_DIR/data/ledger.json" "$DATA_DIR/ledger.json"
    say "[変更] ${APP_DIR}/data/ledger.json を ${DATA_DIR}/ledger.json に写した（NDA_LEDGER_PATH）"
  else
    say "[警告] ${APP_DIR}/data/ledger.json が無い（料金表が引けない）"
  fi

  # ExecStart は絶対パス。pnpm を挟まず node で next を直に起動する（実行時に corepack が pnpm を取りに行かないように）。
  # EnvironmentFile は Environment= より優先される（nda.env に同じ名前を書けばそちらが勝つ）。
  # MemoryDenyWriteExecute は V8 の JIT を壊すので入れない。ReadWritePaths の '-' は、無くても起動を止めない印。
  unit=$(cat <<UNIT
# deploy/pi/50-service.sh が管理する（手で編集しない）
[Unit]
Description=nDa (Next.js + libSQL)
After=network-online.target remote-fs.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
Environment=NEXT_TELEMETRY_DISABLED=1
Environment=PATH=${NODE_BIN_DIR}:/usr/bin:/bin
Environment=NDA_SESSION_DIR=${DATA_DIR}/sessions
Environment=NDA_LEDGER_PATH=${DATA_DIR}/ledger.json
Environment=NDA_LOG_DIR=${DATA_DIR}/logs
EnvironmentFile=-${ENV_FILE}
ExecStart=${NODE_BIN_DIR}/node ${APP_DIR}/node_modules/next/dist/bin/next start -H 127.0.0.1 -p 3000
Restart=always
RestartSec=5
UMask=0027

# 保護（本体の不具合が他へ広がらないように）
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=${DATA_DIR} -${OFFICE_MNT}
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
    say "[変更] ${UNIT_PATH} を書いて daemon-reload した（User=${APP_USER}、next start -H 127.0.0.1 -p 3000）"
    if ! systemd-analyze verify "$UNIT_PATH" >/dev/null 2>&1; then
      say "[警告] systemd-analyze verify ${UNIT_PATH} が通らない（52 で build する前は正常。あれば内容を見る）"
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

  # --- 事務所の返しの関所（LAN に出すのはこれだけ） ---
  # 中継するのは POST /api/office/reply だけ。DynamicUser で、受けるのは私設の LAN・Tailscale・自分だけ。
  # PartOf= で、nda.service の restart（52、60 の後もパスワードなし）に合わせて入れ直される。
  gate_unit=$(cat <<UNIT
# deploy/pi/50-service.sh が管理する（手で編集しない）
[Unit]
Description=nDa 事務所の返しの関所（0.0.0.0:3001 → 127.0.0.1:3000 の POST /api/office/reply だけ）
After=network-online.target nda.service
Wants=network-online.target
PartOf=nda.service

[Service]
Type=simple
DynamicUser=yes
WorkingDirectory=${APP_DIR}
Environment=NDA_GATE_HOST=0.0.0.0
Environment=NDA_GATE_PORT=3001
Environment=NDA_GATE_UPSTREAM=http://127.0.0.1:3000
ExecStart=${NODE_BIN_DIR}/node ${APP_DIR}/scripts/office-gate.ts
Restart=always
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
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
RestrictAddressFamilies=AF_INET AF_INET6
CapabilityBoundingSet=
AmbientCapabilities=
SystemCallArchitectures=native
SystemCallFilter=@system-service
IPAddressDeny=any
IPAddressAllow=localhost 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 fd00::/8

[Install]
WantedBy=multi-user.target
UNIT
)
  if [ -f "$GATE_UNIT_PATH" ] && [ "$(cat "$GATE_UNIT_PATH")" = "$gate_unit" ]; then
    say "[済] ${GATE_UNIT_PATH}"
  else
    printf '%s\n' "$gate_unit" | sudo tee "$GATE_UNIT_PATH" >/dev/null
    sudo chmod 644 "$GATE_UNIT_PATH"
    sudo systemctl daemon-reload
    say "[変更] ${GATE_UNIT_PATH} を書いた（0.0.0.0:3001 の POST /api/office/reply だけ → 127.0.0.1:3000）"
    if systemctl is-active --quiet nda-office-gate.service; then sudo systemctl restart nda-office-gate.service; fi
  fi
  if systemctl is-enabled --quiet nda-office-gate.service 2>/dev/null; then
    say "[済] nda-office-gate.service は enable 済み"
  else
    sudo systemctl enable nda-office-gate.service
    say "[変更] nda-office-gate.service を enable した"
  fi

  # build の前に起動すると落ち続けるので、build 済みのときだけ起動する（build と起動は 52-deploy.sh）
  if [ ! -f "$APP_DIR/.next/BUILD_ID" ]; then
    say "[情報] まだ build していないので start しない（次は 52-deploy.sh）"
  elif systemctl is-active --quiet nda.service; then
    say "[済] nda.service は active"
  else
    sudo systemctl start nda.service
    say "[変更] nda.service を start した"
  fi
  if [ -f "$APP_DIR/scripts/office-gate.ts" ] && ! systemctl is-active --quiet nda-office-gate.service; then
    sudo systemctl start nda-office-gate.service
    say "[変更] nda-office-gate.service を start した"
  fi
}
main </dev/null
