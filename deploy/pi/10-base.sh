#!/usr/bin/env bash
# 10-base.sh: 更新と基本（docs/pi-setup.md §6-1）
#   apt full-upgrade、ja_JP.UTF-8 / en_US.UTF-8 の locale-gen、タイムゾーンの確認。
# 流し方: ssh nda-pi 'bash -s' < deploy/pi/10-base.sh
# 注意: sudo を絞った後（60 の後）に流し直すと locale-gen が通らない。README の戻し方を見る。
set -euo pipefail

say() { printf '%s\n' "$*"; }

# main の中身は bash が先に全部読み込む。stdin を塞いで、apt などがスクリプトの続きを食べないようにする。
main() {
  sudo -n true 2>/dev/null || { say "[失敗] パスワードなしの sudo が使えない"; exit 1; }

  # --- apt full-upgrade ---
  sudo apt-get update -qq
  pending=$(apt-get -s full-upgrade | grep -c '^Inst' || true)
  if [ "$pending" -eq 0 ]; then
    say "[済] apt: 更新するパッケージは無い"
  else
    say "[変更] apt full-upgrade: ${pending} 件を更新する"
    sudo DEBIAN_FRONTEND=noninteractive apt-get full-upgrade -y \
      -o Dpkg::Options::=--force-confold -o Dpkg::Options::=--force-confdef
    say "[変更] apt full-upgrade: 完了"
  fi
  if [ -e /var/run/reboot-required ]; then
    say "[要再起動] カーネル等が更新された。再起動は鹿内さんに伝えてから行う（sudo reboot）"
  fi

  # --- locale ---
  changed=0
  for loc in ja_JP.UTF-8 en_US.UTF-8; do
    if grep -q "^${loc} UTF-8" /etc/locale.gen; then
      say "[済] /etc/locale.gen: ${loc} は有効"
    else
      sudo sed -i "s/^# *${loc} UTF-8/${loc} UTF-8/" /etc/locale.gen
      grep -q "^${loc} UTF-8" /etc/locale.gen || { say "[失敗] /etc/locale.gen に ${loc} の行が無い"; exit 1; }
      say "[変更] /etc/locale.gen: ${loc} を有効にした"
      changed=1
    fi
  done
  # locale -a は ja_JP.utf8 の形で出す
  if [ "$changed" -eq 1 ] || ! locale -a | grep -qix 'ja_JP.utf8' || ! locale -a | grep -qix 'en_US.utf8'; then
    sudo locale-gen
    say "[変更] locale-gen を実行した"
  else
    say "[済] locale: ja_JP.utf8 と en_US.utf8 は生成済み"
  fi

  # --- タイムゾーン（確認だけ。変えない） ---
  tz=$(timedatectl show -p Timezone --value)
  if [ "$tz" = "Asia/Tokyo" ]; then
    say "[済] タイムゾーン: Asia/Tokyo"
  else
    say "[失敗] タイムゾーンが ${tz}（期待は Asia/Tokyo）。Imager の設定を確認し、必要なら sudo timedatectl set-timezone Asia/Tokyo"
    exit 1
  fi
  if [ "$(timedatectl show -p NTPSynchronized --value)" = "yes" ]; then
    say "[済] 時刻: NTP で同期済み（$(date '+%F %T %Z')）"
  else
    say "[警告] 時刻が NTP で同期されていない（ネットワークを確認。$(date '+%F %T %Z')）"
  fi
}
main </dev/null
