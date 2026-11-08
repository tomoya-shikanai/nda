# 出来事の記録（自己改善の材料）

工場の Pi で動かしたときの動きを、後で直すための材料として、構造化した出来事（JSONL）を残す。自動で直す仕組みは作らない。記録と、それを集計するスクリプト（`pnpm log:summary`）まで。

## 置き場

- `NDA_LOG_DIR` に置く。無ければ記録しない（Mac の開発の既定）。
- 工場の Pi では `/var/lib/nda/logs`。本体（`nda-app`）と聞き役の両方が書けること（配置は `deploy/pi/` の担当が決める）。
- 本体: `events-YYYY-MM-DD.jsonl`。聞き役（`device/listener/listen.py`）: `listener-YYYY-MM-DD.jsonl`。日付は機械の時刻。1 行が 1 つの出来事で、`t`（ISO の時刻）と `kind` と欄。
- 書き込みに失敗しても本体・聞き役は止まらない（記録が欠けるだけ）。ファイルは 600 で作る。

## 守り

- 記録するのは、数・時間・種類名（閉じた enum）・id（作業 id・メッセージ id）だけ。
- 記録しない: 文字起こしの文、聞き取った言葉（答えの `quote`）、客の名前、ナンバー、事務所が返す `label`・客の番号、照合の `said`、品目名、例外の文（種類名だけ）、録音。
- 出来事ごとに形を zod（`lib/log/events.ts`）と Python の表（`listener_core.py` の `LISTENER_EVENTS`）で決め、余計な欄・形の違う値（自由な文字列・形の違う id）があれば、その行を捨てて `log.invalid`（種類だけ）を残す。
- 試験（`tests/log-events.test.ts`、`device/listener/tests/test_log.py`）で、架空の客の名前・4 桁・label・said・答えの言葉が記録に入らないことを確かめる。

## 出来事

| kind | いつ | 主な欄 |
|---|---|---|
| `session.created` | 作業を作った | `sessionId`・`customerRequired` |
| `session.transition` | 状態が進んだ（作業ファイルの history） | `from`・`to` |
| `session.answer` | 答えの 1 発話を当てた | `questionReason`（答えた質問の理由の種類）・`action`（操作の種類）・`unreadReason`（読めなかった理由の固定の文。抽出の失敗は「抽出に失敗」、それ以外は other） |
| `session.approved` | 承認した | `msFromCreated`・`answers` |
| `session.query` | 照合の問い合わせが決着した | `status`（answered・expired・unreachable）・`retryReason` |
| `session.office` | 承認の後の入力の結果 | `outcome`・`reason`・`enteredLines`・`attempt`・`msFromApproved` |
| `stt` | 文字起こし | `vendor`・`purpose`（start・answer）・`audioSec`・`ms`・`ok`・`error`（noKey か例外の種類名） |
| `extract` | 抽出 | `phase`（start・continue）・`model`・トークン数・`ms`・`ok`・`error`・`lines`・`confirmations`・`questions`・`questionReasons`（質問の主な理由ごとの数） |
| `office.put` | 受け箱に置いた | `message`（customer.query・invoice.request）・`messageId`・`attempt`・`ms`・`ok`・`error`（boxMissing・writeFailed・timeout） |
| `office.reply` | 事務所の返しを受けた | `message`・`messageId`・`result`（accepted・duplicate・stale・unsupported・noSession）・`answer`（found・retry）・`retryReason`・`outcome`・`msSinceSent` |
| `route.reject` | 声・答えの入口が断った | `route`・`reason`（notFound・notAsking・stale・unheard・extractFailed） |
| `tts` | 声（VOICEVOX） | `ms`・`ok`・`error` |
| `wake`（聞き役） | 起動語の語が並んで出た（通らなかったものも） | `conf`（両語の最小）・`accepted`・`minConf` |
| `record`（聞き役） | 録音を止めた | `sec`・`spoke` |
| `send`（聞き役） | サーバーへ送った | `ms`・`status`（HTTP。届かなければ null）・`result`（ok・conflict・rejected・unreachable） |

作業の出来事（`session.*`）は、`writeSession` が書く前の作業ファイルとの差から作る（`lib/log/session.ts`）。声・画面・事務所の返し・見回りのどの経路でも同じ所を通る。記録が無効なら前のファイルを読まない。

## 集計

```sh
NDA_LOG_DIR=/var/lib/nda/logs pnpm log:summary 2026-11-08   # 日付を省くと今日。--dir で置き場を渡してもよい
```

作業の数、承認までの時間の中央値、聞き返しの数と理由の内訳、unread の率と理由、文字起こし・抽出・事務所の往復の ms の中央値と最大、失敗の種類の数、起動語の conf の分布、409 の数を出し、最後に「気になる点」を数行出す（unread の率が 3 割以上ならいちばん多い理由、半分以上が unread の質問の理由、期限切れ、stale、409、0.7〜0.9 で落ちた起動語、声の無い録音など。閾値は目安）。
