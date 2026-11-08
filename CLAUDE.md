# nda — Claude Code 用プロジェクト規則

## これは何か
Built with Claude: Japan 2026 の提出作品「んだ (nDa)」。父（整備士）が客に説明する声からカルテを作り、息子が父の承認済みの言葉と原音でしか答えを得られない仕組み。README が製品の正。

## 守ること
- **捏造を構造で止める**: 台帳に無い値は `found:false`、父が承認していないカルテは回答に使わない。推測で埋めない。
- **推測で見つける規則を足し続けない**: 抜け道の指摘が続いたら（明細の検証・客の名前の伏せ字で 2 回）、規則を足さずに穴の出ない粗い単位（候補 ID を指させる、ナンバーの文と前後の文は丸ごと出さない）に切り替え、残る限界は文書に書く。
- **発火率を上げるための質問を作らない**。分岐の一問は、判断が記録され・再利用に必要な条件が欠け・既存で埋まらず・父が短く答えられる、の 4 条件を満たすときだけ。
- **出力を見る前に期待を固定する**: 評価は `docs/preregistration.md` を先にコミットしてから回す。
- **匿名化**: 実名・連絡先・車台番号・ナンバーをコミットしない。仮名は `docs/anonymization.md`。実名との対応表はリポジトリ外。
- **録音ファイルはコミットしない**（`data/recordings/` は .gitignore）。公開するのは同意済みの別コピーだけ。
- **期間前の素材**は README「出所」に明記する。仮素材（本人の再話）は証明に使わず、提出前に削除する。
- `progress.md` に日付つきで、やったこと・捨てたこと・数字を 1 行ずつ残す。

## ToDo
- ToDo の正は GitHub Issues（ラベル: `担当:鹿内`／`担当:Claude`、`優先:高/中/低`、`待ち`、`夜間`）。鹿内さんの依頼と、Claude が挙げたやるべきことは、その場で Issue にする。
- 作業を終えたら Issue を閉じるか、進み具合をコメントする。`tasks/backlog.md` は夜間ループ専用で、`夜間` ラベルの Issue から作る。
- リポジトリは公開。Issue に客の情報・店の内部の情報・実名を書かない。

## 敵対レビュー（Codex）と切り札（Fable）
全体の基準（`~/.claude/CLAUDE.md`）を nDa に当てはめたもの。どちらも、メインが「今が該当する」と判断したら鹿内さんに一言伝えてから回す。

**Codex の敵対レビュー**（別の会社のモデルの目で、穴を探させる）
- いつ回すか:
  1. 捏造を止める仕組みを変えたとき（`lib/karte/verify.ts`、`lib/invoice/verify.ts`・`price.ts` の「推測で埋めない」、`lib/eval/prereg.ts`）。マージの前に。
  2. 事務所の PC で RacroS III を操作するプログラム（#26）を、初めて実機で動かす前。確定・発行を押さないこと、許可リスト、読み返しの照合を見る。
  3. 夜間ループの安全装置（`.claude/night-settings.json`、`scripts/night*.sh`、sandbox）を変えたとき。
  4. 客の情報を扱うコード（匿名化・取り出し #18、記録スクリプト `office/recorder/`）を変えたとき。
  5. 提出の前（11/8 午前）に、リポジトリ全体を 1 回。秘密・実名の混入と、README の主張がコードと合っているか。
- 回さないもの: 文書だけの変更、画面の文言、小さな修正。
- 回し方: 秘密と実データを渡さないよう、`.env` と `data/` の無いきれいな worktree（`git worktree add`）で `codex exec --sandbox read-only` を使う。対象の差分・観点・「確定した欠陥だけを根拠つきで返す」を指示する。指摘はメインが確かめてから直す。

**Fable 5.1（切り札。Opus の約 2.5 倍の費用）**
- いつ使うか:
  1. Opus（effort を上げた後）で同じ問題に 2 回詰まった。
  2. 取り消しにくい設計判断: RacroS III の操作方式（#17 の dump の結果が出た後）、事前登録の期待値（#30）、Pi と事務所の PC の約束事（#25）。
  3. 審査員と客が見る成果物の仕上げ: デモ動画の台本、README の最終版（#29）。
- 使わないもの: 仕様が決まった実装、調査、記録の更新。
- 使う前に、まず Opus の effort を上げる。

## 記録の置き場
作業を始める前に、関係する所を読む。サブエージェントの調査結果は、メインが確かめてから書く。
- 決めたことと未決の議題: `docs/decisions.md`（主軸は 2026-11-04 に変更。README・バックログより新しい）
- 調べて分かった事実: `docs/research.md`（出典と確度つき）
- 請求書を作るときに参考にする情報（料金表・過去の伝票の傾向・業務ソフトの書き方）: `docs/invoice-references.md`
- 試したこと（ベンダー・モデル・設定と結果）: `docs/experiments.md`。試したらその場で 1 行足す。実録音の全文や客の情報は書かない
- 間違いと対策: `tasks/lessons.md`
- 工場の Pi: `docs/pi-setup.md`

## 技術
- 構成は `docs/architecture.md`。工場は Pi 5 だけで、nDa の本体（Next.js）も Pi で動かす。審査員向けは同じコードを hosted。DB は libSQL（ローカルはファイル）。
- 事務所の PC（Windows）は、Pi が受け箱のフォルダに置いた承認済みの明細を拾い、業務ソフトに保存の手前まで入れる。Pi と事務所の間は Claude（モデル）を通さない。
- Claude: Messages API ＋ structured outputs（`output_config.format` に zod）。製品で呼ぶのは明細の対応づけ（`lib/invoice/extract.ts`、`claude-opus-5-5`）の 1 か所だけ。答えの読み取り・照合・運びには使わない。`claude-haiku-5-5` は夜間の点検の疎通にだけ使う。vision は旧主軸の `lib/karte/separate.ts` にだけ残る。Tool Runner は使っていない。
- STT は外部ベンダ（Scribe v2／AmiVoice／Gemini 3.5 Transcribe を実録音で比較して 1 社に決める。基準線は kotoba-whisper）。ストリーミングは使わない。ファイル取込が正。
- 不採用: computer use（例外条件を満たした場合のみ 4h 上限）、Managed Agents、異音分類、話者分離の自作。

## 出力
- 最終回答は日本語。コミットメッセージは日本語の conventional commit。

## 夜間ループ
- 起動: `nohup pnpm night >/dev/null 2>&1 &`（Mac は AC 電源、蓋は開けたまま）。`main` から `night/<日付>` を作り、`../nda-night` の worktree だけで動く。push しない。
- 朝: `/night-review` で検収する（`night-reviewer` が差分を独立にレビューする）。画面を確認してから `main` へマージして push する。失敗分は `night-failed/*` に残る。
- 起動前に `scripts/night-probe.sh` が禁止操作と sandbox からの脱出を実際に試し、不合格なら始めない。
- 間違いと対策は `tasks/lessons.md` に 1 行ずつ残す。2 回出たらこのファイルへ昇格する。
- 回すのは `tasks/backlog.md` のタスクだけ。架空の素材で検証でき、仕様が確定したものに限る。評価の実行、事前登録の記入、父の言葉の解釈、録音の処理は回さない。
- 完了はエージェントの申告でなく `pnpm check` で決める。
