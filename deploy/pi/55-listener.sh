#!/usr/bin/env bash
# 55-listener.sh: 現場の聞き役（device/listener/listen.py）を nda のユーザーのサービスにする（docs/pi-setup.md §6-1）
#   起動語「んだ クロード」を Vosk（オフライン）で聞き、合図音の後の声を本体の POST /api/session/voice へ送る。
#   nda のユーザーのサービス（systemctl --user）にする理由:
#     - 画面の Chromium（ずんだもんの声）と同じ PipeWire のセッションに入り、Jabra を取り合わない
#     - 本体の更新（52-deploy.sh）の後に sudo なしで入れ直せる（60 の後も）
#   起動順: 本体（nda.service）の /monitor が応答するまで待ってから聞き始める（system と user のサービスは After= でつなげないため）。
#   置き場:
#     /opt/nda-listener/venv                       Python の venv（nda のもの）
#     /opt/nda-listener/vosk-model-small-ja-0.22   Vosk の日本語の小型モデル（公式から取り SHA-256 を確かめる）
#     ~/.config/systemd/user/nda-listener.service  サービス（コードは /opt/nda/device/listener を使う。52 で更新される）
# 流し方: ssh nda-pi 'bash -s' < deploy/pi/55-listener.sh   （50 と 52 の後。Jabra を挿した状態で）
# 環境変数（書けばサービスに入る。無ければ既定）:
#   NDA_LISTENER_INPUT   入力デバイス名の部分一致（既定 Jabra。PipeWire 経由にするなら pipewire）
#   NDA_LISTENER_OUTPUT  合図音の出力デバイス名の部分一致（既定 Jabra）
#   NDA_WAKE_CONF / NDA_SILENCE_RMS / NDA_STT_VENDOR   聞き役の閾値と STT（device/listener/README.md）
# 実機で確かめる:
#   - --list-devices の名前に Jabra が出るか。Jabra を直に開いたとき、Chromium の再生と取り合って "busy" にならないか
#     （なるなら NDA_LISTENER_INPUT=pipewire NDA_LISTENER_OUTPUT=pipewire で流し直す。PipeWire の既定は 40 が Jabra にする）
#   - 工場の騒音で起動語の conf と無音の閾値（device/listener/README.md の「Pi と Jabra に移すとき」）
set -euo pipefail

say() { printf '%s\n' "$*"; }
BASE=/opt/nda-listener
VENV="$BASE/venv"
APP_DIR=/opt/nda
LISTENER_DIR="$APP_DIR/device/listener"
MODEL_NAME=vosk-model-small-ja-0.22
MODEL_DIR="$BASE/$MODEL_NAME"
# https://alphacephei.com/vosk/models/vosk-model-small-ja-0.22.zip（2026-11-08 に取得。48MB）
MODEL_URL="https://alphacephei.com/vosk/models/${MODEL_NAME}.zip"
MODEL_SHA256=efa092d280153a77615e9e0c7d7283e93e600de3d19d3bec686c57ef19d52eac
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_PATH="$UNIT_DIR/nda-listener.service"
SERVER=http://127.0.0.1:3000
# 出来事の記録（docs/logging.md）。置き場は 50 が作る（nda-app:nda 2770）
LOG_DIR=/var/lib/nda/logs

put_file() { # 中身が違うときだけ書く。0 = 変更した、1 = 同じ
  local dest=$1 content=$2
  [ -f "$dest" ] && [ "$(cat "$dest")" = "$content" ] && return 1
  mkdir -p "$(dirname "$dest")"
  printf '%s\n' "$content" > "$dest"
  return 0
}

main() {
  sudo -n true 2>/dev/null || { say "[失敗] パスワードなしの sudo が使えない"; exit 1; }
  [ "$(id -un)" = "nda" ] || { say "[失敗] nda ユーザーで流す想定（今は $(id -un)）"; exit 1; }
  [ -f "$LISTENER_DIR/listen.py" ] || { say "[失敗] ${LISTENER_DIR}/listen.py が無い（先に 50 と 52）"; exit 1; }
  if [ -d "$LOG_DIR" ] && [ -w "$LOG_DIR" ]; then say "[済] ${LOG_DIR} に nda が書ける"
  else say "[警告] ${LOG_DIR} に nda が書けない（期待 nda-app:nda 2770。50-service.sh を流し直す）"; fi

  # --- apt ---
  missing=()
  for p in libportaudio2 python3-venv unzip curl; do dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p"); done
  if [ "${#missing[@]}" -eq 0 ]; then say "[済] apt: libportaudio2 python3-venv unzip curl"
  else
    sudo apt-get update -qq
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${missing[@]}"
    say "[変更] apt で入れた: ${missing[*]}"
  fi

  # --- 音声のグループ（Jabra を直に開くとき要る。PipeWire 経由なら無くても動く） ---
  if id -nG nda | tr ' ' '\n' | grep -qx audio; then say "[済] nda は audio グループ"
  else sudo usermod -aG audio nda; say "[変更] nda を audio グループに入れた（[要再起動] か再ログインで効く）"; fi

  # --- ログインしていなくても user のサービスを上げる（停電の後、自動ログインの前でも） ---
  if [ "$(loginctl show-user nda -p Linger --value 2>/dev/null || true)" = yes ]; then say "[済] nda の linger"
  else sudo loginctl enable-linger nda; say "[変更] nda の linger を有効にした"; fi

  # --- 置き場と venv ---
  if [ -d "$BASE" ] && [ "$(stat -c '%U' "$BASE")" = nda ]; then say "[済] ${BASE}"
  else sudo install -d -o nda -g nda -m 755 "$BASE"; say "[変更] ${BASE} を作った（nda:nda 755）"; fi
  [ -x "$VENV/bin/python" ] || { python3 -m venv "$VENV"; say "[変更] venv を作った（$(python3 -V)）"; }
  req_sum=$(sha256sum "$LISTENER_DIR/requirements.txt" | cut -d' ' -f1)
  if [ "$(cat "$VENV/.nda-req" 2>/dev/null || true)" = "$req_sum" ]; then
    say "[済] requirements.txt は入れ済み"
  else
    "$VENV/bin/pip" install -q --disable-pip-version-check -r "$LISTENER_DIR/requirements.txt"
    printf '%s\n' "$req_sum" > "$VENV/.nda-req"
    say "[変更] pip install -r requirements.txt"
  fi

  # --- Vosk のモデル ---
  if [ -f "$MODEL_DIR/.nda-sha256" ] && [ "$(cat "$MODEL_DIR/.nda-sha256")" = "$MODEL_SHA256" ]; then
    say "[済] ${MODEL_DIR}"
  else
    tmp=$(mktemp -d)
    curl -fsSL -o "$tmp/m.zip" "$MODEL_URL"
    if ! printf '%s  %s\n' "$MODEL_SHA256" "$tmp/m.zip" | sha256sum -c --status; then
      rm -rf "$tmp"; say "[失敗] Vosk のモデルの SHA-256 が合わない（${MODEL_URL}）"; exit 1
    fi
    unzip -q "$tmp/m.zip" -d "$tmp"
    [ -d "$tmp/$MODEL_NAME" ] || { rm -rf "$tmp"; say "[失敗] zip の中に ${MODEL_NAME} が無い"; exit 1; }
    rm -rf "$MODEL_DIR"
    mv "$tmp/$MODEL_NAME" "$MODEL_DIR"
    printf '%s\n' "$MODEL_SHA256" > "$MODEL_DIR/.nda-sha256"
    rm -rf "$tmp"
    say "[変更] Vosk のモデルを ${MODEL_DIR} に置いた（SHA-256 一致）"
  fi

  # --- サービス ---
  extra=""
  for v in NDA_WAKE_CONF NDA_SILENCE_RMS NDA_STT_VENDOR; do
    [ -n "${!v:-}" ] && extra+="Environment=${v}=${!v}"$'\n'
  done
  unit=$(cat <<UNIT
# deploy/pi/55-listener.sh が管理する（手で編集しない）
[Unit]
Description=nDa 現場の聞き役（起動語と録音）
After=pipewire.service wireplumber.service pipewire-pulse.service
Wants=pipewire.service

[Service]
Type=simple
Environment=PYTHONUNBUFFERED=1
Environment=NDA_SERVER_URL=${SERVER}
Environment=NDA_INPUT_DEVICE=${NDA_LISTENER_INPUT:-Jabra}
Environment=NDA_OUTPUT_DEVICE=${NDA_LISTENER_OUTPUT:-Jabra}
Environment=NDA_VOSK_MODEL=${MODEL_DIR}
Environment=NDA_LOG_DIR=${LOG_DIR}
${extra}# systemd の命令の行では \$ を \$\$ と書く（変数の置き換えを避ける）
# 本体の後: /monitor が応答するまで最大 3 分待つ（待ちきれなくても聞き始める。送れないときは聞き役が言う）
ExecStartPre=/bin/sh -c 'i=0; until curl -s -o /dev/null --max-time 2 ${SERVER}/monitor; do i=\$\$((i+1)); [ \$\$i -ge 90 ] && exit 0; sleep 2; done'
ExecStart=${VENV}/bin/python -I ${LISTENER_DIR}/listen.py
TimeoutStartSec=200
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT
)
  if put_file "$UNIT_PATH" "$unit"; then
    systemctl --user daemon-reload
    say "[変更] ${UNIT_PATH} を書いた（入力 ${NDA_LISTENER_INPUT:-Jabra}、出力 ${NDA_LISTENER_OUTPUT:-Jabra}）"
    changed=1
  else
    say "[済] ${UNIT_PATH}"; changed=0
  fi
  if systemctl --user is-enabled --quiet nda-listener.service 2>/dev/null; then say "[済] nda-listener.service は enable 済み"
  else systemctl --user enable nda-listener.service; say "[変更] nda-listener.service を enable した"; fi
  if [ "$changed" -eq 1 ] || ! systemctl --user is-active --quiet nda-listener.service; then
    systemctl --user restart nda-listener.service
    say "[変更] nda-listener.service を（再）起動した"
  else
    say "[済] nda-listener.service は active"
  fi

  say "[情報] デバイスの一覧: ${VENV}/bin/python -I ${LISTENER_DIR}/listen.py --list-devices"
  "$VENV/bin/python" -I "$LISTENER_DIR/listen.py" --list-devices 2>&1 | sed 's/^/    /' || true
  say "[情報] ログ: journalctl --user -u nda-listener.service -f（「起動語待ち」と出れば聞いている）"
}
main </dev/null
