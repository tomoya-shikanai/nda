# 夜間タスクの共通指示

無人で 1 タスクだけ実装する。質問しても誰も答えない。

- 対象は下の「タスク」だけ。ついでの改善をしない。
- まず `CLAUDE.md`、`README.md`、関係するコードを読む。
- 素材は架空のものだけを使う。実名・連絡先・実案件を書かない。録音・文字起こし・カルテの実データに触らない。
- 捏造を止める構造を弱めない。`lib/karte/verify.ts`、`citationFailures`、`karteView`、台帳の `found:false`、既存テストを緩めない。
- 依存の追加、仕様変更、外部ネットワークへのアクセスをしない。Claude は `ANTHROPIC_BASE_URL` の偽サーバーで検証する。
- コミットしない。`tasks/backlog.md` を編集しない。どちらも実行スクリプトが行う。
- 終える前に `pnpm check` を実行し、通るまで直す。
- Bash で使えるのは `pnpm test`・`pnpm lint`・`pnpm typecheck`・`pnpm build`・`pnpm check`・`node --import tsx --test tests/<ファイル>`・`git status`・`ls` だけ。1 回に 1 命令で実行する（`;`・`&&`・`|` でつなぐと拒否される）。ファイルを読むときは Read・Glob・Grep を使う。
- `progress.md` の末尾に、日付つきで、やったこと・捨てたこと・数字を 1 行追記する。見た目を確認できていない画面は「見た目は未確認」と書く。

仕様の判断が要る場合、依存の追加が要る場合、受け入れ条件を満たせない場合は、実装を中断する。`status` を `blocked` にし、`reason` に理由を書いて終了する。条件を緩めて完了にしない。

完了したら `status` を `done` にし、`summary` に変更の要約を 1 行で書く。
