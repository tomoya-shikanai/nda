/**
 * 会話の受け皿（lib/session/talk.ts・run.ts の talkSession）: 読めなかった返事だけを Claude に回し、声の文はコードが作る。
 * 素材は架空の発話・架空の料金表。抽出と Claude は偽物（API を呼ばない）。.env は読まない。見るのは自分で作った一時フォルダだけ。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { enumerateCandidates } from "../lib/invoice/candidates";
import { ledgerEntries, parseLedgerBook } from "../lib/ledger/lookup";
import { getClue } from "../lib/office/clues";
import { BOX_MARKER, folderBox, type OfficeLink } from "../lib/office/link";
import { ASK_WORK, CUSTOMER_QUESTION } from "../lib/session/customer";
import { viewOf } from "../lib/session/routes";
import { type Extractor, replySession, startSession } from "../lib/session/run";
import { readSession } from "../lib/session/store";
import { safeReply, type Talker, type TalkInput, type TalkOutput, talkWithTimeout } from "../lib/session/talk";
import { SAY } from "../lib/session/view";
import { routeVoice } from "../lib/session/voice";
import type { Segment, Transcript } from "../lib/stt/types";

const ROOT = resolve(import.meta.dirname, "..");
const ledger = ledgerEntries(parseLedgerBook(JSON.parse(readFileSync(join(ROOT, "tests/fixtures/tire-ledger.json"), "utf8"))));

const made: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "nda-talk-"));
  made.push(d);
  return d;
}
const savedLog = process.env.NDA_LOG_DIR;
after(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
  if (savedLog === undefined) delete process.env.NDA_LOG_DIR;
  else process.env.NDA_LOG_DIR = savedLog;
});

const fict = (texts: string[]): Transcript => ({
  recordingId: `talk-${randomUUID()}`,
  vendor: "fictional",
  language: "ja",
  glossaryHint: false,
  segments: texts.map((text, i) => ({ startSec: i * 4, endSec: i * 4 + 3, speaker: null, text })),
});
const say = (text: string): Segment => ({ startSec: 0, endSec: 2, speaker: "speaker_0", text });

/** 偽の抽出: 料金表の品目ごとに 1 行、同じ発話の数量。 */
const extractor: Extractor = async (t, l) => {
  const candidates = enumerateCandidates(t, l);
  const lines = candidates
    .filter((c) => c.kind === "item" && c.ledgerItem !== undefined)
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

/** 偽の Claude: 決まった答えを返し、渡された入力を残す。 */
function fakeTalk(out: TalkOutput | (() => Promise<TalkOutput>)): { talk: Talker; seen: TalkInput[] } {
  const seen: TalkInput[] = [];
  const talk: Talker = async (x) => {
    seen.push(structuredClone(x));
    return typeof out === "function" ? out() : out;
  };
  return { talk, seen };
}
/** 呼ばれたら落とす Claude（読める返事は会話の受け皿を通らない）。 */
const never: Talker = async () => {
  throw new Error("会話の受け皿を通った");
};

async function instructionOffice(): Promise<OfficeLink> {
  const box = join(await tmp(), "in");
  await mkdir(box, { recursive: true });
  await writeFile(join(box, BOX_MARKER), "");
  return { box: folderBox(box, { requireMount: false }), timeoutMs: 1000, mode: "instruction", slipKind: "invoice" };
}

test("客の後の「どのお客さん？」→ 受けた言葉をそのまま声に出し、今の質問に戻る。Claude・作業ファイル・記録に名前と 4 桁が無い", async () => {
  const logs = await tmp();
  process.env.NDA_LOG_DIR = logs;
  try {
    const dir = await tmp();
    const office = await instructionOffice();
    const s = await startSession({ dir, transcript: fict(["仮田さん、1111。"]), ledger, extract: extractor, office, id: randomUUID() });
    assert.equal(viewOf(s).say, ASK_WORK);
    const { talk, seen } = fakeTalk({ intent: "ask_customer", reply: "仮田さんです" });
    const s1 = await replySession({ dir, session: s, utterance: say("どのお客さん？"), ledger, extract: extractor, office, talk });
    assert.equal(s1.status, "asking");
    assert.deepEqual(s1.answers.at(-1)?.action, { kind: "talk", intent: "ask_customer" });
    assert.equal(s1.answers.at(-1)?.provenance.quote, "", "talk の答えに文を残さない");
    assert.equal(viewOf(s1).say, `${getClue(s.id)?.customerWords}、ナンバー1111 として受けました。${ASK_WORK}`);
    assert.ok(viewOf(s1).say.startsWith("仮田さん"));
    assert.notEqual(viewOf(s1).sayId, viewOf(s).sayId);

    assert.equal(seen.length, 1);
    const passed = JSON.stringify(seen);
    assert.ok(!passed.includes("仮田") && !passed.includes("1111"), passed);
    assert.equal(seen[0].state.customerReceived, true);
    const file = await readFile(join(dir, `${s.id}.json`), "utf8");
    assert.ok(!file.includes("仮田") && !file.includes("1111"));
    const events = (await Promise.all((await readdir(logs)).map((n) => readFile(join(logs, n), "utf8")))).join("");
    assert.ok(!events.includes("仮田") && !events.includes("1111"));
    const talkEvents = events
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => e.kind === "talk");
    assert.equal(talkEvents.length, 1);
    assert.deepEqual(Object.keys(talkEvents[0]).sort(), ["error", "intent", "kind", "ms", "ok", "sessionId", "t"]);
    assert.equal(talkEvents[0].intent, "ask_customer");
    assert.equal(talkEvents[0].ok, true);
  } finally {
    delete process.env.NDA_LOG_DIR;
  }
});

test("客を聞く前の「どのお客さん？」→「まだお客様を聞いていません」と客の質問", async () => {
  const dir = await tmp();
  const office = await instructionOffice();
  const s = await startSession({ dir, transcript: fict(["脱着4本。"]), ledger, extract: extractor, office });
  assert.equal(s.questions[0].text, CUSTOMER_QUESTION);
  const { talk } = fakeTalk({ intent: "ask_customer", reply: "" });
  const s1 = await replySession({ dir, session: s, utterance: say("どのお客さん？"), ledger, extract: extractor, office, talk });
  assert.equal(viewOf(s1).say, `まだお客様を聞いていません。${CUSTOMER_QUESTION}`);
});

test("「今いくら？」→ 合計、「何入ってる？」→ 明細。数は明細から（Claude の文は使わない）", async () => {
  const dir = await tmp();
  const s = await startSession({ dir, transcript: fict(["脱着4本。"]), ledger, extract: extractor });
  assert.equal(viewOf(s).awaitingApproval, true);
  const total = fakeTalk({ intent: "ask_total", reply: "9999円です" });
  const s1 = await replySession({ dir, session: s, utterance: say("今いくら？"), ledger, extract: extractor, talk: total.talk });
  assert.equal(viewOf(s1).say, `合計 2,200円です。${SAY.askApprove}`);
  assert.equal(s1.invoice?.total, 2200, "明細は変わらない");
  assert.equal(total.seen[0].state.total, 2200);
  const lines = fakeTalk({ intent: "ask_lines", reply: "" });
  const s2 = await replySession({ dir, session: s1, utterance: say("何入ってる？"), ledger, extract: extractor, talk: lines.talk });
  assert.equal(viewOf(s2).say, `タイヤ脱着 4本、合計 2,200円です。${SAY.askApprove}`);
  const next = fakeTalk({ intent: "ask_next", reply: "" });
  const s3 = await replySession({ dir, session: s2, utterance: say("何て？"), ledger, extract: extractor, talk: next.talk });
  assert.equal(viewOf(s3).say, SAY.askApprove);
  // 承認は今までどおりコードだけ
  const done = await replySession({ dir, session: s3, utterance: say("請求書頼む"), ledger, extract: extractor, talk: never });
  assert.equal(done.status, "done");
});

test("「やめる」→ 作業を閉じる（idle）。確定・送信はしない。次の声は新しい作業。やめる語が無ければ閉じない", async () => {
  const dir = await tmp();
  const office = await instructionOffice();
  const s = await startSession({ dir, transcript: fict(["仮田さん、1111。脱着4本。"]), ledger, extract: extractor, office });
  assert.ok(getClue(s.id) !== null);

  const notCue = fakeTalk({ intent: "cancel", reply: "わかりました" });
  const k = await replySession({ dir, session: s, utterance: say("うーん"), ledger, extract: extractor, office, talk: notCue.talk });
  assert.equal(k.status, "asking", "やめる語が無ければ閉じない");
  assert.deepEqual(k.answers.at(-1)?.action, { kind: "talk", intent: "other" });

  const { talk } = fakeTalk({ intent: "cancel", reply: "" });
  const c = await replySession({ dir, session: k, utterance: say("やっぱりやめる"), ledger, extract: extractor, office, talk });
  assert.equal(c.status, "idle");
  assert.equal(c.approved, false);
  assert.equal(c.office, null);
  assert.equal(getClue(s.id), null, "手がかりも消す");
  assert.equal(viewOf(c).say, SAY.cancelled);
  assert.equal((await readSession(dir, s.id))?.status, "idle");
  assert.deepEqual(routeVoice(c), { kind: "new" });
});

test("other: Claude の文を使う。4 桁以上の数・長すぎる文は捨てて「すみません、もう一度お願いします」", async () => {
  const dir = await tmp();
  const s = await startSession({ dir, transcript: fict(["脱着4本。"]), ledger, extract: extractor });
  const ok = fakeTalk({ intent: "other", reply: "お疲れさまなのです" });
  const s1 = await replySession({ dir, session: s, utterance: say("疲れたな"), ledger, extract: extractor, talk: ok.talk });
  assert.equal(viewOf(s1).say, `お疲れさまなのです。${SAY.askApprove}`);
  const bad = fakeTalk({ intent: "other", reply: "合計は2,200円なのです" });
  const s2 = await replySession({ dir, session: s1, utterance: say("疲れたな"), ledger, extract: extractor, talk: bad.talk });
  assert.equal(viewOf(s2).say, `すみません、もう一度お願いします。${SAY.askApprove}`);
  assert.equal(safeReply("１２３４なのです"), null);
  assert.equal(safeReply("あ".repeat(61)), null);
  assert.equal(safeReply("4本なのです"), "4本なのです");
});

test("Claude が落ちる・期限切れ → 今の「もう一度お願いします。…」（読めない理由は残る）", async () => {
  const dir = await tmp();
  const s = await startSession({ dir, transcript: fict(["ゴムバルブも替えた。"]), ledger, extract: extractor });
  const q = s.questions[0].text;
  const failing = fakeTalk(async () => {
    throw new TypeError("偽の失敗");
  });
  const s1 = await replySession({ dir, session: s, utterance: say("どうだったかな"), ledger, extract: extractor, talk: failing.talk });
  assert.equal(failing.seen.length, 1);
  assert.equal(s1.answers.at(-1)?.action.kind, "unread");
  assert.equal(viewOf(s1).say, SAY.retry(q));
  const slow: Talker = () => new Promise((r) => setTimeout(() => r({ intent: "ask_next", reply: "" }), 200));
  await assert.rejects(talkWithTimeout(slow, { utterance: "x", state: failing.seen[0].state }, 20), { name: "TimeoutError" });
  // Claude の出力が形に合わなければ落ちたのと同じ
  const broken = fakeTalk({ intent: "dance", reply: "" } as unknown as TalkOutput);
  const s2 = await replySession({ dir, session: s1, utterance: say("どうだったかな"), ledger, extract: extractor, talk: broken.talk });
  assert.equal(s2.answers.at(-1)?.action.kind, "unread");
});

test("読める返事（4本・脱着4本・請求書頼む・客の返事）は会話の受け皿を通らない", async () => {
  const dir = await tmp();
  const s = await startSession({ dir, transcript: fict(["ゴムバルブも替えた。"]), ledger, extract: extractor });
  const s1 = await replySession({ dir, session: s, utterance: say("4本"), ledger, extract: extractor, talk: never });
  assert.equal(s1.answers.at(-1)?.action.kind, "setQty");
  const s2 = await replySession({ dir, session: s1, utterance: say("請求書頼む"), ledger, extract: extractor, talk: never });
  assert.equal(s2.status, "done");

  const office = await instructionOffice();
  const e = await startSession({ dir, transcript: fict(["えーと。"]), ledger, extract: extractor, office });
  const e1 = await replySession({ dir, session: e, utterance: say("仮田さん、1111。"), ledger, extract: extractor, office, talk: never });
  assert.equal(e1.answers.at(-1)?.action.kind, "customerClue");
  const e2 = await replySession({ dir, session: e1, utterance: say("脱着4本。"), ledger, extract: extractor, office, talk: never });
  assert.equal(e2.invoice?.lines.length, 1);
  // 確認事項が残っているのに承認の言葉 → 今までどおり「まだ確かめたいことがあります」
  const v = await startSession({ dir, transcript: fict(["ゴムバルブも替えた。"]), ledger, extract: extractor });
  const v1 = await replySession({ dir, session: v, utterance: say("請求書頼む"), ledger, extract: extractor, talk: never });
  assert.equal(viewOf(v1).say, SAY.notYet(v.questions[0].text));
});
