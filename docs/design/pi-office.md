# 工場の Pi と事務所の PC のあいだの約束事（#25）

状態: 案（Fable、2026-11-05）。鹿内さんの判断待ち。決まったら `docs/decisions.md` に 1 行足す。

要約:
- 工場→事務所は決定どおり受け箱（1 件 1 ファイル）。運び方は Tailscale 上の sftp（#39 で事務所の sshd は済み）。
- 事務所→工場の返し（照合の答え・入力の結果）は、返し箱を作らず、事務所のプログラムが工場の Pi の API に HTTP で押し込む（#42 の合言葉、Tailscale の中だけ）。
- メッセージは 4 種（照合の問い合わせ・照合の答え・承認済みの請求・入力の結果）。封筒は版・一意の ID・作業の ID・送信時刻。二重入力は事務所が作業の ID で止める。
- 客の名前は照合の問い合わせにだけ入り、工場は保存せず、事務所は答えた直後にファイルを消し、ログに残さない。
- 作業の状態は `done` の後ろに `sending → sent → entered | stopped` を足す。照合待ちは `asking` の中の小さな状態（`customerQuery`）で、上の状態は増やさない。

---

## 1. 前提（覆さない）

- 工場から事務所へ Claude（モデル）を通さない。工場が事務所の受け箱に 1 件 1 ファイルで置き、事務所のプログラムが拾う。一時の名前で書いて名前を変える。
- 整備中に事務所で保存を押す人はいない。承認（「請求書頼む」）の後に事務所のプログラムが業務ソフトへ保存の手前まで入れる。保存・確定・発行・印刷は押さない。
- 客の照合は事務所で行う。名前とナンバー下 4 桁の両方が合う 1 組だけのとき客と車の番号を返す。0 組・2 組以上は「聞き直し」で名前を返さない。客の一覧は工場にも Claude にも出さない。
- 照合の結果は工場に返る（聞き直しの流れのため）。
- 業務ソフトの画面を何時間も開いたままにしない。
- 実名・ナンバー・店の内部情報をリポジトリに書かない。

## 2. 往復の形（推奨: 受け箱は sftp、返しは工場の API への HTTP）

| 向き | 運び方 | 置き場・宛先 | 守り |
|---|---|---|---|
| 工場→事務所 | sftp（Tailscale の `nda-office`）。1 件 1 ファイル。`.tmp` に書いて rename | `C:\nda\box\in\` | 鍵認証だけ。sshd は Tailscale の範囲だけ受ける（#39 で済み） |
| 事務所→工場 | HTTP `POST http://nda-pi:3001/api/office/reply`（Pi の関所。本体の 3000 は LAN に出さない。2026-11-08、`deploy/pi/README.md`。#41 の事務所のプログラムの返し先はこの 3001）。1 件 1 リクエスト | 工場の Next.js の既存の受け口に route を 1 つ足す | `Authorization: Bearer <合言葉>`（#42）。合図が違えば 401。`/api/office/*` だけ合言葉必須 |

選んだ理由:
- 待ち時間: 問い合わせは sftp の書き込み（接続を使い回せば 0.1 秒）＋事務所の受け箱の見回り（0.5 秒）＋DB の照合（0.5 秒）＋HTTP（0.1 秒）で、父の待ちは 2 秒前後。工場側に見回りの常駐が要らないので、答えは着いた瞬間に作業に入る。
- 設定の量: 事務所の sshd・Tailscale・鍵は #39 で済んでいる。鹿内さんがやるのは「フォルダを 1 つ作る」「合言葉を 2 か所に書く」だけ（§8）。11/7 の撮影は Mac が工場役なので、Mac の鍵がそのまま使える。
- 安全: 客の DB を持つ事務所の PC に、新しい受け口（ポート）を 1 つも開けない。Pi 側は既に動いている Next.js に route を足すだけで、合言葉と Tailscale の二重。

捨てた案:
| 案 | 捨てた理由 |
|---|---|
| 受け箱＋返し箱（ファイルの往復） | 工場にも見回りの常駐が要り、待ちが 2 倍。Pi が落ちて戻ったときの返し箱の掃除も要る。返しは HTTP の方が短い |
| 事務所に小さな HTTP サーバー | 客の DB を持つ PC に受け口を開け、認証を自作する。受け箱の決定と二重になる |
| SSH の exec で同期の照合（`ssh nda-office match`） | Windows の sshd は 1 回ごとのプロセス起動が遅い（1 秒超）。受け箱と exec の 2 つの仕組みになる |
| SMB の共有フォルダ | sshd が既にあるので、共有・ユーザー・445 の穴あけの分だけ設定が増える。sftp が不安定なときの控え |
| 事務所が工場の API を取りに行く（受け箱なし） | 決定（受け箱）を覆す。事務所に残るファイルは人が見られる記録として価値がある |

## 3. メッセージの種類と型（zod が正）

置き場: `lib/office/schema.ts`。事務所の Python は `z.toJSONSchema` で出した `office/box/schema/*.json` で検証する（手で二重に書かない）。
各ファイル・各リクエストは下の 1 つの JSON。

```ts
import { z } from "zod";

const SessionId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
/** どの声のどの発話か。quote は承認済みの請求の行だけに入れる（伏せ字にした後の文）。 */
const Where = z.object({ recordingId: z.string(), startSec: z.number(), endSec: z.number() });
const Quoted = Where.extend({ quote: z.string() });

const Envelope = z.object({
  v: z.literal(1),
  id: z.string().uuid(),          // メッセージの一意 ID。二重に届いたときの判定に使う
  sessionId: SessionId,           // 工場の作業 ID。入力の二重を止める鍵
  sentAt: z.string().datetime(),  // 送った側の時計。順序や期限の判定には使わない（時計のずれ）
});

/** 工場→事務所: 客の照合の問い合わせ。 */
export const CustomerQuery = Envelope.extend({
  kind: z.literal("customer.query"),
  /** 4 桁の数を含む文だけ（伏せ字にする前の原文）。工場は保存せず、事務所は答えた直後にファイルを消す。 */
  said: z.array(z.string().min(1)).min(1),
  /** 文に出た 4 桁の数（円が続かないもの）。普通は 1 つ。 */
  plate4: z.array(z.string().regex(/^[0-9]{4}$/)).min(1),
  from: Where,
  /** 事務所が受け取ってからこの秒数を過ぎた問い合わせは答えない（父は次に進んでいる）。 */
  ttlSec: z.number().int().positive(),
});

/** 事務所→工場: 照合の答え。名前は返さない。label は鹿内さんの判断待ち（§9）。 */
export const CustomerAnswer = Envelope.extend({
  kind: z.literal("customer.answer"),
  queryId: z.string().uuid(),
  result: z.discriminatedUnion("status", [
    z.object({ status: z.literal("found"), customerNo: z.string().min(1), carNo: z.string().min(1), label: z.string().nullable() }),
    z.object({ status: z.literal("retry"), reason: z.enum(["none", "many", "expired", "dbUnavailable"]) }),
  ]),
});

/** 工場→事務所: 承認済みの請求（入力の依頼）。確認事項 0 件・客が決まった作業だけ。値はすべて埋まっている。 */
export const InvoiceRequest = Envelope.extend({
  kind: z.literal("invoice.request"),
  /** 同じ作業の何回目の依頼か。前回が stopped のときだけ 2 以上を送れる。 */
  attempt: z.number().int().positive(),
  customer: z.object({ customerNo: z.string().min(1), carNo: z.string().min(1) }),
  approvedAt: z.string().datetime(),
  approval: Quoted,               // 「請求書頼む」と言った発話
  lines: z.array(
    z.object({
      item: z.string().min(1),    // 料金表の正式名
      qty: z.number().positive(),
      unit: z.string().min(1),
      unitPrice: z.number().int().nonnegative(),
      amount: z.number().int().nonnegative(),
      unitPriceFrom: z.enum(["ledger", "spoken", "answer"]),
      provenance: Quoted,         // 品目を言った発話
    }),
  ).min(1),
  total: z.number().int().nonnegative(),
  /** 父が言った合計。言っていなければ null。 */
  totalSpoken: z.number().int().nullable(),
});

/** 事務所→工場: 入力の結果。11/7 は entered と stopped だけ使う。 */
export const InvoiceResult = Envelope.extend({
  kind: z.literal("invoice.result"),
  requestId: z.string().uuid(),
  outcome: z.enum([
    "entered",    // 保存の手前まで入った。画面は開いたまま人を待つ
    "stopped",    // 入れなかった、または途中で止めた。画面は閉じてある
    "deferred",   // 人が来てから入れる（後に回す）
    "withdrawn",  // 開けたまま長くなったので保存せず閉じた（後に回す）
    "saved",      // 人が保存を押し、DB で照らした（後に回す）
  ]),
  enteredLines: z.number().int().nonnegative(),
  reason: z
    .enum(["busy", "appNotRunning", "unknownItem", "customerNotAllowed", "customerNotFound", "duplicate", "invalid", "readbackMismatch", "other"])
    .nullable(),
  /** 画面から読み返した値。読めなければ null（推測で埋めない）。 */
  readback: z.array(z.object({ item: z.string(), qty: z.number().nullable(), unitPrice: z.number().nullable() })).nullable(),
  /** 事務所の PC に残した画面の写真のファイル名。写真そのものは送らない。 */
  screenshotFile: z.string().nullable(),
});

export const ToOffice = z.discriminatedUnion("kind", [CustomerQuery, InvoiceRequest]);
export const ToFactory = z.discriminatedUnion("kind", [CustomerAnswer, InvoiceResult]);
```

ファイル名と置き場（事務所）:
| 場所 | 中身 |
|---|---|
| `box\in\<kind>-<sessionId>-<id>.json` | 工場が置く。書くときは `.<同名>.tmp` に書いて rename。事務所は `*.json` だけ拾う |
| `box\work\` | 拾って処理中。事務所の再起動のとき、ここにあるものは `stopped: other` にして工場に返す（途中の入力を続けない） |
| `box\done\<id>.json` | 処理の記録と、返した答え（再送に使う）。`customer.query` の記録には `said` を入れない |
| `box\done\<sessionId>.state.json` | 作業ごとの入力の状態（`received → entering → entered | stopped`）。二重入力の鍵 |
| `box\config.json` | `pi_url`・`secret`（合言葉）・`allowed_customers`（第 1 段階の練習用の客の番号）・`item_codes`（正式名 → 項目CD）。Git に入れない |

受け箱に置ける種類は上の 2 つだけ。受付（#49、車検証の先送り）は `reception.*` を予約し、今は設計しない。

### 出所の扱い
- `provenance`・`approval` の `quote` は伏せ字にした後の文（名前と 4 桁は `＊＊`）。事務所の記録には入ってよい。
- `customer.query` の `said` だけが原文。工場は作業ファイル（`data/sessions`）にもログにも書かず、sftp に書くためのメモリの上だけに置く。事務所は答えを送った直後に `in` のファイルを消し、ログには `queryId`・`sessionId`・結果・候補の件数だけを書く。
- 4 桁の数を含む文だけを送るので、作業の話（明細の説明）は事務所に行かない。

### 二重の防止
| 場面 | 判定の鍵 | 事務所の動き |
|---|---|---|
| 同じファイル（同じ `id`）が 2 回届いた | `box\done\<id>.json` がある | 何もせず、記録した答えをもう一度 POST する |
| 同じ作業（同じ `sessionId`）の依頼が別の `id` で届いた | `<sessionId>.state.json` | 前回が `stopped` なら `attempt` が前回＋1 のときだけ入れる。それ以外は `stopped: duplicate`（画面に触らない） |
| 答え（同じ `id`）が工場に 2 回届いた | 作業の `customerQuery.id`・`office.requestId` と、適用済みの `id` | 2 回目は 200 を返して何もしない |
| 今待っていない答えが届いた（期限切れの問い合わせの答え、別の `requestId`） | 同上 | 200 と `{accepted:false, why:"stale"}`。捨てる。事務所は再送しない |

HTTP の返事の約束（事務所の再送の判断）: 2xx は再送しない。401 は合言葉の間違いなので再送せず、事務所の画面とログに出す。404（作業が無い）は再送しない。5xx と接続の失敗は再送する（1・2・4…秒、答えは 60 秒まで、結果は 24 時間まで。結果は `done` に残り、事務所の再起動後も再送する）。

### 事務所が入れる前に必ず照らすこと（工場のファイルを信じない）
`v` が 1、スキーマに合う、全行に数量・単位・単価・金額がある、`amount = qty × unitPrice`、`total = Σ amount`、`item` が `item_codes` にある、`customerNo` が `allowed_customers` にある（第 1 段階）、業務ソフトが起動していて人が使っていない、この `sessionId` を入れた記録が無い。
どれか 1 つでも外れたら、画面に触らずに `stopped` と理由を返す（推測で埋めない。#26 の方針と同じ）。
入力が途中で止まったときも、画面を閉じてから `stopped` を返す（排他 8001・入れかけの消失を避ける）。

## 4. 失敗のときの見せ方（工場の画面と声）

| 失敗 | 工場で分かる方法 | 画面（札） | 声 | その後 |
|---|---|---|---|---|
| 事務所の PC が落ちている・sftp がつながらない（問い合わせ） | 書き込みが 5 秒以内に失敗 | 「事務所につながりません」 | 「事務所につながりません。お客様はあとでもう一度聞きます」 | 客の質問は残る。ほかの質問は続けられる。父がもう一度名前と 4 桁を言えば送り直す |
| 同上（承認後の依頼） | 同上 | 「事務所に送れていません。つながったら送ります」 | 「承認しました。事務所につながったら送ります」 | 状態 `sending` のまま。モニターの見回り（2 秒ごとの GET）のたびに 30 秒に 1 回まで送り直す（1 時間まで）。11/7 はこれで足りる |
| 照合が返らない | 送って 10 秒たっても `customerQuery` が pending | 「お客様を確かめています…」→「事務所から返事がありません」 | 「事務所から返事がありません。名前とナンバーの下4桁をもう一度お願いします」 | 問い合わせを `expired` にし、遅れて来た答えは捨てる。父が言い直せば新しい問い合わせ |
| 照合が 0 組・2 組以上（`retry`） | 答えの `retry` | 「お客様が決まりませんでした」 | 「お客様が決まりませんでした。名前とナンバーの下4桁をもう一度お願いします」 | 候補の名前は出さない（事務所も返さない） |
| 業務ソフトを人が使っている・排他（`stopped: busy`） | 結果 | 「事務所のソフトが使用中です。人が入れてください」 | 「事務所のソフトが使用中でした。人が入れてください」 | 11/7 は人が事務所で `nda-office retry <sessionId>` を打つ。声での送り直しは後 |
| 業務ソフトが起動していない（`appNotRunning`） | 結果 | 「事務所のソフトが開いていません」 | 同左 | 同上 |
| 品目が項目CDの表に無い・客が許可外（`unknownItem`・`customerNotAllowed`） | 結果 | 「事務所で止まりました: 品目が見つかりません」 | 「事務所で止まりました。人が入れてください」 | 設定（`item_codes`・`allowed_customers`）を直す |
| 入力が途中で止まった（`other`・`readbackMismatch`） | 結果 | 「事務所で止まりました。画面は閉じました」 | 同上 | 事務所の `done` に写真と理由が残る |
| 同じ依頼が 2 回届いた（`duplicate`） | 結果 | 出さない（1 回目の結果を保つ） | 出さない | 事務所の記録だけ |
| 合言葉の間違い（401） | 工場では分からない | — | — | 事務所の画面とログに出す。鹿内さんが `config.json` か `nda.env` を直す |

声で言うのは状態が変わった 1 回だけ（`sayId` の仕組みのまま）。工場の画面に、客の DB の値（名前・候補）は一切出さない。

## 5. 作業の状態（`lib/session/store.ts`）

今の遷移: `idle → listening → thinking → drafting → asking → done`（`done` は承認）。
足すのは `done` の後ろだけ。照合待ちは `asking` の中の小さな状態にし、上の表は増やさない（客の質問は最後なので、照合待ちの間も承認待ちの画面のまま「確かめています」と出せる）。

| 状態 | 意味 | 次に行ける状態 | 札・声 |
|---|---|---|---|
| `done` | 承認した瞬間（一瞬） | `sending` | 「承認しました。事務所に送ります」 |
| `sending` | 依頼のファイルを書いている・書けずに送り直し中 | `sent` | 「事務所に送っています」（失敗中は §4 の札） |
| `sent` | 受け箱に置けた。結果待ち | `entered`・`stopped` | 「事務所に届きました。入れています」 |
| `entered` | 保存の手前まで入った（終わり） | — | 「n 行入れました。保存は人が押してください」 |
| `stopped` | 事務所で止まった（終わり） | —（送り直しは後） | 「事務所で止まりました。人が入れてください」 |

- `assertDone`（承認済み・確認事項 0・客が決まっている）は `done` 以降の全部の状態に当てる。
- `routeVoice` は変えない（`asking` 以外の声は新しい作業）。`latestSession` も変えない。
- 今の `SAY.done`（「n 行入れました」）は `entered` に移す。`done` で「入れました」と言わない。

作業に足す欄:
```ts
/** 事務所の照合が設定されているか（NDA_OFFICE_HOST があるか）。true なら客が決まるまで承認できない（今の customerRequired と同じ意味）。 */
customerRequired: boolean;
/** 決まった客。番号だけ。label は事務所が返したときだけ（画面用。Claude に渡さない）。customerId は廃止 */
customer: { customerNo: string; carNo: string; label: string | null } | null;
/** 今の問い合わせ。said は入れない。 */
customerQuery: { id: string; sentAt: string; status: "pending" | "answered" | "expired" | "unreachable"; retryReason: string | null } | null;
/** 承認後の依頼と結果。 */
office: { requestId: string; attempt: number; sentAt: string | null; lastError: string | null; lastTriedAt: string | null;
          result: { id: string; outcome: string; reason: string | null; enteredLines: number; at: string } | null } | null;
/** 適用した事務所のメッセージの id（二重に届いたときの判定）。 */
appliedIds: string[];
```

照合の流れ（`asking` の中）:
1. 文字起こし（最初の録音と返事）に 4 桁の数（円が続かない）を含む文があれば、伏せ字にする前のその文だけで `customer.query` を作り、受け箱に置く。伏せ字（敬称の前の名前・4 桁）は今の `identifyCustomer` を一覧なし（`customers = []`）で使う。工場の一覧（`NDA_CUSTOMERS_PATH`・`lib/customer/load.ts`）は廃止する。
2. 置けたら `customerQuery.pending`。札は「お客様を確かめています」。客の質問が今の質問なら声は「お客様を事務所で確かめています」。
3. 答えが `found` なら `customer` を入れ、質問を組み直す（客の質問が消える）。確認事項が 0 件なら承認待ちの声。`retry` なら §4。
4. pending のまま 10 秒たったら `expired`（判定は `/api/session/current` の GET のときに行う。常駐を作らない）。

承認の流れ: `answerSession` が `asking → done` にした直後、同じ route で `invoice.request` を組んで受け箱に置く（`done → sending → sent`）。行に null が 1 つでもあれば置かずに `stopped: invalid`（起きないはずだが、推測で埋めない）。

## 6. 置き場

| 側 | 置き場 | 中身 |
|---|---|---|
| 工場 | `lib/office/schema.ts` | 上の zod。`scripts/office-schema.ts` が `office/box/schema/*.json` を出す |
| 工場 | `lib/office/send.ts` | sftp で受け箱に置く（`.tmp` → rename）。接続は使い回す（`ssh -o ControlMaster=auto -o ControlPersist=10m` か ssh2 の 1 本）。設定は `NDA_OFFICE_HOST`・`NDA_OFFICE_BOX`・`NDA_OFFICE_KEY` |
| 工場 | `app/api/office/reply/route.ts` | 事務所からの POST。合言葉 `NDA_OFFICE_SECRET` を確かめ、`ToFactory` で検証し、作業に当てる |
| 工場 | `lib/office/fake.ts` | 偽の事務所（ローカルのフォルダを受け箱にし、決まった答えを POST する）。往復の試験と撮影の予備 |
| 事務所 | `office/box/`（Python） | 受け箱の見回り、照合（`office-pc/match-20261105` の部品）、入力（`office-pc/input-20261105`）、POST。`recorder` と同じ入れ方 |

秘密の置き場: 工場は `/etc/nda/nda.env`（Pi）か `.env`（Mac）。事務所は `box\config.json`。どちらも鹿内さんが書き、Git に入れない。

工場の本体（Next.js）は 1 プロセスで動かす。作業ファイルを読んで書く経路の排他は、そのプロセスの中だけ（`lib/session/lock.ts`、#47）。

## 7. 11/7 の撮影までに作る最小と、後に回すもの

作る（順に）:
1. `lib/office/schema.ts` と JSON Schema の書き出し。試験はスキーマの往復だけ。
2. `app/api/office/reply/route.ts`（合言葉、二重の判定、作業への適用）と `store.ts` の状態・欄。試験は偽の答えを POST する。
3. `lib/office/send.ts`（sftp、`.tmp` → rename）と、照合の問い合わせ・承認後の依頼の配線。`lib/office/fake.ts` で Mac の中だけで一周。
4. 事務所の `office/box/` の見回り・照合・POST（入力は `office-pc/input-20261105` につなぐ）。練習用の客で実機。
5. 画面と声の札（§4・§5）。

後に回す:
- `deferred`・`withdrawn`（開けたままの上限で閉じ、人が来たら「入れて」で入れ直す）・`saved`（保存後の DB の照合）と、画面の写真の受け渡し。
- 声での送り直し（「もう一回送って」）。11/7 は事務所の PC で人が打つ。
- Pi 用の Windows ユーザーを分け、sftp だけ・`box` だけに閉じる（`Match User` ＋ `ChrootDirectory` ＋ `ForceCommand internal-sftp`）。11/7 は Mac の鍵（#39 の管理者のユーザー）をそのまま使う。
- 工場の API で、送り元が Tailscale の範囲（100.64.0.0/10）かも見る（合言葉に加えて）。
- 敬称の無い姓の伏せ字（一覧を工場から外すと「田中 1234」の「田中」は伏せられない。音声は元から STT ベンダーに行くので、守りが下がるのは Claude の入力と作業ファイルの分。事務所が照合で合った語の折り畳み形を返して伏せる案は、名前を工場に返すことになるので保留）。
- 受付（#49）の `reception.*`。
- `sending` の送り直しを GET の便乗でなく常駐にする。

## 8. 鹿内さんがやる設定

1. 事務所の PC に `C:\nda\box\in`・`work`・`done` を作る（Claude が SSH で作ってもよい）。
2. 合言葉を 1 つ決め、工場の `nda.env`（`NDA_OFFICE_SECRET`）と事務所の `box\config.json`（`secret`）に書く。
3. `box\config.json` に練習用の客の番号（`allowed_customers`）を書く（番号はリポジトリに書かない）。
4. 事務所の PC で `office/box` を常駐させる（`recorder` と同じくタスクスケジューラ）。

## 9. 鹿内さんの答え（2026-11-05）

1. 照合が決まったら、工場のモニターに姓と車種を出す（推奨の「出さない」を覆す。父が正しい車かを目で確かめるため）。事務所は customer.answer に label（姓・車種）を入れる。工場は画面に出すだけで、作業ファイルとログには番号だけを残す。
   - label の形は「姓＋様・車種」（例「仮田様・軽トラ」。姓と「様」の間に空白を入れない）。工場は「お客様: 」の後ろにそのまま出す。
2. 承認の後すぐ入れたい。業務ソフトに下書き保存（確定・発行とは別の保存）があるかを事務所の PC で確かめる（#41）。あれば下書き保存までを入力の範囲にし、画面を開けたままにしない。無ければ「すぐ入れて上限 20 分で保存せず閉じる」の案に戻る。下書き保存も DB への書き込みなので、#26 の段階（練習用の客から）に従う。
3. 返しは工場の API（`POST /api/office/reply`、合言葉、Tailscale の中）で良い。もっと速くするため、次の 2 つを入れる。
   - 照合の問い合わせは、STT の後、Claude の抽出を待たずにすぐ送る（名前と 4 桁はコードが拾う）。照合は抽出（2〜3 秒）と並んで走るので、父の待ちはほぼ増えない。
   - 事務所の受け箱は見回りでなく、フォルダの変化の通知（Windows の FileSystemWatcher）で拾う。見回りの 0.5 秒が消える。

4. 運び道は同じ LAN の共有フォルダ（SMB）にする（#53、速い方）。§2 の sftp を置き換える。工場は共有を mount してローカルのフォルダとして書く（`.tmp` → rename は同じ）。返しの HTTP も LAN の中で送る。同じ LAN でない場合は §2 の Tailscale＋sftp に戻す。

5. 11/8: 事務所の実装に合わせ estimate.instruction を主にした（#56・#26・#55）。事務所は客と車を DB から自分で決め、作業の文から明細を決めて保存の手前で止まり、返しは送らない。工場は照合を問い合わせず（customer.query／customer.answer は使わない）、客の返事に 4 桁がちょうど 1 つあれば、その場で「受けました（事務所で確かめます）」として客の確認事項を消す。手がかり（`plateNo`＝下 4 桁、`customerWords`＝返事の原文から 4 桁を除いた言葉）はメモリ（`lib/office/clues.ts`）にだけ持ち、作業ファイル・出来事の記録には書かず、受け箱に置けたら消す。承認したら invoice.request の代わりに `estimate.instruction`（番号を持たない。`work` は承認済みの明細の「品目 数量 単価円」を「、」でつないだ 1 行）を 1 件置き、状態は sending → sent で止まる（声「事務所に送りました。保存は人が押してください」）。再起動で手がかりが消えていたら送らない: 承認の前なら客の質問に戻し、送り直しの途中なら stopped（理由 noClue）にする。`NDA_OFFICE_MODE=query` で前の往復に戻せる。伝票の種類は `NDA_OFFICE_SLIP_KIND`（既定 invoice）。

## 9-0. 鹿内さんに決めてほしかったこと（元の問い）

1. 照合が決まったとき、工場のモニターに姓と車種（`label`。例「〇〇 様・車種」）を出してよいか。出さないなら「お客様: 決まりました」とだけ出す。推奨は出さない（決定「番号を返す」のまま。デモは練習用の客なので見栄えは変わらない）。
2. 承認のあと、すぐ業務ソフトに入れて画面を開けたまま人を待ってよいか。よければ、開けたままの上限（例 20 分。過ぎたら保存せず閉じ、人が来たら入れ直す）を決めてほしい。11/7 の撮影は「戻ると出来ている」なので、即入れを推す。
3. 返しを「事務所→工場の HTTP（合言葉）」にする、この案でよいか。返し箱（ファイル）にしたい理由（例: 工場の API に外から入れたくない）があれば、そちらで作り直す。
