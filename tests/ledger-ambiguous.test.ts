/**
 * 料金表に無い言い方（言い換え）の聞き返しと、言える作業の一覧（#46）。
 * 素材は架空の発話と架空の料金表（tests/fixtures/tire-ledger.json）。抽出は偽物（API を呼ばない）。data/ は読まない。
 * 見るのは自分で作った一時フォルダの中だけ。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { addAmbiguousLines } from "../lib/invoice/ambiguous";
import { enumerateCandidates } from "../lib/invoice/candidates";
import type { LineRef } from "../lib/invoice/schema";
import {
  choicesOf,
  findEntry,
  type LedgerBook,
  ledgerEntries,
  loadLedger,
  loadLedgerBook,
  parseLedgerBook,
  publicLedger,
} from "../lib/ledger/lookup";
import { answerSession } from "../lib/session/answer";
import { type Extractor, startSession } from "../lib/session/run";
import type { Session } from "../lib/session/store";
import { toMonitorView } from "../lib/session/view";
import type { Transcript } from "../lib/stt/types";

const ROOT = resolve(import.meta.dirname, "..");
const LEDGER_PATH = join(ROOT, "tests/fixtures/tire-ledger.json");
const book = parseLedgerBook(JSON.parse(readFileSync(LEDGER_PATH, "utf8")));
const ledger = ledgerEntries(book);

const made: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "nda-ambiguous-"));
  made.push(d);
  return d;
}
after(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
});

let clock = 0;
const now = () => new Date(Date.UTC(2026, 10, 5, 11, 0, clock++));
let seq = 0;

const fict = (texts: string[]): Transcript => ({
  recordingId: `amb-${seq}`,
  vendor: "fictional",
  language: "ja",
  glossaryHint: false,
  segments: texts.map((text, i) => ({ startSec: i * 4, endSec: i * 4 + 3, speaker: null, text })),
});

/** 偽の抽出: 行を作らない（モデルが言い換えの言葉を行にしなかった場合）。 */
const noLines: Extractor = async (t, l) => ({ candidates: enumerateCandidates(t, l), lines: [], negations: [] });

async function startIn(texts: string[], extract: Extractor = noLines): Promise<Session> {
  const dir = await tmp();
  return startSession({ dir, transcript: fict(texts), ledger, extract, now, id: `amb${seq++}` });
}

const answer = (s: Session, text: string) => answerSession(s, { startSec: 0, endSec: 1, speaker: "father", text }, ledger, now());

// --- 料金表の本 ---

test("料金表のファイル: 前の形（配列だけ）も { items, ambiguous } も読む。形が違えば throw、読めなければ空", async () => {
  const items = book.items;
  assert.deepEqual(parseLedgerBook(items), { items, ambiguous: [] });
  assert.equal(book.ambiguous.length, 1);
  assert.throws(() => parseLedgerBook({ items: [{ item: "x" }] }), /品目の形/);
  assert.throws(() => parseLedgerBook({ items, ambiguous: [{ word: 1 }] }), /言い換えの形/);
  assert.throws(() => parseLedgerBook("x"), /品目の形/);

  const dir = await tmp();
  const arr = join(dir, "array.json");
  await writeFile(arr, JSON.stringify(items));
  assert.deepEqual(await loadLedger(arr), items);
  assert.deepEqual(await loadLedger(LEDGER_PATH), ledger);
  assert.deepEqual(await loadLedgerBook(join(dir, "none.json")), { items: [], ambiguous: [] });
  const bad = join(dir, "bad.json");
  await writeFile(bad, "{");
  assert.deepEqual(await loadLedger(bad), []);
});

test("言い換えの言葉は選択肢の品目の別名に足し、1 つに決めない。料金表に当たる選択肢が 2 つ未満なら足さない。入力は書き換えない", () => {
  const before = structuredClone(book);
  const merged = ledgerEntries(book);
  assert.deepEqual(book, before);
  assert.equal(findEntry(merged, "タイヤ交換"), null);
  assert.deepEqual(
    choicesOf(merged, "タイヤ交換").map((e) => e.item),
    ["タイヤ組替", "タイヤ脱着"],
  );
  assert.equal(findEntry(merged, "脱着")?.item, "タイヤ脱着");

  const one: LedgerBook = { items: book.items, ambiguous: [{ word: "タイヤ交換", choices: ["タイヤ脱着", "ありもしない品目"] }] };
  const m1 = ledgerEntries(one);
  assert.equal(findEntry(m1, "タイヤ交換"), null, "選択肢 1 つでも、その品目に決めない");
  assert.deepEqual(choicesOf(m1, "タイヤ交換"), []);
});

test("画面に出す料金表: 品目名・別名・単位・単価と言い換え。出所は出さない", () => {
  const p = publicLedger(book);
  assert.equal(p.items.length, book.items.length);
  assert.deepEqual(Object.keys(p.items[0]).sort(), ["aliases", "item", "price", "unit"]);
  assert.ok(!JSON.stringify(p).includes("source"));
  assert.ok(!JSON.stringify(p).includes("架空（試験用）"));
  assert.deepEqual(p.items[1].aliases, ["脱着", "履き替え"], "言い換えの言葉は別名の一覧に混ぜない");
  assert.deepEqual(p.ambiguous, [{ word: "タイヤ交換", choices: ["タイヤ組替", "タイヤ脱着"] }]);
});

test("GET /api/ledger: 出所の欄の無い一覧を返す", async () => {
  process.env.NDA_LEDGER_PATH = LEDGER_PATH;
  const route = await import("../app/api/ledger/route");
  const r = await route.GET(new Request("http://localhost/api/ledger"));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const text = await r.text();
  assert.ok(!text.includes("source"));
  assert.deepEqual(JSON.parse(text), publicLedger(book));
});

// --- 行を補う ---

test("addAmbiguousLines: モデルが行にしなかった言い換えの言葉に行を足す（数量は同じ文の後ろの数量）。行がある・否定の文・同じ発話に選択肢の行があれば足さない", () => {
  const t = fict(["タイヤ交換4本。"]);
  const cs = enumerateCandidates(t, ledger);
  const item = cs.find((c) => c.kind === "item" && c.text === "タイヤ交換");
  const qty = cs.find((c) => c.kind === "qty" && c.text === "4本");
  assert.ok(item && qty);
  assert.equal(item.ledgerItem, undefined);
  const refs = { candidates: cs, lines: [] as LineRef[], negations: [] };
  const before = structuredClone(refs);
  const out = addAmbiguousLines(refs, t, ledger);
  assert.deepEqual(refs, before);
  assert.equal(out.lines.length, 1);
  assert.equal(out.lines[0].item, item.id);
  assert.equal(out.lines[0].qty, qty.id);
  assert.equal(out.lines[0].status, "done");

  const ref = (over: Partial<LineRef>): LineRef => ({
    item: item.id,
    qty: null,
    unitPrice: null,
    amount: null,
    status: "done",
    evidence: [],
    correctedFrom: null,
    correctedTo: null,
    ...over,
  });
  // モデルが行にした（ID でも、発話の語でも）
  assert.equal(addAmbiguousLines({ candidates: cs, lines: [ref({ qty: qty.id })], negations: [] }, t, ledger).lines.length, 1);
  assert.equal(addAmbiguousLines({ candidates: cs, lines: [ref({ item: { seg: 0, text: "タイヤ交換" } })], negations: [] }, t, ledger).lines.length, 1);
  // 否定の文
  assert.equal(addAmbiguousLines({ candidates: cs, lines: [], negations: [{ seg: 0, text: "タイヤ交換4本。" }] }, t, ledger).lines.length, 0);
  // 同じ発話に選択肢の品目の行（「タイヤ交換、脱着4本」）
  const t2 = fict(["タイヤ交換、脱着4本。"]);
  const cs2 = enumerateCandidates(t2, ledger);
  const d = cs2.find((c) => c.kind === "item" && c.ledgerItem === "タイヤ脱着");
  assert.ok(d);
  assert.equal(addAmbiguousLines({ candidates: cs2, lines: [ref({ item: d.id })], negations: [] }, t2, ledger).lines.length, 1);
  // ほかの行が使った数量は使わない
  const t3 = fict(["タイヤ交換4本、バランスも。"]);
  const cs3 = enumerateCandidates(t3, ledger);
  const b = cs3.find((c) => c.kind === "item" && c.ledgerItem === "ホイールバランス");
  const q3 = cs3.find((c) => c.kind === "qty");
  assert.ok(b && q3);
  const r3 = addAmbiguousLines({ candidates: cs3, lines: [ref({ item: b.id, qty: q3.id })], negations: [] }, t3, ledger);
  assert.equal(r3.lines.length, 2);
  assert.equal(r3.lines[1].qty, null);
});

// --- 作業の通し ---

test("「タイヤ交換4本。」だけ（モデルが 0 行）: 0 行の質問でなく「タイヤ交換は、脱着ですか、組替ですか」。「脱着」で 2200 円、承認で done", async () => {
  const s0 = await startIn(["タイヤ交換4本。"]);
  assert.equal(s0.status, "asking");
  assert.equal(s0.refs?.lines.length, 1, "補った参照を保存する");
  assert.equal(s0.invoice?.lines.length, 1);
  assert.equal(s0.invoice?.lines[0].item, "タイヤ交換");
  assert.equal(s0.invoice?.lines[0].qty, 4);
  assert.equal(s0.invoice?.lines[0].amount, null);
  assert.equal(s0.invoice?.total, null);
  assert.deepEqual(
    s0.questions.map((q) => [q.reason, q.text]),
    [["choice", "タイヤ交換は、組替ですか、脱着ですか"]],
  );
  assert.equal(toMonitorView(s0).say, "タイヤ交換は、組替ですか、脱着ですか");

  const s1 = answer(s0, "脱着");
  assert.deepEqual(s1.answers.at(-1)?.action, { kind: "setItem", item: "タイヤ脱着" });
  assert.equal(s1.invoice?.lines[0].item, "タイヤ脱着");
  assert.equal(s1.invoice?.lines[0].amount, 2200);
  assert.equal(s1.invoice?.confirmations.length, 0);
  assert.equal(toMonitorView(s1).awaitingApproval, true);
  assert.deepEqual(toMonitorView(s1).lines[0].answered, ["脱着"]);
  const done = answer(s1, "請求書頼む");
  assert.equal(done.status, "done");
  assert.equal(done.invoice?.total, 2200);
});

test("言い換えの答えの形: 正式名・別名・前置きと付け足しは読む。どちらでもない・両方・余計な語は unread で聞き直す", async () => {
  const s0 = await startIn(["タイヤ交換4本。"]);
  for (const [t, item] of [
    ["組替です", "タイヤ組替"],
    ["んだ、組み替えだ", "タイヤ組替"],
    ["タイヤ脱着", "タイヤ脱着"],
    ["履き替えだよ", "タイヤ脱着"],
  ] as const) {
    assert.deepEqual(answer(s0, t).answers.at(-1)?.action, { kind: "setItem", item }, t);
  }
  assert.equal(answer(s0, "組替").invoice?.total, 6600);
  for (const t of ["はい", "タイヤ交換", "脱着と組替", "脱着4本", "たぶん脱着", "バランス", "わからない"]) {
    const s = answer(s0, t);
    assert.equal(s.answers.at(-1)?.action.kind, "unread", t);
    assert.deepEqual(s.invoice, s0.invoice, t);
    assert.equal(toMonitorView(s).say, "もう一度お願いします。タイヤ交換は、組替ですか、脱着ですか", t);
  }
});

test("数量の無い「タイヤ交換した。」: 先に品目を聞き、選んだ後に数量を聞く", async () => {
  const s0 = await startIn(["タイヤ交換した。"]);
  assert.equal(s0.questions[0].reason, "choice");
  const s1 = answer(s0, "組替");
  assert.equal(s1.invoice?.lines[0].item, "タイヤ組替");
  assert.deepEqual(
    s1.questions.map((q) => q.text),
    ["タイヤ組替は何本ですか"],
  );
  const s2 = answer(s1, "4本");
  assert.equal(s2.invoice?.total, 6600);
});

test("モデルが言い換えの言葉を行にした場合も同じ質問。料金表にある言葉の作業は変わらない", async () => {
  const withLine: Extractor = async (t, l) => {
    const candidates = enumerateCandidates(t, l);
    const item = candidates.find((c) => c.kind === "item" && c.text === "タイヤ交換");
    const qty = candidates.find((c) => c.kind === "qty");
    return {
      candidates,
      lines: [
        { item: item?.id ?? "", qty: qty?.id ?? null, unitPrice: null, amount: null, status: "done", evidence: [], correctedFrom: null, correctedTo: null },
      ],
      negations: [],
    };
  };
  const s0 = await startIn(["タイヤ交換4本。"], withLine);
  assert.equal(s0.refs?.lines.length, 1, "行を二重に足さない");
  assert.equal(s0.questions[0].text, "タイヤ交換は、組替ですか、脱着ですか");

  const plain = await startIn(["脱着4本。"]);
  assert.equal(plain.invoice?.lines.length, 0, "料金表の言葉はモデルが行にしなければ補わない（条件 15 の質問のまま）");
  assert.ok(plain.questions.every((q) => q.reason !== "choice"));
});

test("Codex 指摘 3: 言い換えの行の数量は同じ文の中だけ。「タイヤ交換した。倉庫にはタイヤ4本ある。」は本数を聞き、「脱着」だけで承認待ちにならない", async () => {
  const t = fict(["タイヤ交換した。倉庫にはタイヤ4本ある。"]);
  const cs = enumerateCandidates(t, ledger);
  const out = addAmbiguousLines({ candidates: cs, lines: [], negations: [] }, t, ledger);
  assert.equal(out.lines.length, 1);
  assert.equal(out.lines[0].qty, null);
  // 同じ文なら読点をまたいでも取る
  const t2 = fict(["タイヤ交換、4本。"]);
  const cs2 = enumerateCandidates(t2, ledger);
  assert.equal(addAmbiguousLines({ candidates: cs2, lines: [], negations: [] }, t2, ledger).lines[0].qty, cs2.find((c) => c.kind === "qty")?.id);

  const s0 = await startIn(["タイヤ交換した。倉庫にはタイヤ4本ある。"]);
  assert.equal(s0.invoice?.lines[0].qty, null);
  const s1 = answer(s0, "脱着");
  assert.equal(s1.invoice?.lines[0].item, "タイヤ脱着");
  assert.equal(toMonitorView(s1).awaitingApproval, false);
  // 別の文の 4本 は使われない数として確かめる（数量は父の答えで入れる）
  assert.equal(s1.invoice?.lines[0].qty, null);
  assert.ok(["qty", "correction"].includes(s1.questions[0].reason), s1.questions[0].text);
  assert.equal(answer(s1, "請求書頼む").status, "asking");
});
