#!/usr/bin/env bash
# 52-deploy.sh: 本体（/opt/nda）を GitHub の main に合わせ、build して nda.service を入れ直す。本体を更新するたびに流す。
#   sudo は `systemctl restart nda.service` だけを使う（60-sudo-tighten.sh の後もパスワードなしで通る）。
#   build は nda で行い（node_modules と .next は nda のもの）、nda-app は読むだけ。
#   next start が書くキャッシュ（.next/cache）は /var/lib/nda/next-cache へ向ける（/opt/nda は nda-app から読み取り専用）。
# 流し方: ssh nda-pi 'bash -s' < deploy/pi/52-deploy.sh
#   取るのは origin の main。push 済みのコミットしか届かない（Mac の手元だけのコミットは届かない）。
# 環境変数:
#   NDA_REF          合わせる先（既定 origin/main。例: NDA_REF=origin/feat/x、コミットの SHA）
#   NDA_FORCE_BUILD  1 なら、同じコミットでも build し直す
# 実機で確かめる:
#   - 4GB で next build が終わるか（落ちるなら NODE_OPTIONS の上限か swap を見る）。かかった秒数
set -euo pipefail

say() { printf '%s\n' "$*"; }
APP_DIR=/opt/nda
CACHE_DIR=/var/lib/nda/next-cache
REF="${NDA_REF:-origin/main}"
export PATH="/usr/local/bin:$PATH"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 NEXT_TELEMETRY_DISABLED=1

main() {
  [ "$(id -un)" = "nda" ] || { say "[失敗] nda ユーザーで流す想定（今は $(id -un)）"; exit 1; }
  [ -d "$APP_DIR/.git" ] || { say "[失敗] ${APP_DIR} に clone が無い（先に 50-service.sh）"; exit 1; }
  command -v corepack >/dev/null || { say "[失敗] corepack が無い（50-service.sh が Node を入れる）"; exit 1; }
  cd "$APP_DIR"

  # --- コード ---
  git fetch --quiet --prune origin
  want=$(git rev-parse --verify --quiet "${REF}^{commit}" || true)
  [ -n "$want" ] || { say "[失敗] ${REF} が見つからない"; exit 1; }
  if [ "$(git rev-parse HEAD)" = "$want" ] && [ -z "$(git status --porcelain)" ]; then
    say "[済] ${APP_DIR} は ${REF}（${want:0:7}）"
  else
    git checkout --quiet --force --detach "$want"
    # 追跡していない物を消す（.gitignore の node_modules・.next は残す）
    git clean -fdq
    say "[変更] ${APP_DIR} を ${REF}（${want:0:7} $(git log -1 --format=%s | cut -c1-60)）にした"
  fi

  # --- build（同じコミットで build 済みなら飛ばす） ---
  stamp=.next/nda-built-commit
  if [ "${NDA_FORCE_BUILD:-0}" != 1 ] && [ -f .next/BUILD_ID ] && [ "$(cat "$stamp" 2>/dev/null || true)" = "$want" ]; then
    say "[済] build 済み（${want:0:7}）"
    built=0
  else
    # build はキャッシュを書くので、前回 /var/lib/nda に向けた .next/cache の symlink を外してから
    [ -L .next/cache ] && rm .next/cache
    corepack pnpm install --frozen-lockfile --reporter=silent
    t0=$(date +%s)
    NODE_OPTIONS=--max-old-space-size=2560 corepack pnpm build >/tmp/nda-build.log 2>&1 || {
      tail -n 40 /tmp/nda-build.log; say "[失敗] next build（全文は /tmp/nda-build.log）"; exit 1; }
    printf '%s\n' "$want" > "$stamp"
    say "[変更] next build した（$(( $(date +%s) - t0 )) 秒）"
    built=1
  fi
  # 実行時のキャッシュは nda-app が書ける所へ
  if [ -L .next/cache ] && [ "$(readlink .next/cache)" = "$CACHE_DIR" ]; then
    say "[済] .next/cache → ${CACHE_DIR}"
  else
    rm -rf .next/cache
    ln -s "$CACHE_DIR" .next/cache
    say "[変更] .next/cache を ${CACHE_DIR} へ向けた"
  fi

  # --- 入れ直す ---
  if [ "$built" -eq 1 ] || ! systemctl is-active --quiet nda.service; then
    sudo -n systemctl restart nda.service
    say "[変更] nda.service を restart した"
  else
    say "[済] nda.service は active（同じ build）"
  fi
  for _ in $(seq 60); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:3000/monitor || true)
    [ "$code" = 200 ] && { say "[済] http://127.0.0.1:3000/monitor が 200"; return 0; }
    sleep 2
  done
  say "[失敗] /monitor が 200 にならない（最後は ${code:-応答なし}。journalctl -u nda.service -n 50）"
  exit 1
}
main </dev/null
