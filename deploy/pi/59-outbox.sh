#!/usr/bin/env bash
# 59-outbox.sh: 事務所の PC が SSH で取りに来る送り箱と門番を置く（#53・#56・#57。58 の SMB の代わり）
#   本体（nda-app）は送り箱 /var/lib/nda/outbox に <uuid>.json を置くだけ（mount しない）。
#   事務所の PC は nda-pull ユーザーで SSH し、authorized_keys の command= で門番（list/get/ack だけ）しか動かせない。
#   やること（何度流しても同じ結果）:
#     1. 送り箱 /var/lib/nda/outbox（nda-app:nda 2770）と目印 .nda-box
#     2. /etc/nda/nda.env の NDA_OFFICE_BOX=/var/lib/nda/outbox と NDA_OFFICE_BOX_REQUIRE_MOUNT=0
#        （その 2 つの行だけを書き換える・足す。他の行は読まない・表示しない）。変えたら nda.service を restart
#     3. nda-pull（nda グループ、パスワード無効、sudo なし）
#     4. 門番を /usr/local/bin/nda-outbox-gate（root 755）に置く。元は /opt/nda/deploy/pi/nda-outbox-gate.sh（52 で更新される）
#     5. 公開鍵を渡されたときだけ、~nda-pull/.ssh/authorized_keys を command=…,restrict の 1 行にする
#     6. 門番を確かめる（list が exit 0、ls が exit 64）
# 流し方: ssh nda-pi 'bash -s' < deploy/pi/59-outbox.sh                               （鍵なし。鍵待ちで終わる）
#         ssh nda-pi 'bash -s -- "ssh-ed25519 AAAA... nda-office"' < deploy/pi/59-outbox.sh  （鍵あり。NDA_OFFICE_PUBKEY でもよい）
#   50・52 の後、60 の前（パスワードなしの sudo を全部使う）。
# 環境変数:
#   NDA_OFFICE_PUBKEY     事務所の PC の pi-key.pub の 1 行（引数が優先）
#   NDA_OUTBOX_GATE_SRC   門番の元（既定 /opt/nda/deploy/pi/nda-outbox-gate.sh）
# 本体の書くファイルが 0640 になるのは lib/office/link.ts の変更が 52 で入った後（それまでは 0600 で nda-pull が読めない）。
# 公開鍵・指紋・IP は GitHub に書かない。
set -euo pipefail

say() { printf '%s\n' "$*"; }
APP_USER=nda-app
PULL_USER=nda-pull
OUTBOX=/var/lib/nda/outbox
MARKER="$OUTBOX/.nda-box"
ENV_FILE=/etc/nda/nda.env
GATE=/usr/local/bin/nda-outbox-gate
GATE_SRC="${NDA_OUTBOX_GATE_SRC:-/opt/nda/deploy/pi/nda-outbox-gate.sh}"
PUBKEY="${1:-${NDA_OFFICE_PUBKEY:-}}"
# 鍵の行は ssh-ed25519 と base64 と（あれば）英数字の注記だけ。" や , が入ると command= の外へ出られるので断る
KEY_RE='^ssh-ed25519 [A-Za-z0-9+/]+={0,2}( [A-Za-z0-9._@-]+)?$'

# nda.env の 1 行を書き換えるか足す。値は表示しない。0 = 変えた、1 = 同じ
set_env() {
  local key=$1 val=$2
  if sudo grep -qx "${key}=${val}" "$ENV_FILE"; then return 1; fi
  if sudo grep -q "^${key}=" "$ENV_FILE"; then
    sudo sed -i "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$val" | sudo tee -a "$ENV_FILE" >/dev/null
  fi
  return 0
}

main() {
  sudo -n true 2>/dev/null || { say "[失敗] パスワードなしの sudo が使えない（60 の後なら README の「60 の戻し方」で緩めてから）"; exit 1; }
  id "$APP_USER" >/dev/null 2>&1 || { say "[失敗] ${APP_USER} が無い（先に 50）"; exit 1; }
  getent group nda >/dev/null || { say "[失敗] nda グループが無い"; exit 1; }
  sudo test -f "$ENV_FILE" || { say "[失敗] ${ENV_FILE} が無い（鹿内さんが書く）"; exit 1; }
  [ -f "$GATE_SRC" ] || { say "[失敗] 門番の元 ${GATE_SRC} が無い（52 で main を入れるか NDA_OUTBOX_GATE_SRC で渡す）"; exit 1; }
  if [ -n "$PUBKEY" ] && ! [[ "$PUBKEY" =~ $KEY_RE ]]; then
    say "[失敗] 公開鍵の形が違う（ssh-ed25519 <base64> <注記> の 1 行だけ）。何も変えていない"; exit 1
  fi

  # --- 1. 送り箱と目印 ---
  if [ -d "$OUTBOX" ] && [ ! -L "$OUTBOX" ] && [ "$(stat -c '%U:%G %a' "$OUTBOX")" = "${APP_USER}:nda 2770" ]; then
    say "[済] ${OUTBOX}（${APP_USER}:nda 2770）"
  else
    sudo install -d -o "$APP_USER" -g nda -m 2770 "$OUTBOX"
    say "[変更] ${OUTBOX} を ${APP_USER}:nda 2770 にした"
  fi
  if sudo test -f "$MARKER"; then say "[済] 目印 ${MARKER}"
  else sudo -u "$APP_USER" touch "$MARKER"; say "[変更] 目印 ${MARKER} を置いた"; fi

  # --- 2. nda.env ---
  env_changed=0
  if set_env NDA_OFFICE_BOX "$OUTBOX"; then env_changed=1; say "[変更] nda.env: NDA_OFFICE_BOX=${OUTBOX}"
  else say "[済] nda.env: NDA_OFFICE_BOX=${OUTBOX}"; fi
  if set_env NDA_OFFICE_BOX_REQUIRE_MOUNT 0; then env_changed=1; say "[変更] nda.env: NDA_OFFICE_BOX_REQUIRE_MOUNT=0"
  else say "[済] nda.env: NDA_OFFICE_BOX_REQUIRE_MOUNT=0"; fi
  say "[情報] nda.env の持ち主と権限: $(sudo stat -c '%U:%G %a' "$ENV_FILE")（期待 ${APP_USER}:${APP_USER} 600）"
  if [ "$env_changed" -eq 1 ]; then
    sudo systemctl restart nda.service
    say "[変更] nda.service を再起動した"
  fi

  # --- 3. 取り出し用のユーザー ---
  if id "$PULL_USER" >/dev/null 2>&1; then say "[済] ${PULL_USER} がいる"
  else
    sudo useradd --create-home --shell /bin/bash --groups nda "$PULL_USER"
    say "[変更] ${PULL_USER} を作った（nda グループ）"
  fi
  if id -nG "$PULL_USER" | tr ' ' '\n' | grep -qx nda; then say "[済] ${PULL_USER} は nda グループ"
  else sudo usermod -aG nda "$PULL_USER"; say "[変更] ${PULL_USER} を nda グループに入れた"; fi
  if [ "$(sudo passwd -S "$PULL_USER" | awk '{print $2}')" = L ]; then say "[済] ${PULL_USER} のパスワードは無効"
  else sudo passwd -l "$PULL_USER" >/dev/null; say "[変更] ${PULL_USER} のパスワードを無効にした"; fi
  if id -nG "$PULL_USER" | tr ' ' '\n' | grep -qxE 'sudo|adm|wheel'; then
    say "[失敗] ${PULL_USER} が管理のグループに入っている: $(id -nG "$PULL_USER")"; exit 1
  fi
  if sudo -l -U "$PULL_USER" 2>/dev/null | grep -q 'may run the following'; then
    say "[失敗] ${PULL_USER} に sudo の許可がある"; exit 1
  fi
  say "[済] ${PULL_USER} に sudo は無い"

  # --- 4. 門番 ---
  if [ -f "$GATE" ] && cmp -s "$GATE_SRC" "$GATE" && [ "$(stat -c '%U:%G %a' "$GATE")" = "root:root 755" ]; then
    say "[済] ${GATE}（root 755、${GATE_SRC} と同じ）"
  else
    sudo install -o root -g root -m 755 "$GATE_SRC" "$GATE"
    say "[変更] ${GATE} を置いた（root 755）"
  fi

  # --- 5. 事務所の PC の鍵 ---
  home=$(getent passwd "$PULL_USER" | cut -d: -f6)
  if [ -z "$PUBKEY" ]; then
    say "[鍵待ち] 公開鍵を渡されていないので authorized_keys は書かない（事務所の PC の pi-key.pub を引数か NDA_OFFICE_PUBKEY で渡して流し直す）"
  else
    line="command=\"${GATE} ${OUTBOX}\",restrict ${PUBKEY}"
    if sudo test -f "$home/.ssh/authorized_keys" && [ "$(sudo cat "$home/.ssh/authorized_keys")" = "$line" ] \
       && [ "$(sudo stat -c '%U %a' "$home/.ssh/authorized_keys")" = "${PULL_USER} 600" ]; then
      say "[済] authorized_keys は門番の 1 行だけ"
    else
      sudo install -d -o "$PULL_USER" -g "$PULL_USER" -m 700 "$home/.ssh"
      tmp=$(mktemp)
      printf '%s\n' "$line" > "$tmp"
      sudo install -o "$PULL_USER" -g "$PULL_USER" -m 600 "$tmp" "$home/.ssh/authorized_keys"
      rm -f "$tmp"
      say "[変更] authorized_keys を門番の 1 行にした"
    fi
  fi

  # --- 6. 門番を確かめる ---
  rc=0; out=$(cd / && sudo -u "$PULL_USER" env SSH_ORIGINAL_COMMAND=list "$GATE" "$OUTBOX" 2>&1) || rc=$?
  if [ "$rc" -eq 0 ]; then say "[合格] list は exit 0（$(printf '%s' "$out" | grep -c . || true) 件）"
  else say "[不合格] list が exit ${rc}"; exit 1; fi
  rc=0; sudo -u "$PULL_USER" env SSH_ORIGINAL_COMMAND=ls "$GATE" "$OUTBOX" >/dev/null 2>&1 || rc=$?
  if [ "$rc" -eq 64 ]; then say "[合格] ls は exit 64（断る）"
  else say "[不合格] ls が exit ${rc}（期待 64）"; exit 1; fi
  say "[情報] ホスト鍵の指紋（事務所の控えと見比べる）: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub"
}
main </dev/null
