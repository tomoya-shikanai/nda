/**
 * 数を確かめる質問（「タイヤ脱着は4本で合っていますか」）への肯定の返事（lib/session/answer.ts の correction）。
 * 素材は架空の発話・架空の料金表。抽出は偽物（API を呼ばない）。見るのは自分で作った一時フォルダだけ。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { enumerateCandidates } from "../lib/invoice/candidates";
import { ledgerEntries, parseLedgerBook } from "../lib/ledger/lookup";
import { answerSession } from "../lib/session/answer";
import { type Extractor, startSession } from "../lib/session/run";
import type { Segment, Transcript } from "../lib/stt/types";

const ROOT = resolve(import.meta.dirname, "..");
const ledger = ledgerEntries(parseLedgerBook(JSON.parse(readFileSync(join(ROOT, "tests/fixtures/tire-ledger.json"), "utf8"))));
const made: string[] = [];
after(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
});

const T: Transcript = {
  recordingId: "confirm-qty",
  vendor: "fictional",
  language: "ja",
  glossaryHint: false,
  segments: [{ startSec: 0, endSec: 3, speaker: null, text: "タイヤ脱着4本。" }],
};
/** 偽の抽出: 脱着の行を「確かでない」にして、数を確かめる質問を作る。 */
const extract: Extractor = async (t, l) => {
  const candidates = enumerateCandidates(t, l);
  const item = candidates.find((c) => c.kind === "item");
  const qty = candidates.find((c) => c.kind === "qty");
  if (!item || !qty) throw new Error("候補が無い");
  return {
    candidates,
    lines: [{ item: item.id, qty: qty.id, unitPrice: null, amount: null, status: "corrected", evidence: [qty.id], correctedFrom: qty.id, correctedTo: qty.id }],
    negations: [],
  };
};
const say = (text: string): Segment => ({ startSec: 0, endSec: 2, speaker: "speaker_0", text });
const now = () => new Date(Date.UTC(2026, 10, 8, 9));

async function asking() {
  const dir = await mkdtemp(join(tmpdir(), "nda-confirm-"));
  made.push(dir);
  const s = await startSession({ dir, transcript: T, ledger, extract, now });
  assert.equal(s.questions[0]?.text, "タイヤ脱着は4本で合っていますか");
  assert.equal(s.questions[0]?.reason, "correction");
  return s;
}

test("「合ってます。」「合っています。」「四本で合ってます。」「タイヤ脱着は四本で合ってます。」で質問が消えて先に進む", async () => {
  const s = await asking();
  for (const text of ["合ってます。", "合っています。", "四本で合ってます。", "タイヤ脱着は四本で合ってます。", "はい、合ってるよ", "んだ", "4本で合ってるね"]) {
    const next = answerSession(s, say(text), ledger, now());
    assert.deepEqual(next.answers.at(-1)?.action, { kind: "setQty", value: 4, unit: "本" }, text);
    assert.ok(!next.questions.some((q) => q.reason === "correction"), text);
    assert.equal(next.invoice?.total, 2200, text);
  }
});

test("確かめる数と違う数で「2本で合ってます」ならその数。否定・余計な語では進まない", async () => {
  const s = await asking();
  assert.deepEqual(answerSession(s, say("2本で合ってます"), ledger, now()).answers.at(-1)?.action, { kind: "setQty", value: 2, unit: "本" });
  for (const text of ["違います", "ちがう", "いや", "バランスは4本で合ってます", "4本で合ってるけど"]) {
    const next = answerSession(s, say(text), ledger, now());
    assert.equal(next.answers.at(-1)?.action.kind, "unread", text);
    assert.equal(next.questions[0]?.text, "タイヤ脱着は4本で合っていますか", text);
  }
});
