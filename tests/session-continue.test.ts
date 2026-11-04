/**
 * 明細が 0 行の作業への返事を、作業の話の続きとして抽出し直す（lib/session/run.ts の continueSession・replySession）。
 * 素材は架空の発話と架空の料金表。抽出は偽物（API を呼ばない）。data/ は読まない。見るのは自分で作った一時フォルダの中だけ。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { enumerateCandidates } from "../lib/invoice/candidates";
import type { LedgerEntry } from "../lib/ledger/lookup";
import { appendUtterance, type Extractor, isEmptyDraft, replySession, startSession } from "../lib/session/run";
import { readSession, type Session } from "../lib/session/store";
import { toMonitorView } from "../lib/session/view";
import type { Segment, Transcript } from "../lib/stt/types";

const ROOT = resolve(import.meta.dirname, "..");
const ledger = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/tire-ledger.json"), "utf8")) as LedgerEntry[];

const made: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "nda-continue-"));
  made.push(d);
  return d;
}
after(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
});

let clock = 0;
const now = () => new Date(Date.UTC(2026, 10, 5, 10, 0, clock++));
let seq = 0;

/** 偽の抽出: 品目の候補ごとに 1 行、同じ発話の最初の数量を付ける。呼ばれた文字起こしを残す。 */
function fakeExtract(): { extract: Extractor; seen: Transcript[] } {
  const seen: Transcript[] = [];
  const extract: Extractor = async (t, l) => {
    seen.push(structuredClone(t));
    const candidates = enumerateCandidates(t, l);
    const lines = candidates
      .filter((c) => c.kind === "item")
      .map((item) => ({
        item: item.id,
        qty: candidates.find((c) => c.kind === "qty" && c.seg === item.seg)?.id ?? null,
        unitPrice: null,
        amount: null,
        status: "done" as const,
        evidence: [],
        correctedFrom: null,
        correctedTo: null,
      }));
    return { candidates, lines, negations: [] };
  };
  return { extract, seen };
}

const failing: Extractor = async () => {
  throw new TypeError("偽の失敗 sk-秘密");
};

const fict = (texts: string[]): Transcript => ({
  recordingId: `cont-${seq}`,
  vendor: "fictional",
  language: "ja",
  glossaryHint: false,
  segments: texts.map((text, i) => ({ startSec: i * 4, endSec: i * 4 + 3, speaker: "speaker_0", text })),
});
const say = (text: string): Segment => ({ startSec: 0.2, endSec: 1.8, speaker: "speaker_0", text });

async function startEmpty(dir: string, extract: Extractor): Promise<Session> {
  const s = await startSession({ dir, transcript: fict(["えーと、請求書作成して。"]), ledger, extract, now, id: `c${seq++}` });
  assert.equal(s.invoice?.lines.length, 0);
  assert.deepEqual(
    s.questions.map((q) => q.text),
    ["請求する作業はありませんか"],
  );
  assert.ok(isEmptyDraft(s));
  return s;
}

test("0 行 → 返事「脱着4本。」で行ができ、承認待ちになる。done には飛ばさず、承認の言葉で done", async () => {
  const dir = await tmp();
  const { extract, seen } = fakeExtract();
  const s0 = await startEmpty(dir, extract);
  const before = structuredClone(s0);

  const s1 = await replySession({ dir, session: s0, utterance: say("脱着4本。"), ledger, extract, now });
  assert.deepEqual(s0, before, "入力を書き換えない");
  assert.equal(s1.id, s0.id);
  assert.equal(s1.status, "asking");
  assert.deepEqual(
    s1.history.slice(-2).map((h) => h.status),
    ["drafting", "asking"],
  );
  assert.equal(s1.invoice?.lines.length, 1);
  assert.equal(s1.invoice?.lines[0].item, "タイヤ脱着");
  assert.equal(s1.invoice?.lines[0].qty, 4);
  assert.equal(s1.invoice?.confirmations.length, 0);
  assert.equal(s1.approved, false);
  assert.equal(toMonitorView(s1).awaitingApproval, true);

  // 文字起こしの後ろに足し、時刻は元の最後の終了（3 秒）だけずらす。recordingId は元のまま
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1], s1.transcript);
  assert.equal(s1.transcript?.recordingId, s0.transcript?.recordingId);
  assert.deepEqual(s1.transcript?.segments[1], { startSec: 3.2, endSec: 4.8, speaker: "speaker_0", text: "脱着4本。" });

  // 答えの記録: 返事の録音の時刻と言葉、ずらした秒数
  const a = s1.answers.at(-1);
  assert.deepEqual(a?.action, { kind: "continue", offsetSec: 3 });
  assert.equal(a?.lineIndex, -1);
  assert.deepEqual(a?.provenance, { recordingId: `${s0.id}#answer-1`, startSec: 0.2, endSec: 1.8, speaker: "unknown", quote: "脱着4本。" });
  // 行の出所は足した発話を指し、offsetSec を引くと返事の録音の時刻に戻る
  const p = s1.invoice?.lines[0].provenance;
  assert.equal(p?.quote, "脱着4本。");
  assert.ok(Math.abs((p?.startSec ?? 0) - 3 - 0.2) < 1e-9);
  // 画面: 答えた行の欄に continue を出さない
  assert.deepEqual(toMonitorView(s1).lines[0].answered, []);
  assert.deepEqual(await readSession(dir, s0.id), s1);

  const done = await replySession({ dir, session: s1, utterance: say("請求書頼む"), ledger, extract, now });
  assert.equal(done.status, "done");
  assert.equal(done.invoice?.total, 2200);
  assert.equal(seen.length, 2, "承認の言葉では抽出し直さない");
});

test("返事でも 0 行なら、同じ質問のまま。返事は文字起こしに残り、次の返事はその後ろに足す", async () => {
  const dir = await tmp();
  const { extract, seen } = fakeExtract();
  const s0 = await startEmpty(dir, extract);
  const s1 = await replySession({ dir, session: s0, utterance: say("ちょっと待って"), ledger, extract, now });
  assert.equal(s1.status, "asking");
  assert.deepEqual(
    s1.questions.map((q) => q.text),
    ["請求する作業はありませんか"],
  );
  assert.equal(s1.transcript?.segments.length, 2);
  assert.ok(isEmptyDraft(s1));
  // 画面は聞き直しの前置きを付けずに同じ質問を言う（continue は unread でない）
  assert.equal(toMonitorView(s1).say, "請求する作業はありませんか");

  const s2 = await replySession({ dir, session: s1, utterance: say("脱着4本。"), ledger, extract, now });
  assert.equal(s2.invoice?.lines.length, 1);
  assert.deepEqual(
    s2.transcript?.segments.map((x) => [x.startSec, x.text]),
    [
      [0, "えーと、請求書作成して。"],
      [3.2, "ちょっと待って"],
      [5, "脱着4本。"],
    ],
  );
  assert.deepEqual(s2.answers.at(-1)?.action, { kind: "continue", offsetSec: 4.8 });
  assert.equal(s2.answers.at(-1)?.provenance.recordingId, `${s0.id}#answer-2`);
  assert.equal(seen.length, 3);
});

test("0 行の作業に承認の言葉は抽出し直さず、確認事項が残っていると返す", async () => {
  const dir = await tmp();
  const { extract, seen } = fakeExtract();
  const s0 = await startEmpty(dir, extract);
  const s1 = await replySession({ dir, session: s0, utterance: say("請求書頼む"), ledger, extract, now });
  assert.equal(seen.length, 1);
  assert.equal(s1.status, "asking");
  assert.deepEqual(s1.answers.at(-1)?.action, { kind: "unread", reason: "確認事項が残っている" });
  assert.deepEqual(s1.transcript, s0.transcript);
});

test("抽出し直しが失敗したら、文字起こしを戻し、答えを unread（固定の文）にして asking に戻す。投げない", async () => {
  const dir = await tmp();
  const { extract } = fakeExtract();
  const s0 = await startEmpty(dir, extract);
  const s1 = await replySession({ dir, session: s0, utterance: say("脱着4本。"), ledger, extract: failing, now });
  assert.equal(s1.status, "asking");
  assert.deepEqual(s1.transcript, s0.transcript);
  assert.deepEqual(s1.invoice, s0.invoice);
  assert.deepEqual(s1.answers.at(-1)?.action, { kind: "unread", reason: "抽出に失敗しました（TypeError）" });
  assert.ok(!JSON.stringify(s1).includes("秘密"));
  assert.equal(s1.error, null);
  assert.equal(toMonitorView(s1).say, "もう一度お願いします。請求する作業はありませんか");
  assert.deepEqual(await readSession(dir, s0.id), s1);
});

test("行のある作業への返事は従来どおり answerSession（抽出し直さない）", async () => {
  const dir = await tmp();
  const { extract, seen } = fakeExtract();
  const s0 = await startSession({ dir, transcript: fict(["ゴムバルブも替えた。"]), ledger, extract, now, id: `c${seq++}` });
  assert.equal(s0.invoice?.lines.length, 1);
  assert.ok(!isEmptyDraft(s0));
  const s1 = await replySession({ dir, session: s0, utterance: say("4本"), ledger, extract, now });
  assert.equal(seen.length, 1);
  assert.deepEqual(s1.answers.at(-1)?.action, { kind: "setQty", value: 4, unit: "本" });
  assert.deepEqual(s1.transcript, s0.transcript);
  assert.deepEqual(await readSession(dir, s0.id), s1);
});

test("appendUtterance: 発話の無い文字起こしは 0 秒ずらし、入力を書き換えない", () => {
  const t = fict([]);
  const before = structuredClone(t);
  const r = appendUtterance(t, say("脱着4本"));
  assert.equal(r.offsetSec, 0);
  assert.deepEqual(r.transcript.segments, [say("脱着4本")]);
  assert.deepEqual(t, before);
});
