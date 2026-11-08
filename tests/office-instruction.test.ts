/**
 * 声の指示の道（#56、NDA_OFFICE_MODE=instruction）: 形、返事の 4 桁を手がかりとして受ける、承認後に受け箱へ 1 件置く、
 * 作業ファイル・出来事の記録に手がかりが残らない、再起動で手がかりが無いと送らない、二重承認で 1 件だけ、偽の事務所は done/ に移すだけ。
 * 素材は架空の発話・架空の料金表。抽出は偽物（API を呼ばない）。.env は読まない。見るのは自分で作った一時フォルダだけ。
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
import { clearClues, getClue } from "../lib/office/clues";
import { processBox } from "../lib/office/fake";
import { customerClue, RESEND_EVERY_SEC, workText } from "../lib/office/flow";
import { BOX_MARKER, type BoxWriter, folderBox, type OfficeLink, officeFromEnv, tickOffice } from "../lib/office/link";
import { EstimateInstruction, ToOffice } from "../lib/office/schema";
import { CUSTOMER_QUESTION } from "../lib/session/customer";
import { type Extractor, replySession, startSession } from "../lib/session/run";
import { readSession } from "../lib/session/store";
import { SAY, toMonitorView } from "../lib/session/view";
import type { Segment, Transcript } from "../lib/stt/types";

const ROOT = resolve(import.meta.dirname, "..");
const ledger = ledgerEntries(parseLedgerBook(JSON.parse(readFileSync(join(ROOT, "tests/fixtures/tire-ledger.json"), "utf8"))));

const made: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "nda-instr-"));
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
  recordingId: `instr-${randomUUID()}`,
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

const NOMOUNT = { requireMount: false };

async function env(box?: BoxWriter) {
  const dir = await tmp();
  const boxDir = join(await tmp(), "in");
  await mkdir(boxDir, { recursive: true });
  await writeFile(join(boxDir, BOX_MARKER), "");
  const office: OfficeLink = { box: box ?? folderBox(boxDir, NOMOUNT), timeoutMs: 1000, mode: "instruction", slipKind: "invoice" };
  return { dir, box: boxDir, office };
}

const boxFiles = async (box: string) => (await readdir(box).catch(() => [] as string[])).filter((n) => n.endsWith(".json"));
const readBox = async (box: string) =>
  Promise.all((await boxFiles(box)).map(async (n) => ToOffice.parse(JSON.parse(await readFile(join(box, n), "utf8")))));

/** 作業の話（4 桁なし）で始めて、客の質問で止まった作業。 */
async function asking(e: Awaited<ReturnType<typeof env>>) {
  const s = await startSession({ dir: e.dir, transcript: fict(["脱着4本。"]), ledger, extract: extractor, office: e.office, id: randomUUID() });
  assert.equal(s.status, "asking");
  assert.equal(s.questions[0]?.text, CUSTOMER_QUESTION);
  return s;
}

test("形: estimate.instruction は番号を持たず、作業の文は改行なし・2000 字まで。手がかりは 4 桁がちょうど 1 つの時だけ", () => {
  const m = {
    v: 1,
    id: randomUUID(),
    sessionId: "s1",
    sentAt: new Date().toISOString(),
    kind: "estimate.instruction",
    attempt: 1,
    approvedAt: new Date().toISOString(),
    approval: "請求書頼む",
    vehicle: { plateNo: "1111", customerWords: "仮田さん" },
    slipKind: "invoice",
    work: "タイヤ脱着 4本 550円、エアバルブ交換 4本 330円",
  };
  assert.deepEqual(EstimateInstruction.parse(m), m);
  assert.equal(ToOffice.parse(m).kind, "estimate.instruction");
  assert.equal(EstimateInstruction.safeParse({ ...m, work: "a\nb" }).success, false, "改行は通さない");
  assert.equal(EstimateInstruction.safeParse({ ...m, work: "あ".repeat(2001) }).success, false);
  assert.equal(EstimateInstruction.safeParse({ ...m, vehicle: { plateNo: "111" } }).success, false);
  assert.equal(EstimateInstruction.safeParse({ ...m, slipKind: "order" }).success, false);
  assert.equal(EstimateInstruction.safeParse({ ...m, approval: "頼む" }).success, false, "承認の言葉は固定の文字列");
  assert.equal(EstimateInstruction.safeParse({ ...m, vehicle: { plateNo: "1111" } }).success, true, "customerWords は無くてよい");

  assert.deepEqual(customerClue(["仮田さんです。１１１１。"]), { plateNo: "1111", customerWords: "仮田さんです" });
  assert.deepEqual(customerClue(["一一一一。"]), { plateNo: "1111" }, "言葉が残らなければ customerWords は入れない");
  assert.equal(customerClue(["1111か2222です。"]), null, "4 桁が 2 つは決めない");
  assert.equal(customerClue(["脱着4本、1650円。"]), null);
  assert.equal(
    workText([
      { item: "タイヤ脱着", qty: 4, unit: "本", unitPrice: 550 },
      { item: "エアバルブ交換", qty: 4, unit: "本", unitPrice: null },
    ]),
    "タイヤ脱着 4本 550円、エアバルブ交換 4本",
  );
});

test("返事の 4 桁で客を受け、承認したら受け箱に声の指示を 1 件置いて sent。作業ファイル・出来事の記録に手がかりが残らない", async () => {
  const logs = await tmp();
  process.env.NDA_LOG_DIR = logs;
  try {
    const e = await env();
    const s = await asking(e);
    assert.equal(toMonitorView(s).customer, "お客様: 未指定");

    const s1 = await replySession({ dir: e.dir, session: s, utterance: say("仮田さんです。1111です。"), ledger, office: e.office });
    assert.equal(s1.status, "asking");
    assert.deepEqual(s1.answers.at(-1)?.action, { kind: "customerClue" });
    assert.equal(toMonitorView(s1).customer, "お客様: 受けました（事務所で確かめます）");
    assert.equal(toMonitorView(s1).awaitingApproval, true);
    assert.deepEqual(await boxFiles(e.box), [], "照合の問い合わせを置かない");

    const done = await replySession({ dir: e.dir, session: s1, utterance: say("請求書頼む"), ledger, office: e.office });
    assert.equal(done.status, "sent");
    assert.deepEqual(
      done.history.slice(-3).map((h) => h.status),
      ["done", "sending", "sent"],
    );
    assert.equal(toMonitorView(done).say, SAY.sentInstruction);
    const msgs = await readBox(e.box);
    assert.equal(msgs.length, 1);
    const [m] = msgs;
    assert.equal(m.kind, "estimate.instruction");
    if (m.kind !== "estimate.instruction") return;
    assert.equal(m.id, done.office?.requestId);
    assert.equal(m.sessionId, s.id);
    assert.equal(m.attempt, 1);
    assert.equal(m.approval, "請求書頼む");
    assert.equal(m.approvedAt, done.approvedAt);
    assert.equal(m.slipKind, "invoice");
    assert.deepEqual(m.vehicle, { plateNo: "1111", customerWords: "仮田さんです、です" });
    assert.equal(m.work, "タイヤ脱着 4本 550円");
    assert.ok(!("customer" in m), "番号を持たない");
    assert.equal(getClue(s.id), null, "送ったら手がかりを持たない");

    const file = await readFile(join(e.dir, `${s.id}.json`), "utf8");
    // id（uuid）に 4 桁が偶然出ることがあるので、値としての 4 桁と原文の形で見る
    const leaks = (x: string) => x.includes('"1111"') || x.includes("1111です") || x.includes("plateNo") || x.includes("仮田");
    assert.ok(!leaks(file), "作業ファイルに手がかりが無い");
    const logText = (await Promise.all((await readdir(logs)).map((n) => readFile(join(logs, n), "utf8")))).join("");
    assert.ok(logText.includes("\"message\":\"estimate.instruction\""), "置いたことは記録する");
    assert.ok(!logText.includes("log.invalid"));
    assert.ok(!leaks(logText), "出来事の記録に手がかりが無い");

    // 偽の事務所は done/ に移すだけで返さない（状態は sent のまま）
    const posted: unknown[] = [];
    assert.equal(await processBox({ box: e.box, customers: [], post: async (x) => void posted.push(x) }), 1);
    assert.deepEqual(posted, []);
    assert.deepEqual(await boxFiles(e.box), []);
    assert.equal((await boxFiles(join(e.box, "..", "done"))).length, 1);
    assert.equal((await readSession(e.dir, s.id))?.status, "sent");
  } finally {
    delete process.env.NDA_LOG_DIR;
  }
});

test("話に 4 桁があれば、客を聞かずに手がかりを受ける（伏せ字は効く）。見積は NDA_OFFICE_SLIP_KIND", async () => {
  const e = await env();
  const office = { ...e.office, slipKind: "estimate" as const };
  const s = await startSession({
    dir: e.dir,
    transcript: fict(["脱着4本。お願いします。えっと。仮田さんの1111。"]),
    ledger,
    extract: extractor,
    office,
    id: randomUUID(),
  });
  assert.equal(toMonitorView(s).awaitingApproval, true);
  assert.ok(!JSON.stringify(s).includes("の1111") && !JSON.stringify(s).includes("仮田"), "作業には伏せ字の後の文だけ");
  await replySession({ dir: e.dir, session: s, utterance: say("請求書頼む"), ledger, office });
  const [m] = await readBox(e.box);
  assert.equal(m.kind === "estimate.instruction" && m.slipKind, "estimate");
  assert.equal(m.kind === "estimate.instruction" && m.vehicle.plateNo, "1111");

  const fromEnv = (x: Record<string, string>) => officeFromEnv({ NDA_OFFICE_BOX: e.box, ...x } as unknown as NodeJS.ProcessEnv);
  assert.deepEqual([fromEnv({})?.mode, fromEnv({})?.slipKind], ["instruction", "invoice"], "既定は声の指示・請求書");
  assert.equal(fromEnv({ NDA_OFFICE_MODE: "query" })?.mode, "query");
  assert.equal(fromEnv({ NDA_OFFICE_SLIP_KIND: "estimate" })?.slipKind, "estimate");
});

test("再起動で手がかりが消えたら送らない: 承認の前なら客の質問に戻し、送り直しの時なら stopped・noClue", async () => {
  // 承認の前に消えた
  const e = await env();
  const s = await asking(e);
  const s1 = await replySession({ dir: e.dir, session: s, utterance: say("仮田さんの1111。"), ledger, office: e.office });
  clearClues();
  const s2 = await replySession({ dir: e.dir, session: s1, utterance: say("請求書頼む"), ledger, office: e.office });
  assert.equal(s2.status, "asking");
  assert.equal(s2.approved, false);
  assert.equal(s2.customerClueAt, null);
  assert.equal(s2.questions[0]?.text, CUSTOMER_QUESTION);
  assert.equal(toMonitorView(s2).say, SAY.retry(CUSTOMER_QUESTION));
  assert.deepEqual(await boxFiles(e.box), []);
  // もう一度言えば送れる
  const s3 = await replySession({ dir: e.dir, session: s2, utterance: say("仮田さんの1111。"), ledger, office: e.office });
  const s4 = await replySession({ dir: e.dir, session: s3, utterance: say("請求書頼む"), ledger, office: e.office });
  assert.equal(s4.status, "sent");
  assert.equal((await boxFiles(e.box)).length, 1);

  // 置けずに送り直しを待つ間に消えた
  let fail = true;
  const real = folderBox(e.box, NOMOUNT);
  const flaky: BoxWriter = { kind: "flaky", put: (n, b) => (fail ? Promise.reject(new Error("x")) : real.put(n, b)) };
  const f = await env(flaky);
  const t = await asking(f);
  const t1 = await replySession({ dir: f.dir, session: t, utterance: say("仮田さんの2222。"), ledger, office: f.office });
  const t2 = await replySession({ dir: f.dir, session: t1, utterance: say("請求書頼む"), ledger, office: f.office });
  assert.equal(t2.status, "sending");
  assert.ok(t2.office?.lastError);
  clearClues();
  fail = false;
  const later = new Date(Date.now() + (RESEND_EVERY_SEC + 1) * 1000);
  const t3 = await tickOffice(f.dir, f.office, t2, later);
  assert.equal(t3.status, "stopped");
  assert.equal(t3.office?.result?.reason, "noClue");
  assert.equal(toMonitorView(t3).office, "止まった: お客様の手がかりが無い");
  assert.match(toMonitorView(t3).say, /ナンバーの下4桁をもう一度/);
  assert.equal((await boxFiles(e.box)).length, 1, "送り直しで置かない（前の 1 件だけ）");
});

test("同時 2 本の承認でも声の指示は 1 件だけ", async () => {
  const e = await env();
  const s = await asking(e);
  const s1 = await replySession({ dir: e.dir, session: s, utterance: say("仮田さんの1111。"), ledger, office: e.office });
  const approve = () => replySession({ dir: e.dir, session: s1, utterance: say("請求書頼む"), ledger, office: e.office });
  const r = await Promise.allSettled([approve(), approve()]);
  assert.equal(r.filter((x) => x.status === "fulfilled").length >= 1, true);
  const msgs = await readBox(e.box);
  assert.equal(msgs.length, 1);
  const end = await readSession(e.dir, s.id);
  assert.equal(end?.status, "sent");
  assert.equal(end?.answers.filter((x) => x.action.kind === "approve").length, 1);
});
