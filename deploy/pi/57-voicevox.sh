#!/usr/bin/env bash
# 57-voicevox.sh: ずんだもんの声（VOICEVOX ENGINE の Linux arm64 の CPU 版）を Pi で動かす（127.0.0.1:50021）
#   本体（lib/voice/tts.ts）は VOICEVOX_URL（既定 http://127.0.0.1:50021）へ問う。Pi で動かすなら nda.env に何も書かなくてよい。
#   公式の GitHub Releases の voicevox_engine-linux-cpu-arm64-<版>.7z.001（1 本、約 1.9GB）を取り、SHA-256 を確かめて
#   /opt/voicevox-engine/<版> に展開し、/opt/voicevox-engine/current をそこへ向ける。
#   サービス nda-voicevox.service は DynamicUser（その場限りのユーザー、書けるのは /var/lib/nda-voicevox だけ）。
#   起動の後に、ずんだもん（speaker 3）を読み込んでおく（最初の 1 文が遅くならないように）。
# 流し方: ssh nda-pi 'bash -s' < deploy/pi/57-voicevox.sh   （空きが 6GB 以上あること。取得に数分〜十数分）
# 環境変数: NDA_VOICEVOX_THREADS（既定 4。Pi 5 の芯の数）
# 実機で確かめる:
#   - 1 文の合成にかかる秒数（このスクリプトの最後と 90-verify.sh #14 が測る。目安 3 秒以内）。遅ければ README の「声の代わり」
#   - 4GB で本体の build と同時に動かしてメモリが足りるか（free -h）
set -euo pipefail

say() { printf '%s\n' "$*"; }
VERSION=0.26.1
ASSET="voicevox_engine-linux-cpu-arm64-${VERSION}.7z.001"
URL="https://github.com/VOICEVOX/voicevox_engine/releases/download/${VERSION}/${ASSET}"
# GitHub の Releases の asset の digest（2026-11-08 に gh api で確かめた）
SHA256=5090a25a9bdfeae666cf88c55085e0e3306b6ae39e778eba4f96d532441ab033
BASE=/opt/voicevox-engine
DEST="$BASE/$VERSION"
UNIT_PATH=/etc/systemd/system/nda-voicevox.service
THREADS="${NDA_VOICEVOX_THREADS:-4}"
SPEAKER=3   # lib/voice/tts.ts の ZUNDAMON_NORMAL と同じ
API=http://127.0.0.1:50021

main() {
  sudo -n true 2>/dev/null || { say "[失敗] パスワードなしの sudo が使えない"; exit 1; }
  [ "$(uname -m)" = aarch64 ] || { say "[失敗] aarch64 でない（$(uname -m)）"; exit 1; }

  # --- 7z を解く道具（trixie は 7zip の 7zz、bookworm は p7zip-full の 7z） ---
  if command -v 7zz >/dev/null || command -v 7z >/dev/null; then say "[済] 7z を解く道具がある"
  else
    sudo apt-get update -qq
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq 7zip 2>/dev/null \
      || sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq p7zip-full
    say "[変更] apt で 7z を解く道具を入れた"
  fi
  sz=$(command -v 7zz || command -v 7z)

  # --- 取得と展開 ---
  if [ -f "$DEST/.nda-sha256" ] && [ "$(cat "$DEST/.nda-sha256")" = "$SHA256" ]; then
    say "[済] ${DEST}"
  else
    free_kb=$(df -Pk /var/tmp | awk 'NR==2{print $4}')
    [ "$free_kb" -ge 6000000 ] || { say "[失敗] /var/tmp の空きが $((free_kb/1024))MB（6GB 以上要る）"; exit 1; }
    tmp=$(mktemp -d -p /var/tmp nda-voicevox.XXXXXX)
    say "[情報] 取得中: ${URL}"
    curl -fL --retry 3 -sS -o "$tmp/$ASSET" "$URL"
    if ! printf '%s  %s\n' "$SHA256" "$tmp/$ASSET" | sha256sum -c --status; then
      rm -rf "$tmp"; say "[失敗] SHA-256 が合わない（${ASSET}）"; exit 1
    fi
    "$sz" x -y -bd -o"$tmp/x" "$tmp/$ASSET" >/dev/null
    run=$(find "$tmp/x" -maxdepth 3 -type f -name run | head -n1)
    [ -n "$run" ] || { rm -rf "$tmp"; say "[失敗] 展開した中に run が無い"; exit 1; }
    sudo rm -rf "$DEST"
    sudo install -d -m 755 "$BASE"
    sudo mv "$(dirname "$run")" "$DEST"
    sudo chown -R root:root "$DEST"
    sudo chmod -R go-w,a+rX "$DEST"
    printf '%s\n' "$SHA256" | sudo tee "$DEST/.nda-sha256" >/dev/null
    rm -rf "$tmp"
    say "[変更] VOICEVOX ENGINE ${VERSION} を ${DEST} に置いた（SHA-256 一致）"
  fi
  if [ "$(readlink "$BASE/current" 2>/dev/null || true)" = "$DEST" ]; then say "[済] ${BASE}/current → ${DEST}"
  else sudo ln -sfn "$DEST" "$BASE/current"; say "[変更] ${BASE}/current → ${DEST}"; fi

  # --- サービス ---
  unit=$(cat <<UNIT
# deploy/pi/57-voicevox.sh が管理する（手で編集しない）
[Unit]
Description=VOICEVOX ENGINE for nDa (127.0.0.1:50021)
After=network.target

[Service]
Type=simple
DynamicUser=yes
StateDirectory=nda-voicevox
Environment=HOME=/var/lib/nda-voicevox
Environment=XDG_DATA_HOME=/var/lib/nda-voicevox
WorkingDirectory=${BASE}/current
ExecStart=${BASE}/current/run --host 127.0.0.1 --port 50021 --cpu_num_threads ${THREADS}
# 起動の後にずんだもんを読み込む（失敗しても止めない）
ExecStartPost=/bin/sh -c 'for i in \$\$(seq 120); do curl -sf -o /dev/null ${API}/version && break; sleep 1; done; curl -sf -o /dev/null -X POST "${API}/initialize_speaker?speaker=${SPEAKER}&skip_reinit=true" || true'
TimeoutStartSec=240
Restart=always
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6

[Install]
WantedBy=multi-user.target
UNIT
)
  changed=0
  if [ -f "$UNIT_PATH" ] && [ "$(cat "$UNIT_PATH")" = "$unit" ]; then say "[済] ${UNIT_PATH}"
  else
    printf '%s\n' "$unit" | sudo tee "$UNIT_PATH" >/dev/null
    sudo chmod 644 "$UNIT_PATH"; sudo systemctl daemon-reload; changed=1
    say "[変更] ${UNIT_PATH} を書いた（threads ${THREADS}）"
  fi
  if systemctl is-enabled --quiet nda-voicevox.service 2>/dev/null; then say "[済] nda-voicevox.service は enable 済み"
  else sudo systemctl enable nda-voicevox.service; say "[変更] nda-voicevox.service を enable した"; fi
  if [ "$changed" -eq 1 ] || ! systemctl is-active --quiet nda-voicevox.service; then
    sudo systemctl restart nda-voicevox.service
    say "[変更] nda-voicevox.service を（再）起動した"
  else say "[済] nda-voicevox.service は active"; fi

  # --- 1 文の合成の秒数（本体と同じ手順: audio_query → synthesis。音は捨てる） ---
  text="タイヤ交換、終わったのだ。請求書を事務所に送るのだ。"
  enc=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$text")
  t0=$(date +%s.%N)
  q=$(curl -sf -X POST "${API}/audio_query?text=${enc}&speaker=${SPEAKER}") || { say "[失敗] audio_query が通らない（journalctl -u nda-voicevox.service）"; exit 1; }
  printf '%s' "$q" | curl -sf -o /dev/null -X POST -H 'content-type: application/json' --data-binary @- "${API}/synthesis?speaker=${SPEAKER}" \
    || { say "[失敗] synthesis が通らない"; exit 1; }
  t1=$(date +%s.%N)
  say "[情報] 1 文（${#text} 文字）の合成: $(awk -v a="$t0" -v b="$t1" 'BEGIN{printf "%.2f", b-a}') 秒（目安 3 秒以内。遅ければ README の「声の代わり」）"
}
main </dev/null
