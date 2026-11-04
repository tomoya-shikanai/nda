/**
 * 抽出（extractInvoice・refSchema）と、条件 17〜19 の検証。Claude は偽サーバーで置き換える。モデルの品質は検証しない。
 * 確かめるのは、要求に発話と候補が入ること、候補に無い ID がスキーマで落ちること、モデルの判定と否定の文が確認事項になること。
 * 素材は架空の文字起こし（tire-transcripts.json）と、この試験の中で作る架空の録音（recordingId "adv"）。証明には使わない。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { type Candidate, enumerateCandidates } from "../lib/invoice/candidates";
import { extractInvoice, refSchema } from "../lib/invoice/extract";
import { CORRECTION_CUES, resolveInvoice } from "../lib/invoice/resolve";
import type { InvoiceRefs, LineRef, NegatedSentence } from "../lib/invoice/schema";
import type { LedgerEntry } from "../lib/ledger/lookup";
import type { Segment, Transcript } from "../lib/stt/types";

const ROOT = resolve(import.meta.dirname, "..");
const ledger = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/tire-ledger.json"), "utf8")) as LedgerEntry[];
const transcripts = JSON.parse(
  readFileSync(join(ROOT, "tests/fixtures/tire-transcripts.json"), "utf8"),
) as Transcript[];
const byId = (id: string) => {
  const t = transcripts.find((x) => x.recordingId === id);
  if (!t) throw new Error(`素材に無い: ${id}`);
  return t;
};

/** 架空の録音。発話は [開始, 終了, 話者, 文]。 */
const rec = (...segs: [number, number, string | null, string][]): Transcript => ({
  recordingId: "adv",
  vendor: "fictional",
  language: "ja",
  glossaryHint: false,
  segments: segs.map(([startSec, endSec, speaker, text]): Segment => ({ startSec, endSec, speaker, text })),
});
/** 3 秒ずつの発話の架空の録音（話者は父）。 */
const seq = (...texts: string[]) => rec(...texts.map((x, i): [number, number, string, string] => [i * 3, i * 3 + 3, "father", x]));

const id = (cs: Candidate[], kind: Candidate["kind"], seg: number, text: string, nth = 0): string => {
  const hit = cs.filter((c) => c.kind === kind && c.seg === seg && c.text === text)[nth];
  if (!hit) throw new Error(`候補が無い: ${kind} #${seg} ${text} ${nth}`);
  return hit.id;
};

const ref = (item: LineRef["item"], qty: string | null, over: Partial<LineRef> = {}): LineRef => ({
  item,
  qty,
  unitPrice: null,
  amount: null,
  status: "done",
  evidence: [],
  correctedFrom: null,
  correctedTo: null,
  ...over,
});

const has = (cf: { field: string; message: string; lineIndex: number }[], field: string, word: string, lineIndex?: number) =>
  cf.some((c) => c.field === field && c.message.includes(word) && (lineIndex === undefined || c.lineIndex === lineIndex));

/** 3 fixture の正しい参照。 */
function goodRefs(t: Transcript, cs: Candidate[]): InvoiceRefs {
  switch (t.recordingId) {
    case "tire-001":
      return {
        lines: [ref(id(cs, "item", 0, "脱着"), id(cs, "qty", 0, "4本")), ref(id(cs, "item", 1, "バランス"), id(cs, "qty", 1, "4本"))],
        negations: [],
      };
    case "tire-002":
      return {
        lines: [
          ref(id(cs, "item", 0, "組替"), id(cs, "qty", 0, "4本")),
          ref(id(cs, "item", 1, "バランス"), id(cs, "qty", 1, "4本", 0)),
          ref(id(cs, "item", 1, "ゴムバルブ"), id(cs, "qty", 1, "4本", 1), { unitPrice: id(cs, "unitPrice", 2, "1本330円") }),
          ref(id(cs, "item", 3, "廃タイヤ"), id(cs, "qty", 3, "4本")),
        ],
        negations: [],
      };
    default:
      return {
        lines: [
          ref(id(cs, "item", 0, "脱着"), id(cs, "qty", 0, "4本")),
          ref({ seg: 1, text: "ホイールナット" }, id(cs, "qty", 1, "2個", 1), { status: "unsure", evidence: [id(cs, "qty", 1, "2個", 0)] }),
        ],
        negations: [{ seg: 2, text: "ナットの値段は後で調べる。" }],
      };
  }
}

let server: Server;
let received: Record<string, unknown>[] = [];
let reply: unknown = null;
/** null 以外なら、応答の content をこれにする（parsed_output が無い応答を作る）。 */
let rawContent: unknown[] | null = null;

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push(JSON.parse(body));
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: "msg",
          type: "message",
          role: "assistant",
          model: "fake",
          content: rawContent ?? [{ type: "text", text: JSON.stringify(reply) }],
          stop_reason: rawContent ? "max_tokens" : "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  // claude() は最初の呼び出しで環境変数を読むので、extractInvoice より前に設定する
  process.env.ANTHROPIC_API_KEY = "test";
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${addr.port}`;
});
after(() => server.close());

const userText = (req: Record<string, unknown>) =>
  (req.messages as { content: { text: string }[] }[]).map((m) => m.content.map((c) => c.text).join("")).join("\n");

// --- (1)(2) 要求と戻り値 ---

test("抽出: 3 fixture で、要求の user に全発話と全候補、schema に候補の ID の enum が入り、無い ID は入らない", async () => {
  for (const t of transcripts) {
    const cs = enumerateCandidates(t, ledger);
    received = [];
    rawContent = null;
    reply = goodRefs(t, cs);
    await extractInvoice(t, ledger);
    assert.equal(received.length, 1);
    const req = received[0];
    const user = userText(req);
    assert.ok(user.includes(`録音 ID: ${t.recordingId}`));
    t.segments.forEach((s, i) => {
      assert.ok(user.includes(`[#${i} `), `添字が無い: #${i}`);
      assert.ok(user.includes(s.text), `発話が要求に無い: ${s.text}`);
      assert.ok(user.includes(`[#${i} ${s.startSec}-${s.endSec} ${s.speaker ?? "?"}] ${s.text}`), `発話の行の形: #${i}`);
    });
    for (const c of cs) {
      assert.ok(user.includes(`${c.id} [#${c.seg}] ${c.text}`), `候補が要求に無い: ${c.id} ${c.text}`);
      if (c.ledgerItem) assert.ok(user.includes(c.ledgerItem), `正式名が無い: ${c.ledgerItem}`);
    }
    const oc = req.output_config as { format?: { type?: string; schema?: unknown } } | undefined;
    assert.equal(oc?.format?.type, "json_schema");
    // SDK の transformJSONSchema は enum を description の「{enum: [...]}」に移す（値は JSON 文字列の中で \" に包まれる）。
    // 候補に無い ID は、parse の段で zod が落とす（下の throw の試験）。
    const schema = JSON.stringify(oc?.format?.schema);
    const inSchema = (x: string) => new RegExp(`\\\\?"${x}\\\\?"`).test(schema);
    assert.match(schema, /enum/);
    for (const c of cs) assert.ok(inSchema(c.id), `enum に無い: ${c.id} ${schema}`);
    assert.ok(!inSchema("q99"), "候補に無い ID が enum に入っている");
    assert.ok(!inSchema("i99"));
  }
});

test("抽出: 偽サーバーの参照が lines・negations になり、candidates は enumerateCandidates と同じ", async () => {
  for (const t of transcripts) {
    const cs = enumerateCandidates(t, ledger);
    rawContent = null;
    reply = goodRefs(t, cs);
    const got = await extractInvoice(t, ledger);
    assert.deepEqual(got.candidates, cs, t.recordingId);
    assert.deepEqual(got.lines, (reply as InvoiceRefs).lines, t.recordingId);
    assert.deepEqual(got.negations, (reply as InvoiceRefs).negations, t.recordingId);
  }
});

// --- (3) 解釈できない出力 ---

test("抽出: 存在しない ID・種類の違う ID を返すと throw、parsed_output が無ければ throw", async () => {
  const t = byId("tire-001");
  const cs = enumerateCandidates(t, ledger);
  const good = goodRefs(t, cs);
  rawContent = null;
  for (const bad of [
    { ...good, lines: [ref("i1", "q99")] },
    { ...good, lines: [ref("i99", "q1")] },
    { ...good, lines: [ref("i1", "i1")] }, // qty 欄に item の ID
    { ...good, lines: [ref("i1", "q1", { evidence: ["q99"] })] },
    { ...good, lines: [ref("i1", "q1", { correctedTo: "q99" })] },
    { ...good, lines: [ref("i1", "q1", { status: "maybe" as LineRef["status"] })] },
  ]) {
    reply = bad;
    await assert.rejects(extractInvoice(t, ledger), JSON.stringify(bad.lines));
  }
  rawContent = [];
  await assert.rejects(extractInvoice(t, ledger), /解釈できない/);
  rawContent = null;
});

test("refSchema: 候補が 0 件の種類の欄は null だけ、evidence は空配列だけ", () => {
  const t = seq("こんにちは。");
  const cs = enumerateCandidates(t, ledger);
  assert.deepEqual(cs, []);
  const s = refSchema(cs);
  const ok = { lines: [ref({ seg: 0, text: "こんにちは" }, null)], negations: [] };
  assert.ok(s.safeParse(ok).success);
  assert.ok(!s.safeParse({ ...ok, lines: [ref({ seg: 0, text: "x" }, "q1")] }).success);
  assert.ok(!s.safeParse({ ...ok, lines: [ref({ seg: 0, text: "x" }, null, { evidence: ["q1"] })] }).success);
  assert.ok(!s.safeParse({ ...ok, lines: [ref("i1", null)] }).success);
  // 数量の候補だけがある録音では、単価・金額の欄は null だけ
  const t2 = seq("ナット2個。");
  const c2 = enumerateCandidates(t2, ledger);
  const s2 = refSchema(c2);
  assert.ok(s2.safeParse({ lines: [ref({ seg: 0, text: "ナット" }, "q1")], negations: [] }).success);
  assert.ok(!s2.safeParse({ lines: [ref({ seg: 0, text: "ナット" }, "q1", { unitPrice: "q1" })], negations: [] }).success);
});

// --- (4) system ---

test("抽出: system に数字を書かない・null・津軽弁・negations・status の指示が入る", async () => {
  const t = byId("tire-001");
  received = [];
  rawContent = null;
  reply = goodRefs(t, enumerateCandidates(t, ledger));
  await extractInvoice(t, ledger);
  const system = String(received[0].system);
  for (const w of [
    "数字を書かない",
    "null",
    "津軽弁",
    "標準語に直さない",
    "negations",
    "status",
    "done",
    "negated",
    "corrected",
    "unsure",
    "evidence",
    "correctedFrom",
    "correctedTo",
    "替えてない",
    "しません",
    "大丈夫です",
    "いいです",
    "行にしたかどうかによらず",
    "作業でないと判断した発話は行にしない",
    "後の数を自分で選んで done にしない",
  ]) {
    assert.ok(system.includes(w), w);
  }
});

// --- (5)(6) 条件 17 ---

test("条件 17: tire-001・tire-002 の正しい参照（done、negations 空）は確認事項 0 件", () => {
  for (const rid of ["tire-001", "tire-002"]) {
    const t = byId(rid);
    const cs = enumerateCandidates(t, ledger);
    const r = goodRefs(t, cs);
    assert.deepEqual(resolveInvoice(r.lines, cs, t, ledger, r.negations).confirmations, [], rid);
  }
});

test("条件 17: status negated・corrected・unsure の行はそれぞれ確認事項", () => {
  const t = byId("tire-001");
  const cs = enumerateCandidates(t, ledger);
  const base = goodRefs(t, cs).lines;
  const q0 = id(cs, "qty", 0, "4本");
  const q1 = id(cs, "qty", 1, "4本");
  const cases: [Partial<LineRef>, string][] = [
    [{ status: "negated", evidence: [q1] }, "否定"],
    [{ status: "corrected", evidence: [q1], correctedFrom: q0, correctedTo: q1 }, "言い直し"],
    [{ status: "unsure", evidence: [q1] }, "確かでない"],
  ];
  for (const [over, word] of cases) {
    const refs = [base[0], { ...base[1], ...over }];
    const r = resolveInvoice(refs, cs, t, ledger);
    assert.ok(has(r.confirmations, "line", word, 1), `${word} ${JSON.stringify(r.confirmations)}`);
    assert.ok(!r.confirmations.some((c) => c.lineIndex === 0), word);
  }
  // 言い直しの確認事項は、訂正前・訂正後の候補の文字列を含む
  const corrected = resolveInvoice([{ ...base[1], ...cases[1][0] }], cs, t, ledger);
  assert.ok(has(corrected.confirmations, "line", "4本 → 4本", 0), JSON.stringify(corrected.confirmations));
});

test("条件 17: evidence・correctedFrom・correctedTo の ID が候補に無ければ「参照が不正」", () => {
  const t = byId("tire-001");
  const cs = enumerateCandidates(t, ledger);
  const base = goodRefs(t, cs).lines[0];
  for (const over of [{ evidence: ["q99"] }, { correctedFrom: "q99" }, { correctedTo: "z1" }]) {
    const r = resolveInvoice([{ ...base, ...over }], cs, t, ledger);
    assert.ok(has(r.confirmations, "line", "参照が不正", 0), JSON.stringify(over));
  }
});

// --- (7) 条件 18 ---

/** Codex の 2 回目のレビューの例（架空）と、その文で作る行の品目。 */
const NEGATED: [string, (cs: Candidate[]) => LineRef["item"], boolean][] = [
  ["脱着4本は替えてない。", (cs) => id(cs, "item", 0, "脱着"), true],
  ["バランスはしません。", (cs) => id(cs, "item", 0, "バランス"), false],
  ["バルブは替えね。", () => ({ seg: 0, text: "バルブ" }), false],
  ["バランスは大丈夫です。", (cs) => id(cs, "item", 0, "バランス"), false],
  ["バランスはいいです。", (cs) => id(cs, "item", 0, "バランス"), false],
];

test("条件 18: Codex の 2 回目の例は、行を negated にしても、done で文を negations に挙げても「否定」", () => {
  for (const [s, item, withQty] of NEGATED) {
    const t = seq(s);
    const cs = enumerateCandidates(t, ledger);
    const it = item(cs);
    const qty = withQty ? id(cs, "qty", 0, "4本") : null;
    const ev = typeof it === "string" ? [it] : [];

    const asLine = resolveInvoice([ref(it, qty, { status: "negated", evidence: ev })], cs, t, ledger);
    assert.ok(has(asLine.confirmations, "line", "否定", 0), `negated ${s} ${JSON.stringify(asLine.confirmations)}`);

    const neg: NegatedSentence[] = [{ seg: 0, text: s }];
    const asSentence = resolveInvoice([ref(it, qty)], cs, t, ledger, neg);
    assert.ok(
      has(asSentence.confirmations, "line", "モデルの挙げた否定の文", 0) && has(asSentence.confirmations, "line", "（否定）", 0),
      `negations ${s} ${JSON.stringify(asSentence.confirmations)}`,
    );
  }
});

test("条件 18: 否定の文の一部（文の中の語句）を挙げても、範囲に入る行は「否定」", () => {
  const t = seq("今日は脱着4本は替えてない、バランスだけ。");
  const cs = enumerateCandidates(t, ledger);
  const r = resolveInvoice(
    [ref(id(cs, "item", 0, "脱着"), id(cs, "qty", 0, "4本")), ref(id(cs, "item", 0, "バランス"), null)],
    cs,
    t,
    ledger,
    [{ seg: 0, text: "脱着4本は替えてない" }],
  );
  assert.ok(has(r.confirmations, "line", "モデルの挙げた否定の文", 0), JSON.stringify(r.confirmations));
  assert.ok(!has(r.confirmations, "line", "モデルの挙げた否定の文", 1), JSON.stringify(r.confirmations));
});

test("条件 18: negations の文が発話に無い・seg が範囲外なら lineIndex -1 の「否定の文が発話に無い」", () => {
  const t = seq("脱着4本。");
  const cs = enumerateCandidates(t, ledger);
  const lines = [ref(id(cs, "item", 0, "脱着"), id(cs, "qty", 0, "4本"))];
  for (const neg of [
    { seg: 0, text: "脱着4本は替えない。" },
    { seg: 1, text: "脱着4本。" },
    { seg: -1, text: "脱着4本。" },
    { seg: 0.5, text: "脱着4本。" },
    { seg: 0, text: "" },
  ]) {
    const r = resolveInvoice(lines, cs, t, ledger, [neg]);
    assert.ok(has(r.confirmations, "line", "否定の文が発話に無い", -1), `${JSON.stringify(neg)} ${JSON.stringify(r.confirmations)}`);
  }
});

test("条件 18: 否定の文の候補を使った行が無ければ、条件 18 の確認事項は出ない", () => {
  const t = seq("組替はしません。脱着4本。");
  const cs = enumerateCandidates(t, ledger);
  const r = resolveInvoice([ref(id(cs, "item", 0, "脱着"), id(cs, "qty", 0, "4本"))], cs, t, ledger, [
    { seg: 0, text: "組替はしません。" },
  ]);
  assert.ok(!r.confirmations.some((c) => c.message.includes("否定")), JSON.stringify(r.confirmations));
  // 漢数字・全角の書き方の違いは正規化して比べる
  const t2 = seq("脱着四本は替えてない。");
  const c2 = enumerateCandidates(t2, ledger);
  const r2 = resolveInvoice([ref(id(c2, "item", 0, "脱着"), id(c2, "qty", 0, "4本"))], c2, t2, ledger, [
    { seg: 0, text: "脱着四本は替えてない。" },
  ]);
  assert.ok(has(r2.confirmations, "line", "モデルの挙げた否定の文", 0), JSON.stringify(r2.confirmations));
});

// --- (8) 条件 19 ---

test("条件 19: 「脱着4本。」「いや2本。」「バランスも。」で 2本 をバランスに付けると「言い直し」、corrected でも確認事項", () => {
  assert.ok(["いや", "やっぱり", "じゃなくて", "違う"].every((w) => CORRECTION_CUES.includes(w)));
  const t = rec([0, 2, "father", "脱着4本。"], [2, 4, "father", "いや2本。"], [4, 6, "father", "バランスも。"]);
  const cs = enumerateCandidates(t, ledger);
  const q4 = id(cs, "qty", 0, "4本");
  const q2 = id(cs, "qty", 1, "2本");
  const datsu = ref(id(cs, "item", 0, "脱着"), q4);
  const bal = ref(id(cs, "item", 2, "バランス"), q2);
  const r = resolveInvoice([datsu, bal], cs, t, ledger);
  assert.ok(has(r.confirmations, "qty", "言い直し", 1), JSON.stringify(r.confirmations));
  assert.deepEqual(r.unused, []);

  const r2 = resolveInvoice([datsu, { ...bal, status: "corrected", evidence: [q4, q2], correctedFrom: q4, correctedTo: q2 }], cs, t, ledger);
  assert.ok(has(r2.confirmations, "line", "言い直し", 1), JSON.stringify(r2.confirmations));
  assert.ok(has(r2.confirmations, "qty", "言い直し", 1), JSON.stringify(r2.confirmations));
});

test("条件 19: 合図が無い・単位が違う・20 秒より遠いときは出ない", () => {
  for (const segs of [
    [[0, 2, "father", "脱着4本。"], [2, 4, "father", "それと2本。"], [4, 6, "father", "バランスも。"]],
    [[0, 2, "father", "脱着4本。"], [2, 4, "father", "いや2個。"], [4, 6, "father", "バランスも。"]],
    [[0, 2, "father", "脱着4本。"], [30, 32, "father", "いや2本。"], [32, 34, "father", "バランスも。"]],
  ] as [number, number, string, string][][]) {
    const t = rec(...segs);
    const cs = enumerateCandidates(t, ledger);
    const r = resolveInvoice([ref("i1", "q1"), ref("i2", "q2")], cs, t, ledger);
    assert.ok(!r.confirmations.some((c) => c.message.includes("訂正の合図")), `${segs.map((s) => s[3]).join("/")} ${JSON.stringify(r.confirmations)}`);
  }
});

// --- (9) 入力を書き換えない ---

test("呼び出しの前後で参照・候補・文字起こし・料金表が変わらない", async () => {
  const t = byId("tire-003");
  const cs = enumerateCandidates(t, ledger);
  const refs = goodRefs(t, cs);
  rawContent = null;
  reply = refs;
  const before = structuredClone([refs, cs, t, ledger]);
  const got = await extractInvoice(t, ledger);
  assert.deepEqual([refs, cs, t, ledger], before);
  const r = resolveInvoice(got.lines, got.candidates, t, ledger, got.negations);
  assert.deepEqual([refs, cs, t, ledger], before);
  assert.deepEqual(got.candidates, cs);
  assert.ok(has(r.confirmations, "line", "確かでない", 1));
});
