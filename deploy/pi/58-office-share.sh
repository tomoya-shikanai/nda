#!/usr/bin/env bash
# 58-office-share.sh: 事務所の PC（Windows）の共有フォルダ（受け箱）を /mnt/nda-office に mount する
#   運び道は同じ LAN の SMB（docs/decisions.md 2026-11-05、docs/design/pi-office.md §9-4）。本体は NDA_OFFICE_BOX に書く。
#   systemd の mount と automount のユニットにする（x-systemd.automount と同じ形）。触れたときに mount するので、
#   Pi の起動時に事務所の PC が止まっていても、後で PC が上がれば次の書き込みでつながる。
#   ファイルの持ち主は nda-app（本体が書く）、グループは nda（90-verify.sh が目印を読める）。
#   通り道は暗号化する（seal。事務所の PC 側も Set-SmbShare -EncryptData $true。README の「鹿内さんがやる設定」）。
#   名前の解決（.local・NetBIOS）は同じ LAN の中でなりすませる。解決した IP を出すので、鹿内さんが PC の IP と同じか確かめる。
#   資格情報は /etc/nda/office-share.cred（root:root 600。鹿内さんが書く。このスクリプトは中身を読まない）:
#       username=<事務所の PC の共有用のユーザー>
#       password=<そのパスワード>
#       domain=<PC 名か WORKGROUP。要らなければ書かない>
# 流し方: ssh nda-pi 'NDA_OFFICE_HOST=<PC 名> NDA_OFFICE_SHARE=<共有名> bash -s' < deploy/pi/58-office-share.sh
# 環境変数:
#   NDA_OFFICE_HOST    （必須）事務所の PC の名前（Windows の PC 名）か IP。名前なら <名前>.local（mDNS）を先に試し、
#                      だめなら NetBIOS（nmblookup）で IP を引く（そのときは IP で mount する。DHCP で変わるなら予約する）
#   NDA_OFFICE_SHARE   （必須）共有名（\\<PC>\<共有名> の後ろ。受け箱 C:\nda\box\in を共有した名前）
#   NDA_OFFICE_SUBDIR  共有の中の受け箱の位置（既定 空 = 共有の一番上が受け箱）
#   NDA_OFFICE_SMB_VERS SMB の版（既定 3.0。3.0・3.02・3.1.1・3 だけ許す。暗号化（seal）に 3.0 以上が要る）
# 実機で確かめる:
#   - <PC 名>.local が Pi から引けるか（getent hosts）。Windows の mDNS の応答は版で違う
#   - 共有の権限（共有用のユーザーが受け箱に書けて名前を変えられる）。目印 .nda-box が見えるか
#   - 事務所の PC の再起動・スリープの後、次の書き込みで戻るか（戻らないとき: sudo systemctl restart <ユニット>.automount）
set -euo pipefail

say() { printf '%s\n' "$*"; }
MNT=/mnt/nda-office
CRED=/etc/nda/office-share.cred
HOST_IN="${NDA_OFFICE_HOST:-}"
SHARE="${NDA_OFFICE_SHARE:-}"
SUBDIR="${NDA_OFFICE_SUBDIR:-}"
VERS="${NDA_OFFICE_SMB_VERS:-3.0}"

main() {
  [ -n "$HOST_IN" ] && [ -n "$SHARE" ] || {
    say "[失敗] NDA_OFFICE_HOST と NDA_OFFICE_SHARE が要る（例: ssh nda-pi 'NDA_OFFICE_HOST=JIMUSHO-PC NDA_OFFICE_SHARE=nda-box bash -s' < deploy/pi/58-office-share.sh）"
    exit 1; }
  case "$SHARE$SUBDIR" in *[[:space:]\\\'\"]*) say "[失敗] 共有名と SUBDIR に空白・\\・引用符は使えない"; exit 1 ;; esac
  case "$VERS" in 3|3.0|3.02|3.1.1) ;; *) say "[失敗] NDA_OFFICE_SMB_VERS=${VERS} は使わない（3.0 以上だけ。暗号化に要る）"; exit 1 ;; esac
  sudo -n true 2>/dev/null || { say "[失敗] パスワードなしの sudo が使えない"; exit 1; }
  id nda-app >/dev/null 2>&1 || { say "[失敗] nda-app が無い（先に 50-service.sh）"; exit 1; }

  # --- 道具 ---
  missing=()
  for p in cifs-utils samba-common-bin; do dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p"); done
  if [ "${#missing[@]}" -eq 0 ]; then say "[済] apt: cifs-utils samba-common-bin"
  else
    sudo apt-get update -qq
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${missing[@]}"
    say "[変更] apt で入れた: ${missing[*]}"
  fi

  # --- 宛先の名前を引く ---
  if [[ "$HOST_IN" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    server=$HOST_IN; say "[情報] 宛先は IP ${server}（DHCP で変わるなら、ルーターで予約する）"
  elif getent ahostsv4 "${HOST_IN}.local" >/dev/null 2>&1; then
    server="${HOST_IN}.local"; say "[済] ${server} を mDNS で引けた（$(getent ahostsv4 "$server" | awk 'NR==1{print $1}')）"
  else
    ip=$(nmblookup "$HOST_IN" 2>/dev/null | awk -v h="$HOST_IN" 'tolower($2)==tolower(h"<00>"){print $1; exit}')
    [ -n "$ip" ] || { say "[失敗] ${HOST_IN}.local も NetBIOS も引けない（同じ LAN か、PC 名か、PC が起きているかを確かめる。IP を渡してもよい）"; exit 1; }
    server=$ip; say "[警告] mDNS で引けず、NetBIOS で ${ip} を得た。IP で mount する（DHCP で変わるなら予約する）"
  fi

  ip_now=$(getent ahostsv4 "$server" 2>/dev/null | awk 'NR==1{print $1}' || true)
  say "[確認] 宛先 ${server} は今 ${ip_now:-$server} に解決された。事務所の PC の IP（PC で ipconfig）と同じかを鹿内さんに確かめてもらう（違えば止める）"

  # --- 資格情報（権限だけ見る） ---
  if sudo test -f "$CRED"; then
    st=$(sudo stat -c '%U:%G %a' "$CRED")
    if [ "$st" = "root:root 600" ]; then say "[済] ${CRED} は ${st}"
    else say "[警告] ${CRED} が ${st}（期待は root:root 600。sudo chown root:root ${CRED} && sudo chmod 600 ${CRED}）"; fi
  else
    say "[警告] ${CRED} が無い。鹿内さんが書くまで mount できない（書き方はこのスクリプトの頭と deploy/pi/README.md）"
  fi

  # --- ユニット ---
  [ -d "$MNT" ] || findmnt -n "$MNT" >/dev/null 2>&1 || { sudo install -d -m 755 "$MNT"; say "[変更] ${MNT} を作った"; }
  name=$(systemd-escape -p "$MNT")
  app_uid=$(id -u nda-app); nda_gid=$(id -g nda)
  opts="credentials=${CRED},vers=${VERS},seal,uid=${app_uid},gid=${nda_gid},file_mode=0640,dir_mode=0750,iocharset=utf8,noserverino,_netdev,nofail"
  mount_unit=$(cat <<UNIT
# deploy/pi/58-office-share.sh が管理する（手で編集しない）
[Unit]
Description=nDa: 事務所の受け箱（//${server}/${SHARE}）
After=network-online.target
Wants=network-online.target

[Mount]
What=//${server}/${SHARE}
Where=${MNT}
Type=cifs
Options=${opts}
TimeoutSec=15
UNIT
)
  auto_unit=$(cat <<UNIT
# deploy/pi/58-office-share.sh が管理する（手で編集しない）
[Unit]
Description=nDa: 事務所の受け箱を触れたときに mount する

[Automount]
Where=${MNT}
TimeoutIdleSec=0

[Install]
WantedBy=remote-fs.target
UNIT
)
  changed=0
  for pair in "mount:$mount_unit" "automount:$auto_unit"; do
    kind=${pair%%:*}; body=${pair#*:}
    path="/etc/systemd/system/${name}.${kind}"
    if [ -f "$path" ] && [ "$(cat "$path")" = "$body" ]; then say "[済] ${path}"
    else printf '%s\n' "$body" | sudo tee "$path" >/dev/null; sudo chmod 644 "$path"; changed=1; say "[変更] ${path} を書いた"; fi
  done
  if [ "$changed" -eq 1 ]; then
    sudo systemctl daemon-reload
    # 宛先や options が変わったとき、古い mount を外して次に触れたときに新しい設定で mount させる
    sudo systemctl stop "${name}.automount" "${name}.mount" 2>/dev/null || true
  fi
  if systemctl is-enabled --quiet "${name}.automount" 2>/dev/null; then say "[済] ${name}.automount は enable 済み"
  else sudo systemctl enable "${name}.automount"; say "[変更] ${name}.automount を enable した"; fi
  sudo systemctl start "${name}.automount"

  # --- 確かめ（触れて mount させる） ---
  box="$MNT${SUBDIR:+/$SUBDIR}"
  if sudo test -f "$CRED" && sudo timeout 20 stat "$box/." >/dev/null 2>&1 && findmnt -n -t cifs "$MNT" >/dev/null; then
    say "[済] ${MNT} に //${server}/${SHARE} が mount された"
    if sudo test -e "$box/.nda-box"; then say "[済] 受け箱 ${box} に目印 .nda-box がある"
    else say "[警告] ${box} に目印 .nda-box が無い（事務所側が置く。無い間、本体は「事務所に届きません」と出す）"; fi
  else
    say "[警告] mount できなかった（journalctl -u ${name}.mount -n 20。資格情報・共有名・PC が起きているか）"
  fi
  say "[情報] /etc/nda/nda.env に NDA_OFFICE_BOX=${box} と書く（NDA_OFFICE_BOX_REQUIRE_MOUNT は書かない＝mount を確かめる）。書いたら sudo systemctl restart nda.service"
}
main </dev/null
