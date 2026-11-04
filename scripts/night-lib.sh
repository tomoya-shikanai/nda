#!/bin/bash
# 夜間ループと点検（probe）が共有する Claude の起動方法。
# 環境変数は最小にし、道具・権限・sandbox は night-settings.json だけで決める。
# --bare は使わない（OAuth を読まず、危険コマンドのフックと CLAUDE.md も読み飛ばすため）。

# 実行時の設定を作る。sandbox で読めなくする場所は、ホーム直下のすべて
# （node・pnpm・git が要る .volta・Library/pnpm・.gitconfig* を除く）、作業する worktree 以外の
# ~/dev の案件すべて、本体リポジトリ（.git を除く）。
# ホームそのものを拒否すると node（Volta）が現在のフォルダを解決できず動かないので、中身を列挙する。
night_settings() { # <worktree> <出力先>
  local wt root deny=() d tmp
  wt=$(cd "$1" && pwd -P); root=$(cd "$ROOT" && pwd -P)
  for d in "$HOME"/* "$HOME"/.[!.]* "$HOME"/Library/* "$HOME"/dev/* "$HOME"/dev/personal/* "$root"/* "$root"/.[!.]*; do
    [ -e "$d" ] || [ -L "$d" ] || continue
    case "$d" in
      "$HOME/dev"|"$HOME/.volta"|"$HOME/Library"|"$HOME/Library/pnpm"|"$HOME"/.gitconfig*) continue ;;
      "$HOME/dev/personal"|"$root"|"$root/.git"|"$wt") continue ;;
    esac
    deny+=("$d")
  done
  # worktree の下の .env* と .envrc（.env.example は除く）。どこにでも当たる glob にせず絶対パスで拒否する
  # （glob だと試験が一時フォルダに作る .env まで読めなくなる）。まだ無くても、よく使う名前は前もって入れる。
  deny+=("$wt/.env" "$wt/.env.local" "$wt/.env.development" "$wt/.env.production" "$wt/.envrc")
  while IFS= read -r d; do deny+=("$d"); done < <(
    find "$wt" \( -name node_modules -o -name .git \) -prune -o \
      \( -name '.env' -o -name '.env.*' -o -name '.envrc' \) ! -name '.env.example' -print 2>/dev/null)
  # tsx は一時フォルダにソケットを作る。Claude の sandbox が割り当てる一時フォルダの下だけ許す。
  tmp=/tmp/claude-$(id -u)
  # --args の後ろは全部文字列扱いになるので、設定ファイルは標準入力で渡す
  # Read の道具にも同じ場所を絶対パスで拒否する（//** の glob は試験の一時フォルダまで塞ぐので使わない）
  jq --arg t "$tmp" --arg w "$wt" --args '.sandbox.filesystem.denyRead = $ARGS.positional
    | .permissions.deny += ($ARGS.positional | map("Read(/" + . + ")", "Read(/" + . + "/**)"))
    | .permissions.deny |= map(
        # 保護ファイルの Edit/Write 拒否は sandbox にも効く。**/package.json のままだと
        # .next/package.json まで書けずビルドが落ちるので、worktree の直下に固定する。
        if test("^(Edit|Write)\\(\\*\\*/") and (test("node_modules") | not)
        then sub("\\(\\*\\*/"; "(/" + $w + "/") else . end)
    | .permissions.deny += ["Read(/" + $w + "/**/.env)", "Read(/" + $w + "/**/.env.*)", "Read(/" + $w + "/**/.envrc)"]
    | .sandbox.network.allowUnixSockets = [$t, "/private" + $t]' "${deny[@]}" \
    < "$ROOT/.claude/night-settings.json" > "$2"
}

# 決まった node の置き場が sandbox の読み取り禁止の下にあれば、黙って不合格にせず止める。
night_check_node() { # <node の置き場>
  local bin=$1 d
  case "$bin" in
    "$HOME/.volta"/*|"$HOME/Library/pnpm"/*|/opt/homebrew/*|/usr/*|/bin|/sbin) return 0 ;;
    "$HOME"/*)
      d=${bin#"$HOME"/}; d="$HOME/${d%%/*}"
      echo "node の置き場 $bin は sandbox の読み取り禁止（${d}）の下にあります。Volta の node を使える状態にしてから起動してください。" >&2
      return 1 ;;
  esac
  return 0
}

# night_claude <秒数> <出力形式 json|stream-json> [追加の引数...] < プロンプト
night_claude() {
  local limit=$1 format=$2; shift 2
  local extra=()
  [ "$format" = "stream-json" ] && extra+=(--verbose)
  # PATH は最小にする。Volta の pnpm は自分を PATH から外して ~/Library/pnpm に渡すので、
  # 本物の node の置き場を直接入れる（~/.nvm などは sandbox で読めない）。
  local node_bin run_path
  # pnpm 経由の起動では PATH に ~/.volta/bin が無いので、volta を絶対パスで呼ぶ。
  if [ -x "$HOME/.volta/bin/volta" ]; then
    node_bin=$(dirname "$("$HOME/.volta/bin/volta" which node 2>/dev/null)")
  else
    node_bin=$(dirname "$(command -v node)")
  fi
  night_check_node "$node_bin" || return 1
  run_path="$node_bin:$HOME/Library/pnpm:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  # timeout が macOS に無いので perl の alarm で打ち切る（SIGALRM で終了）
  env -i PATH="$run_path" HOME="$HOME" USER="$USER" LOGNAME="${LOGNAME:-$USER}" LANG="${LANG:-ja_JP.UTF-8}" TMPDIR="${TMPDIR:-/tmp}" \
    perl -e 'alarm shift; exec @ARGV' "$limit" "$(command -v "${NIGHT_CLAUDE:-claude}")" -p \
      --output-format "$format" ${extra[@]+"${extra[@]}"} \
      --setting-sources project --settings "$NIGHT_SETTINGS" \
      --permission-mode acceptEdits --permission-prompts none \
      --strict-mcp-config --no-session-persistence \
      --model "${NIGHT_MODEL:-claude-opus-5-5}" --effort medium \
      --max-budget-usd "${NIGHT_TASK_USD:-5}" "$@"
}

# タスクの結果の形。BLOCKED の判定を文字列の先頭一致に頼らない。
NIGHT_SCHEMA='{"type":"object","properties":{"status":{"type":"string","enum":["done","blocked"]},"summary":{"type":"string"},"reason":{"type":"string"}},"required":["status","summary"],"additionalProperties":false}'
