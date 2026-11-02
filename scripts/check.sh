#!/bin/bash
# ゲート。--scan は公開してはいけない物の検査だけ（pre-commit 用）。引数なしは全部。
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

scan() {
  local bad=0 hits
  # 索引の内容を見る（コミットされる物そのもの）
  hits=$(git ls-files --cached | grep -E '^data/(audio|transcripts|kartes)/|^data/recordings/[^.]|(^|/)\.env($|\.)|\.(mov|mp4|wav|m4a|mp3|aac|flac|db)$' -i)
  if [ -n "$hits" ]; then
    echo "NG: 追跡してはいけないファイル:"; echo "$hits"; bad=1
  fi
  hits=$(git grep --cached -nIE 'sk-ant-[A-Za-z0-9_-]{8,}|\b0[0-9]{1,4}-[0-9]{1,4}-[0-9]{4}\b' -- . ':!pnpm-lock.yaml' ':!scripts/check.sh')
  if [ -n "$hits" ]; then
    echo "NG: API キーか電話番号らしき文字列:"; echo "$hits"; bad=1
  fi
  return $bad
}

scan || exit 1
[ "${1:-}" = "--scan" ] && exit 0

# build が next-env.d.ts を生成するので typecheck より先
for step in lint test build typecheck; do
  echo "== $step"
  pnpm -s "$step" || { echo "NG: $step"; exit 1; }
done
echo "OK: check"
