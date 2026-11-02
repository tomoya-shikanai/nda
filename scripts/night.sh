#!/bin/bash
# 夜間ループ。使い方は CLAUDE.md。作業は専用 worktree の中だけで行い、push しない。
set -uo pipefail

[ -z "${NIGHT_AWAKE:-}" ] && NIGHT_AWAKE=1 exec caffeinate -is "$0" "$@"

ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
DAY=$(date +%Y%m%d)
BRANCH=${NIGHT_BRANCH:-night/$DAY}
WT=${NIGHT_WORKTREE:-$ROOT/../nda-night}
BACKLOG=${NIGHT_BACKLOG:-tasks/backlog.md}
MAX_TASKS=${NIGHT_MAX_TASKS:-5}
TASK_SEC=${NIGHT_TASK_SEC:-2700}
CLAUDE_BIN=${NIGHT_CLAUDE:-claude}
MODEL=${NIGHT_MODEL:-claude-opus-5-5}
LOG=${NIGHT_LOG:-$ROOT/.night/$DAY}
BASE_REF=${NIGHT_BASE:-main}
REPORT=$LOG/report.md
mkdir -p "$LOG"

END=${NIGHT_END_EPOCH:-$(date -v7H -v0M -v0S +%s)}
[ "$END" -le "$(date +%s)" ] && END=$(date -v+1d -v7H -v0M -v0S +%s)

say() { echo "$*" | tee -a "$REPORT"; }
stop() { say "- 停止: $1"; say "- 差分: $(git -C "$WT" diff --shortstat "$BASE" HEAD)"; exit "${2:-0}"; }

if [ -d "$WT/.git" ] || [ -f "$WT/.git" ]; then
  # 2 晩目以降は既存 worktree に新しいブランチを作る
  git -C "$WT" switch -q "$BRANCH" 2>/dev/null || git -C "$WT" switch -q -c "$BRANCH" "$BASE_REF" || exit 1
else
  git -C "$ROOT" worktree add -q -B "$BRANCH" "$WT" "$BASE_REF" || exit 1
fi
cd "$WT" || exit 1
[ -z "$(git status --porcelain)" ] || { echo "worktree が汚れている: $WT"; exit 1; }
BASE=$(git rev-parse HEAD)
pnpm install --offline --frozen-lockfile --silent || exit 1

# ゲートと規則そのもの。エージェントが変えたら不合格にする。
PROTECTED='^(\.claude/|\.githooks/|tasks/|scripts/(check|night)\.sh$|lib/karte/verify\.ts$|docs/preregistration\.md$|package\.json$|pnpm-lock\.yaml$|\.gitignore$|eslint\.config\.[^/]+$|tsconfig\.json$|next\.config\.[^/]+$|pnpm-workspace\.yaml$|\.npmrc$)'

mark() { # ID 記号
  sed -i '' "s/^- \[ \] $1 |/- [$2] $1 |/" "$BACKLOG"
  git add "$BACKLOG" && git commit -q -m "chore: 夜間タスク $1 を [$2] にする"
}

say "# 夜間実行 $(date '+%F %T') ブランチ $BRANCH"
done_n=0; fail_n=0
while [ "$done_n" -lt "$MAX_TASKS" ]; do
  line=$(grep -m1 '^- \[ \] ' "$BACKLOG") || stop "未着手タスクなし"
  id=$(echo "$line" | sed -E 's/^- \[ \] ([^ ]+) .*/\1/')
  title=$(echo "$line" | cut -d'|' -f2 | sed -E 's/^ +| +$//g')
  left=$(( END - $(date +%s) ))
  [ "$left" -gt 300 ] || stop "終了時刻"
  limit=$(( left < TASK_SEC ? left : TASK_SEC ))
  start=$(git rev-parse HEAD); out=$LOG/$id.json; t0=$(date +%s)

  # timeout が macOS に無いので perl の alarm で打ち切る（SIGALRM で終了）
  { cat "$ROOT/tasks/night-prompt.md"; printf '\n## タスク\n%s\n' "$line"; } | \
    perl -e 'alarm shift; exec @ARGV' "$limit" "$CLAUDE_BIN" -p --output-format json \
      --setting-sources project --settings "$ROOT/.claude/night-settings.json" \
      --permission-mode acceptEdits --model "$MODEL" --effort medium > "$out" 2> "$out.err"
  rc=$?
  sec=$(( $(date +%s) - t0 ))
  result=$(jq -r '.result // ""' "$out" 2>/dev/null)
  cost=$(jq -r '.total_cost_usd // "?"' "$out" 2>/dev/null)

  rollback() {
    if [ -n "$(git status --porcelain)" ]; then
      git add -A && git commit -q --no-verify -m "wip: $id 失敗時の退避"
    fi
    [ "$(git rev-parse HEAD)" != "$start" ] && git branch -f "night-failed/$DAY-$id" HEAD
    git reset -q --hard "$start" && git clean -fdq
  }

  # 利用上限はタスクの失敗ではない。未着手に戻して止まる。
  if [ "$rc" -ne 0 ] && grep -qiE 'usage limit|rate limit|limit reached|hit your limit|429' "$out" "$out.err"; then
    rollback; stop "利用上限（$id は未着手に戻した）"
  fi

  reason=""
  if [ "$rc" -ne 0 ]; then reason="claude 終了コード $rc"
  elif [ "$(printf '%s' "$result" | head -1 | cut -c1-8)" = "BLOCKED:" ]; then reason=$(printf '%s' "$result" | head -1)
  elif ! git add -A; then reason="git add 失敗"
  elif [ -z "$(git status --porcelain)" ]; then reason="変更なし"
  elif ! changed=$(git diff --cached --no-renames --name-only -z "$start" | tr '\0' '\n'; exit "${PIPESTATUS[0]}"); then reason="差分の取得に失敗"
  elif touched=$(printf '%s\n' "$changed" | grep -E "$PROTECTED"); then reason="保護対象を変更: $(echo $touched)"
  elif ! pnpm -s check > "$LOG/$id.check.log" 2>&1; then reason="ゲート不合格（$LOG/$id.check.log）"
  elif ! git commit -q -m "$title" -m "夜間ループで実装した。" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"; then reason="コミット失敗"
  fi

  if [ -z "$reason" ]; then
    mark "$id" x; fail_n=0; done_n=$(( done_n + 1 ))
    say "- [x] $id ${sec}s \$$cost: $(printf '%s' "$result" | head -1)"
  else
    rollback; mark "$id" '!'; fail_n=$(( fail_n + 1 ))
    say "- [!] $id ${sec}s \$$cost: $reason"
    [ "$fail_n" -ge 2 ] && stop "連続 2 回失敗"
  fi
done
stop "上限 $MAX_TASKS タスク"
