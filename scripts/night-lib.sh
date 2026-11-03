#!/bin/bash
# 夜間ループと点検（probe）が共有する Claude の起動方法。
# 環境変数は最小にし、道具・権限・sandbox は night-settings.json だけで決める。
# --bare は使わない（OAuth を読まず、危険コマンドのフックと CLAUDE.md も読み飛ばすため）。

# 実行時の設定を作る。sandbox で読めなくする場所は、作業する worktree 以外の
# ~/dev の案件すべて、本体リポジトリ（.git を除く）、秘密の置き場。
# ホーム全体を拒否すると node（Volta）が現在のフォルダを解決できず動かないので列挙する。
night_settings() { # <worktree> <出力先>
  local wt deny=() d
  wt=$(cd "$1" && pwd -P)
  for d in "$HOME"/dev/* "$HOME"/dev/personal/* "$ROOT"/* "$ROOT"/.[!.]*; do
    d=$(cd "$d" 2>/dev/null && pwd -P || echo "$d")
    case "$d" in
      "$wt"|"$HOME/dev/personal"|"$ROOT"|"$ROOT/.git") continue ;;
      "$ROOT"/*) ;;
      "$(cd "$ROOT" && pwd -P)") continue ;;
    esac
    deny+=("$d")
  done
  for d in .ssh .aws .gnupg .config .netrc .npmrc .claude.json Library/Keychains Documents Desktop Downloads Private; do
    deny+=("$HOME/$d")
  done
  # --args の後ろは全部文字列扱いになるので、設定ファイルは標準入力で渡す
  jq --args '.sandbox.filesystem.denyRead = $ARGS.positional' "${deny[@]}" < "$ROOT/.claude/night-settings.json" > "$2"
}

# night_claude <秒数> <出力形式 json|stream-json> [追加の引数...] < プロンプト
night_claude() {
  local limit=$1 format=$2; shift 2
  local extra=()
  [ "$format" = "stream-json" ] && extra+=(--verbose)
  # timeout が macOS に無いので perl の alarm で打ち切る（SIGALRM で終了）
  env -i PATH="$PATH" HOME="$HOME" USER="$USER" LOGNAME="${LOGNAME:-$USER}" LANG="${LANG:-ja_JP.UTF-8}" TMPDIR="${TMPDIR:-/tmp}" \
    perl -e 'alarm shift; exec @ARGV' "$limit" "${NIGHT_CLAUDE:-claude}" -p \
      --output-format "$format" "${extra[@]}" \
      --setting-sources project --settings "$NIGHT_SETTINGS" \
      --permission-mode acceptEdits --permission-prompts none \
      --strict-mcp-config --no-session-persistence \
      --model "${NIGHT_MODEL:-claude-opus-5-5}" --effort medium \
      --max-budget-usd "${NIGHT_TASK_USD:-5}" "$@"
}

# タスクの結果の形。BLOCKED の判定を文字列の先頭一致に頼らない。
NIGHT_SCHEMA='{"type":"object","properties":{"status":{"type":"string","enum":["done","blocked"]},"summary":{"type":"string"},"reason":{"type":"string"}},"required":["status","summary"],"additionalProperties":false}'
