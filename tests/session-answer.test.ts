/**
 * 父の答えで確認事項を解き、確認事項が 0 件のときだけ承認の言葉で承認する（W4）。
 * 素材は架空の文字起こし（tire-transcripts.json と試験の中の架空の発話）と架空の料金表。data/ は読まない。API を呼ばない。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { assembleInvoice } from "../lib/invoice/build";
import { type Candidate, enumerateCandidates } from "../lib/invoice/candidates";
import type { Question } from "../lib/invoice/questions";
import type { InvoiceRefs, LineRef } from "../lib/invoice/schema";
import type { LedgerEntry } from "../lib/ledger/lookup";
import { applyAnswers, answerSession, readAnswer } from "../lib/session/answer";
import { isApproval } from "../lib/session/approval";
import { type Extractor, startSession } from "../lib/session/run";
import { type Answer, newSession, readSession, type Session, writeSession } from "../lib/session/store";
import { toMonitorView } from "../lib/session/view";
import type { Segment, Transcript } from "../lib/stt/types";

const ROOT = resolve(import.meta.dirname, "..");
const LEDGER_PATH = join(ROOT, "tests/fixtures/tire-ledger.json");
const ledger = JSON.parse(readFileSync(LEDGER_PATH, "utf8")) as LedgerEntry[];
const transcripts = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/tire-transcripts.json"), "utf8")) as Transcript[];
const byId = (id: string) => {
  const t = transcripts.find((x) => x.recordingId === id);
  if (!t) throw new Error(`素材に無い: ${id}`);
  return t;
};

const made: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "nda-answer-"));
  made.push(d);
  return d;
}

before(async () => {
  process.env.NDA_LEDGER_PATH = LEDGER_PATH;
  process.env.NDA_SESSION_DIR = await tmp();
});
after(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
});

const cid = (cs: Candidate[], kind: Candidate["kind"], seg: number, text: string, nth = 0): string => {
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

const fict = (id: string, texts: string[]): Transcript => ({
  recordingId: id,
  vendor: "fictional",
  language: "ja",
  glossaryHint: false,
  segments: texts.map((text, i) => ({ startSec: i * 5, endSec: i * 5 + 5, speaker: null, text })),
});

/** 架空の文字起こしと、手書きの参照。 */
const VALVE = fict("valve-1", ["ゴムバルブも替えた。"]);
const NEG = fict("neg-1", ["脱着4本。", "バランス4本はしない。"]);
const TOTAL = fict("total-1", ["脱着4本、合計8000円。"]);
const CORR = fict("corr-1", ["脱着4本、いや2本。"]);
const UNUSED = fict("unused-1", ["脱着4本。", "2は傷がある。"]);
const NUT = fict("nut-1", ["ホイールナットも替えた。"]);
const THREE = fict("three-1", ["脱着4本。", "バランス4本はしない。", "ゴムバルブも替えた。"]);

function refsOf(t: Transcript, cs: Candidate[]): InvoiceRefs {
  switch (t.recordingId) {
    case "tire-001":
      return {
        lines: [ref(cid(cs, "item", 0, "脱着"), cid(cs, "qty", 0, "4本")), ref(cid(cs, "item", 1, "バランス"), cid(cs, "qty", 1, "4本"))],
        negations: [],
      };
    case "tire-003":
      return {
        lines: [ref(cid(cs, "item", 0, "脱着"), cid(cs, "qty", 0, "4本")), ref({ seg: 1, text: "ホイールナット" }, cid(cs, "qty", 1, "2個", 1))],
        negations: [],
      };
    case "valve-1":
      return { lines: [ref(cid(cs, "item", 0, "ゴムバルブ"), null)], negations: [] };
    case "neg-1":
      return {
        lines: [ref(cid(cs, "item", 0, "脱着"), cid(cs, "qty", 0, "4本")), ref(cid(cs, "item", 1, "バランス"), cid(cs, "qty", 1, "4本"))],
        negations: [],
      };
    case "total-1":
      return { lines: [ref(cid(cs, "item", 0, "脱着"), cid(cs, "qty", 0, "4本"))], negations: [] };
    case "corr-1": {
      const [q4, q2] = [cid(cs, "qty", 0, "4本"), cid(cs, "qty", 0, "2本")];
      return { lines: [ref(cid(cs, "item", 0, "脱着"), q4, { status: "corrected", correctedFrom: q4, correctedTo: q2 })], negations: [] };
    }
    case "unused-1":
      return { lines: [ref(cid(cs, "item", 0, "脱着"), cid(cs, "qty", 0, "4本"))], negations: [] };
    case "nut-1":
      return { lines: [ref({ seg: 0, text: "ホイールナット" }, null)], negations: [] };
    case "three-1":
      return {
        lines: [
          ref(cid(cs, "item", 0, "脱着"), cid(cs, "qty", 0, "4本")),
          ref(cid(cs, "item", 1, "バランス"), cid(cs, "qty", 1, "4本")),
          ref(cid(cs, "item", 2, "ゴムバルブ"), null),
        ],
        negations: [],
      };
  }
  throw new Error(`参照が無い: ${t.recordingId}`);
}

const fakeExtract: Extractor = async (t, l) => {
  const candidates = enumerateCandidates(t, l);
  return { candidates, ...refsOf(t, candidates) };
};

const mkAnswer = (lineIndex: number, a: Answer["action"]): Answer => ({
  at: "x",
  questionIndex: 0,
  lineIndex,
  provenance: { recordingId: "x", startSec: 0, endSec: 1, speaker: "father", quote: "x" },
  source: "answer",
  action: a,
});

let clock = 0;
const now = () => new Date(Date.UTC(2026, 10, 4, 12, 0, clock++));
let seq = 0;

async function start(t: Transcript, dir?: string): Promise<Session> {
  return startSession({ dir: dir ?? (await tmp()), transcript: t, ledger, extract: fakeExtract, now, id: `a${seq++}` });
}

const say = (text: string, speaker: string | null = "father"): Segment => ({ startSec: 100, endSec: 102, speaker, text });
const answer = (s: Session, text: string) => answerSession(s, say(text), ledger, now());
const last = (s: Session) => s.answers[s.answers.length - 1];

test("(1) tire-003: 「2個は何の数ですか」に「関係ない」、ホイールナットの単価に「1個200円」、「請求書頼む」で done", async () => {
  let s = await start(byId("tire-003"));
  assert.deepEqual(
    s.questions.map((q) => q.text),
    ["脱着は4本ですか。2個は何の数ですか", "ホイールナットの単価はいくらですか"],
  );
  s = answer(s, "関係ない");
  assert.deepEqual(last(s).action, { kind: "unrelated" });
  assert.equal(last(s).lineIndex, 0);
  assert.equal(s.invoice?.lines[0].qty, 4);
  assert.equal(s.status, "asking");
  assert.deepEqual(s.history.slice(-2).map((h) => h.status), ["drafting", "asking"]);
  assert.ok(!s.invoice?.confirmations.some((c) => c.lineIndex === 0));
  assert.deepEqual(s.questions.map((q) => q.text), ["ホイールナットの単価はいくらですか"]);

  s = answer(s, "1個200円");
  assert.deepEqual(last(s).action, { kind: "setUnitPrice", value: 200 });
  assert.equal(s.invoice?.confirmations.length, 0);
  assert.equal(s.invoice?.total, 2600);
  assert.deepEqual(s.questions, []);
  const v = toMonitorView(s);
  const nut = v.lines.find((l) => l.item === "ホイールナット");
  assert.deepEqual(nut?.answered, ["1個200円"]);
  assert.equal(v.total, 2600);

  s = answer(s, "請求書頼む");
  assert.equal(s.status, "done");
  assert.equal(s.approved, true);
  assert.equal(typeof s.approvedAt, "string");
  assert.equal(last(s).action.kind, "approve");
  assert.equal(last(s).provenance.recordingId, `${s.id}#answer-3`);
  assert.equal(last(s).provenance.speaker, "father");
  assert.equal(last(s).source, "answer");
  assert.throws(() => answer(s, "4本"), /asking/);
});

test("(2) 確認事項が残っている間の「請求書頼む」は承認しない", async () => {
  const s0 = await start(byId("tire-003"));
  const s = answer(s0, "請求書頼む");
  assert.equal(s.approved, false);
  assert.equal(s.approvedAt, null);
  assert.equal(s.status, "asking");
  assert.deepEqual(last(s).action, { kind: "unread", reason: "確認事項が残っている" });
  assert.deepEqual(s.invoice, s0.invoice);
  assert.deepEqual(s.questions, s0.questions);
});

test("(2b) isApproval は完全一致だけ。確認事項 0 件でも承認の言葉でなければ承認しない", async () => {
  for (const t of ["請求書頼む", "請求書、頼む。", "請求書たのむ", "せいきゅうしょ頼む", "請求書頼むじゃ", "んだ、請求書頼む", "請求書頼むよね"]) {
    assert.equal(isApproval(t), true, t);
  }
  for (const t of ["請求書は後で頼む", "よし、請求書頼む", "請求書頼むな", "請求書頼まない", "請求書頼まね", "請求書", "頼む", "はい", "請求書頼むじゃじゃ", "んだんだ請求書頼む", ""]) {
    assert.equal(isApproval(t), false, t);
  }
  const s0 = await start(byId("tire-001"));
  assert.equal(s0.invoice?.confirmations.length, 0);
  for (const t of ["請求書は後で頼む", "請求書頼まない"]) {
    const s = answer(s0, t);
    assert.equal(s.approved, false, t);
    assert.equal(s.status, "asking", t);
    assert.equal(last(s).action.kind, "unread", t);
  }
});

test("(3) 数量なしのゴムバルブに「4本」「4」「4つ」で qty 4 本、「4個」は unread で変わらない", async () => {
  const s0 = await start(VALVE);
  assert.deepEqual(s0.questions.map((q) => q.text), ["ゴムバルブは何本ですか"]);
  for (const t of ["4本", "4", "4つ", "四本"]) {
    const s = answer(s0, t);
    assert.deepEqual(last(s).action, { kind: "setQty", value: 4, unit: "本" }, t);
    assert.equal(s.invoice?.lines[0].qty, 4, t);
    assert.equal(s.invoice?.lines[0].unit, "本", t);
    assert.equal(s.invoice?.confirmations.length, 0, t);
    assert.equal(s.invoice?.total, 1320, t);
  }
  const s = answer(s0, "4個");
  assert.equal(last(s).action.kind, "unread");
  assert.deepEqual(s.invoice, s0.invoice);
  assert.deepEqual(s.questions, s0.questions);
  assert.equal(s.status, "asking");
  assert.deepEqual(s.history, s0.history);
});

test("(4) 数量の質問に言い直し・読めない数・円は unread", async () => {
  const s0 = await start(VALVE);
  for (const t of ["4本、いや2本", "よんほん", "二二十円", "330円", "はい", "0.5本", "4本と2本"]) {
    const s = answer(s0, t);
    assert.equal(last(s).action.kind, "unread", t);
    assert.deepEqual(s.invoice, s0.invoice, t);
    assert.deepEqual(s.questions, s0.questions, t);
  }
});

test("(5) 単価の質問に「4個で800円」は割り算しない。料金表と違う単価は、また確認事項", async () => {
  let s = await start(byId("tire-003"));
  s = answer(s, "関係ない");
  assert.equal(s.questions[0].reason, "unitPrice");
  for (const t of ["4個で800円", "1本200円", "200円か300円"]) {
    const u = answer(s, t);
    assert.equal(last(u).action.kind, "unread", t);
    assert.deepEqual(u.invoice, s.invoice, t);
  }
  // 単価の単位の無い「200円」は単価として読む
  assert.deepEqual(last(answer(s, "200円")).action, { kind: "setUnitPrice", value: 200 });

  // 料金表に当たる品目に「1本999円」
  const v = await start(VALVE);
  const q: Question = { lineIndex: 0, item: "エアバルブ交換", reason: "unitPrice", reasons: ["unitPrice"], text: "", confirmations: [] };
  const action = readAnswer(q, v.invoice?.lines[0], say("1本999円"), ledger);
  assert.deepEqual(action, { kind: "setUnitPrice", value: 999 });
  const mk = (lineIndex: number, a: Answer["action"]): Answer => ({
    at: "x",
    questionIndex: 0,
    lineIndex,
    provenance: { recordingId: "x", startSec: 0, endSec: 1, speaker: "father", quote: "x" },
    source: "answer",
    action: a,
  });
  const r = applyAnswers(
    { candidates: v.candidates, refs: v.refs as InvoiceRefs },
    VALVE,
    ledger,
    [mk(0, { kind: "setQty", value: 4, unit: "本" }), mk(0, action)],
  );
  assert.equal(r.total, null);
  assert.equal(r.lines[0].amount, null);
  assert.ok(r.confirmations.some((c) => c.message.includes("発話（999 円）と料金表（330 円）で違う")), JSON.stringify(r.confirmations));
});

test("(6) 否定の行の質問に「はい」で行が除かれ、「いいえ」で否定の確認事項が消える", async () => {
  const s0 = await start(NEG);
  assert.equal(s0.questions[0].reason, "negation");
  assert.equal(s0.questions[0].lineIndex, 1);
  assert.equal(s0.questions[0].text, "バランスの4本はやらなかったのですか");

  const yes = answer(s0, "はい");
  assert.deepEqual(last(yes).action, { kind: "drop" });
  assert.equal(last(yes).lineIndex, 1);
  assert.deepEqual(yes.invoice?.lines.map((l) => l.item), ["タイヤ脱着"]);
  assert.equal(yes.invoice?.total, 2200);
  assert.deepEqual(yes.questions, []);
  const r = applyAnswers({ candidates: yes.candidates, refs: yes.refs as InvoiceRefs }, NEG, ledger, yes.answers);
  assert.deepEqual(r.kept, [0]);
  // 承認できる
  assert.equal(answer(yes, "んだ、請求書頼む").status, "done");

  const no = answer(s0, "いいえ");
  assert.deepEqual(last(no).action, { kind: "deny" });
  assert.equal(no.invoice?.lines.length, 2);
  assert.equal(no.invoice?.confirmations.length, 0);
  assert.equal(no.invoice?.total, 6600);

  // 数は読まない
  assert.equal(last(answer(s0, "4本")).action.kind, "unread");
});

test("(7) 答え 0 件の applyAnswers は assembleInvoice と同じ", async () => {
  for (const t of [byId("tire-001"), byId("tire-003"), VALVE, NEG, TOTAL]) {
    const cs = enumerateCandidates(t, ledger);
    const refs = refsOf(t, cs);
    const { kept, ...rest } = applyAnswers({ candidates: cs, refs }, t, ledger, []);
    assert.deepEqual(rest, assembleInvoice({ candidates: cs, ...refs }, t, ledger), t.recordingId);
    assert.deepEqual(kept, refs.lines.map((_, i) => i));
  }
});

test("(8) 行に付かない質問（言った合計と計算が違う）は unread で残る", async () => {
  const s0 = await start(TOTAL);
  assert.equal(s0.questions[0].lineIndex, -1);
  assert.equal(s0.questions[0].reason, "total");
  for (const t of ["2200円", "はい", "8000円"]) {
    const s = answer(s0, t);
    assert.equal(last(s).action.kind, "unread", t);
    assert.equal(last(s).lineIndex, -1);
    assert.deepEqual(s.invoice, s0.invoice);
    assert.deepEqual(s.questions, s0.questions);
  }
  assert.equal(answer(s0, "請求書頼む").approved, false);
});

test("(9) answerSession と applyAnswers は入力を書き換えない", async () => {
  const s0 = await start(byId("tire-003"));
  const before = structuredClone(s0);
  const u = say("関係ない", "someone");
  const uBefore = structuredClone(u);
  const s1 = answerSession(s0, u, ledger, now());
  assert.deepEqual(s0, before);
  assert.deepEqual(u, uBefore);
  assert.equal(last(s1).provenance.speaker, "unknown");
  assert.equal(last(s1).provenance.quote, "関係ない");
  assert.equal(last(s1).provenance.recordingId, `${s0.id}#answer-1`);
  const b1 = structuredClone(s1);
  const s2 = answer(s1, "1個200円");
  assert.deepEqual(s1, b1);
  const x = { candidates: s2.candidates, refs: s2.refs as InvoiceRefs };
  const xb = structuredClone(x);
  const ab = structuredClone(s2.answers);
  applyAnswers(x, byId("tire-003"), ledger, s2.answers);
  assert.deepEqual(x, xb);
  assert.deepEqual(s2.answers, ab);
  // 否定の行を除いても入力の参照は減らない
  const n0 = await start(NEG);
  const nb = structuredClone(n0);
  answer(n0, "はい");
  assert.deepEqual(n0, nb);
});

test("(10) route: 400・404・409・200", async () => {
  const route = await import("../app/api/session/[id]/answer/route");
  const dir = process.env.NDA_SESSION_DIR as string;
  const req = (body: string) =>
    new Request("http://localhost/api/session/x/answer", { method: "POST", headers: { "content-type": "application/json" }, body });
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  const ok = JSON.stringify({ utterance: say("関係ない") });

  const s = await start(byId("tire-003"), dir);
  assert.equal((await route.POST(req("{"), ctx(s.id))).status, 400);
  assert.equal((await route.POST(req(JSON.stringify({})), ctx(s.id))).status, 400);
  assert.equal((await route.POST(req(JSON.stringify({ utterance: { text: "4本" } })), ctx(s.id))).status, 400);
  assert.equal((await route.POST(req(ok), ctx("none"))).status, 404);
  assert.equal((await route.POST(req(ok), ctx("../x"))).status, 404);

  await writeSession(dir, newSession("idle1", now()));
  assert.equal((await route.POST(req(ok), ctx("idle1"))).status, 409);

  const res = await route.POST(req(ok), ctx(s.id));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { view: ReturnType<typeof toMonitorView> };
  assert.equal(body.view.state, "asking");
  assert.deepEqual(body.view.questions, ["ホイールナットの単価はいくらですか"]);
  const saved = await readSession(dir, s.id);
  assert.equal(saved?.answers.length, 1);
  assert.deepEqual(body.view, toMonitorView(saved));

  await route.POST(req(JSON.stringify({ utterance: say("1個200円") })), ctx(s.id));
  const done = await route.POST(req(JSON.stringify({ utterance: say("請求書頼む") })), ctx(s.id));
  assert.equal(done.status, 200);
  const dv = (await done.json()) as { view: ReturnType<typeof toMonitorView> };
  assert.equal(dv.view.state, "done");
  assert.equal(dv.view.approved, true);
  assert.equal(dv.view.total, 2600);
  assert.equal((await route.POST(req(ok), ctx(s.id))).status, 409);
});

// --- 答えの形（質問の種類ごとに受け取れる形を決め、余計な語が残れば unread） ---

test("数量の質問: 知らない単位・別の品目の語・数が 2 つは unread。前置き・付け足し・質問の品目の語は取り除く", async () => {
  const s0 = await start(VALVE);
  assert.equal(s0.invoice?.confirmations.length, 1, "「数量が分からない」は 1 件（resolve と price で重ねない）");
  for (const t of ["4人", "脱着4本", "4本4本", "4本と2", "組替4本", "4本くらい", "たぶん4本", "4本だった", "ゴムバルブ4本と脱着"]) {
    const s = answer(s0, t);
    assert.equal(last(s).action.kind, "unread", t);
    assert.deepEqual(s.invoice, s0.invoice, t);
  }
  for (const t of ["んだ、4本だ", "はい、4本です。", "4本じゃ", "ゴムバルブは4本", "エアバルブ交換4本", "バルブ交換も4本だよ", "4だ"]) {
    assert.deepEqual(last(answer(s0, t)).action, { kind: "setQty", value: 4, unit: "本" }, t);
  }
});

test("単価の質問: 円の金額 1 つだけ。単位が行と違う・別の品目・余計な語は unread。数量の確認事項は解かない", async () => {
  let s = await start(byId("tire-003"));
  s = answer(s, "関係ない");
  assert.equal(s.questions[0].reason, "unitPrice");
  for (const t of ["1本200円", "脱着1個200円", "200円くらい", "200円と300円", "1個200円で4個"]) {
    assert.equal(last(answer(s, t)).action.kind, "unread", t);
  }
  for (const t of ["ホイールナットは1個200円です", "んだ、200円だ", "単価は200円"]) {
    assert.deepEqual(last(answer(s, t)).action, { kind: "setUnitPrice", value: 200 }, t);
  }
  // 数量も単価も無い行に単価の答えを当てても、数量の確認事項は残る
  const n = await start(NUT);
  const q: Question = { lineIndex: 0, item: "ホイールナット", reason: "unitPrice", reasons: ["unitPrice"], text: "", confirmations: [] };
  // 行に単位が無いので「1個200円」は読まない。単位の無い「200円」だけ
  assert.equal(readAnswer(q, n.invoice?.lines[0], say("1個200円"), ledger, n.candidates).kind, "unread");
  const act = readAnswer(q, n.invoice?.lines[0], say("200円"), ledger, n.candidates);
  assert.deepEqual(act, { kind: "setUnitPrice", value: 200 });
  const r = applyAnswers({ candidates: n.candidates, refs: n.refs as InvoiceRefs }, NUT, ledger, [mkAnswer(0, act)]);
  assert.deepEqual(r.confirmations.map((c) => c.field), ["qty"]);
  assert.equal(r.lines[0].unitPrice, 200);
});

test("言い直しの質問: 質問に出た値のどちらか 1 つだけ。単価などは unread。単価の答えは言い直しを消さない", async () => {
  const s0 = await start(CORR);
  assert.deepEqual(s0.questions.map((q) => q.text), ["脱着は4本と2本のどちらですか"]);
  for (const t of ["1本550円", "550円", "3本", "3", "2個", "4本か2本", "脱着2本と4本"]) {
    const s = answer(s0, t);
    assert.equal(last(s).action.kind, "unread", t);
    assert.deepEqual(s.invoice, s0.invoice, t);
  }
  for (const [t, v] of [["2本", 2], ["2", 2], ["んだ、2本だ", 2], ["脱着は4本", 4]] as const) {
    const s = answer(s0, t);
    assert.deepEqual(last(s).action, { kind: "setQty", value: v, unit: "本" }, t);
    assert.equal(s.invoice?.confirmations.length, 0, t);
    assert.equal(s.invoice?.total, v * 550, t);
  }
  const r = applyAnswers({ candidates: s0.candidates, refs: s0.refs as InvoiceRefs }, CORR, ledger, [
    mkAnswer(0, { kind: "setUnitPrice", value: 550 }),
  ]);
  assert.ok(r.confirmations.some((c) => c.message.includes("言い直し")), JSON.stringify(r.confirmations));
  assert.equal(r.total, null);
});

test("「X は何の数ですか」: 数では解かない。「関係ない」の全体一致だけで、その数を関係なしとして解く", async () => {
  const s0 = await start(UNUSED);
  assert.deepEqual(s0.questions.map((q) => q.text), ["脱着は4本ですか。2は何の数ですか"]);
  for (const t of ["2は傷の数", "2本", "4本", "はい", "いいえ", "違う", "関係ないかも", "2は関係ない"]) {
    const s = answer(s0, t);
    assert.equal(last(s).action.kind, "unread", t);
    assert.deepEqual(s.invoice, s0.invoice, t);
  }
  for (const t of ["関係ない", "関係ねえ。", "関係ないです"]) {
    const s = answer(s0, t);
    assert.deepEqual(last(s).action, { kind: "unrelated" }, t);
    assert.equal(s.invoice?.lines[0].qty, 4, t);
    assert.equal(s.invoice?.confirmations.length, 0, t);
    assert.equal(s.invoice?.total, 2200, t);
  }
});

test("否定の質問: 「まいね」は読まない（だめ・いけないの意味でどちらとも取れる）。「んだ」は はい", async () => {
  const s0 = await start(NEG);
  assert.equal(last(answer(s0, "まいね")).action.kind, "unread");
  assert.deepEqual(last(answer(s0, "んだ")).action, { kind: "drop" });
});

test("話者: 客の声では承認も行の取り消しもしない。話者が分からない声と父は通す", async () => {
  const n0 = await start(NEG);
  const c = answerSession(n0, say("はい", "customer"), ledger, now());
  assert.deepEqual(last(c).action, { kind: "unread", reason: "客の声" });
  assert.deepEqual(c.invoice, n0.invoice);
  assert.deepEqual(last(answerSession(n0, say("はい", null), ledger, now())).action, { kind: "drop" });
  // 客の声の数量の答えは通す（承認と取り消しだけを止める）
  const v0 = await start(VALVE);
  assert.equal(last(answerSession(v0, say("4本", "customer"), ledger, now())).action.kind, "setQty");

  const s0 = await start(byId("tire-001"));
  const cs = answerSession(s0, say("請求書頼む", "customer"), ledger, now());
  assert.equal(cs.status, "asking");
  assert.equal(cs.approved, false);
  assert.deepEqual(last(cs).action, { kind: "unread", reason: "客の声" });
  assert.equal(answerSession(s0, say("請求書頼む", null), ledger, now()).status, "done");
  assert.equal(answerSession(s0, say("請求書頼む", "father"), ledger, now()).status, "done");
});

test("表示の出所: 行を除いた後も、答えは元の行の添字で引く（3 行で真ん中を除く）", async () => {
  let s = await start(THREE);
  assert.equal(s.questions[0].lineIndex, 1);
  s = answer(s, "はい");
  assert.deepEqual(s.invoice?.lines.map((l) => l.item), ["タイヤ脱着", "エアバルブ交換"]);
  assert.deepEqual(toMonitorView(s).lines.map((l) => l.answered), [[], []]);
  s = answer(s, "4本");
  assert.equal(last(s).lineIndex, 2);
  assert.deepEqual(toMonitorView(s).lines.map((l) => [l.item, l.answered]), [["タイヤ脱着", []], ["エアバルブ交換", ["4本"]]]);
  assert.equal(s.invoice?.total, 2200 + 1320);
});
