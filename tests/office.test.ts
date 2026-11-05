/**
 * 工場と事務所の約束事（#25、docs/design/pi-office.md）: 型、返しの受け口（401・503・二重の id）、照合の期限、
 * 照合と抽出の並び（照合が先に返る・後に返る）、said を作業ファイルに残さない、承認の後の状態、偽の事務所での一周。
 * 素材は架空の発話・架空の料金表・架空の客の一覧。抽出は偽物（API を呼ばない）。.env は読まない。見るのは自分で作った一時フォルダだけ。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { CustomerList } from "../lib/customer/match";
import { enumerateCandidates } from "../lib/invoice/candidates";
import { ledgerEntries, parseLedgerBook } from "../lib/ledger/lookup";
import { answerQuery, answerRequest, processBox } from "../lib/office/fake";
import { applyToFactory, buildCustomerQuery, expireQuery, QUERY_TIMEOUT_SEC, RESEND_EVERY_SEC } from "../lib/office/flow";
import { clearLabels, getLabel } from "../lib/office/labels";
import { BOX_MARKER, BoxMissingError, type BoxWriter, folderBox, requireMountFromEnv, type OfficeLink, officeFromEnv, submitInvoice, tickOffice } from "../lib/office/link";
import { handleOfficeReply, tokenMatches } from "../lib/office/reply";
import {
  CustomerAnswer,
  CustomerQuery,
  InvoiceRequest,
  InvoiceResult,
  SCHEMAS,
  type ToFactory,
  ToFactory as ToFactorySchema,
  ToOffice,
} from "../lib/office/schema";
import { CUSTOMER_QUESTION } from "../lib/session/customer";
import { type Extractor, replySession, startSession } from "../lib/session/run";
import { readSession, type Session, transition, writeSession } from "../lib/session/store";
import { SAY, toMonitorView } from "../lib/session/view";
import type { Segment, Transcript } from "../lib/stt/types";
import { officeJsonSchemas } from "../scripts/office-schema";

const ROOT = resolve(import.meta.dirname, "..");
const ledger = ledgerEntries(parseLedgerBook(JSON.parse(readFileSync(join(ROOT, "tests/fixtures/tire-ledger.json"), "utf8"))));
const customers = CustomerList.parse(JSON.parse(readFileSync(join(ROOT, "tests/fixtures/customers.json"), "utf8")));
const TOKEN = "test-token-office-0123";

const made: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "nda-office-"));
  made.push(d);
  return d;
}
const saved = { t: process.env.NDA_OFFICE_TOKEN, d: process.env.NDA_SESSION_DIR };
before(() => {
  process.env.NDA_OFFICE_TOKEN = TOKEN;
});
after(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
  if (saved.t === undefined) delete process.env.NDA_OFFICE_TOKEN;
  else process.env.NDA_OFFICE_TOKEN = saved.t;
  if (saved.d === undefined) delete process.env.NDA_SESSION_DIR;
  else process.env.NDA_SESSION_DIR = saved.d;
});

let seq = 0;
const fict = (texts: string[]): Transcript => ({
  recordingId: `off-${seq}`,
  vendor: "fictional",
  language: "ja",
  glossaryHint: false,
  segments: texts.map((text, i) => ({ startSec: i * 4, endSec: i * 4 + 3, speaker: null, text })),
});
const say = (text: string): Segment => ({ startSec: 0, endSec: 2, speaker: "speaker_0", text });

/** 偽の抽出: 料金表の品目ごとに 1 行、同じ発話の数量。before を await してから返す（照合と並べる試験のため）。 */
function extractor(before?: () => Promise<void>): Extractor {
  return async (t, l) => {
    if (before) await before();
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
}

/** 事務所の返しを、工場の受け口（handleOfficeReply）に直接渡す。 */
async function reply(m: ToFactory, token: string | null = TOKEN): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return handleOfficeReply(new Request("http://localhost/api/office/reply", { method: "POST", headers, body: JSON.stringify(m) }));
}
const post = async (m: ToFactory) => {
  const r = await reply(m);
  assert.equal(r.status, 200, await r.clone().text());
};

async function env() {
  const dir = await tmp();
  const box = join(await tmp(), "in");
  // 事務所側が受け箱と目印を置く（§9-4。工場は作らない）
  await mkdir(box, { recursive: true });
  await writeFile(join(box, BOX_MARKER), "");
  process.env.NDA_SESSION_DIR = dir;
  const office: OfficeLink = { box: folderBox(box, NOMOUNT), timeoutMs: 1000 };
  return { dir, box, office };
}

const boxFiles = async (box: string) => (await readdir(box).catch(() => [] as string[])).filter((n) => n.endsWith(".json"));
const readBox = async (box: string) =>
  Promise.all((await boxFiles(box)).map(async (n) => ToOffice.parse(JSON.parse(await readFile(join(box, n), "utf8")))));

const answer = (q: { id: string; sessionId: string }, result: CustomerAnswer["result"]): CustomerAnswer => ({
  v: 1,
  id: randomUUID(),
  sessionId: q.sessionId,
  sentAt: new Date().toISOString(),
  kind: "customer.answer",
  queryId: q.id,
  result,
});
/** 作業の話の後に、2 文あけて客を言う（ナンバーの文と前後の文は伏せるので、作業の文を離す）。 */
const TALK = "脱着4本。お願いします。えっと。仮田さんの1111。";
/** 試験の一時フォルダは mount した先でないので、mount の確かめを外す（本番の既定は確かめる）。 */
const NOMOUNT = { requireMount: false };
const FOUND = { status: "found" as const, customerNo: "cust-001", carNo: "car-cust-001", label: "仮田 様・架空の軽トラ" };

// --- 型 ---

test("型: 4 種と封筒は zod が正。往復で変わらず、形の違うものは通さない。JSON Schema を書き出せる", () => {
  const q = buildCustomerQuery({
    id: randomUUID(),
    sessionId: "s1",
    texts: ["仮田さんの1111。脱着4本。"],
    from: { recordingId: "r", startSec: 0, endSec: 3 },
    now: new Date(),
  });
  assert.ok(q);
  assert.deepEqual(CustomerQuery.parse(JSON.parse(JSON.stringify(q))), q);
  assert.deepEqual(q.said, ["仮田さんの1111"], "4 桁を含む文と直前の文だけ（ここは直前が無い）");
  assert.deepEqual(q.plate4, ["1111"]);
  const a = answer(q, FOUND);
  assert.deepEqual(CustomerAnswer.parse(a), a);
  assert.deepEqual(ToFactorySchema.parse(answer(q, { status: "retry", reason: "many" })).kind, "customer.answer");
  assert.equal(CustomerAnswer.safeParse({ ...a, result: { status: "found", customerNo: "x", carNo: "y" } }).success, false, "label は必須（null 可）");
  assert.equal(CustomerQuery.safeParse({ ...q, v: 2 }).success, false);
  assert.equal(CustomerQuery.safeParse({ ...q, id: "x" }).success, false);
  assert.equal(CustomerQuery.safeParse({ ...q, plate4: ["111"] }).success, false);
  assert.equal(CustomerQuery.safeParse({ ...q, sessionId: "../x" }).success, false);
  assert.equal(InvoiceRequest.safeParse({ kind: "invoice.request" }).success, false);
  assert.equal(InvoiceResult.safeParse({ kind: "invoice.result" }).success, false);
  assert.equal(buildCustomerQuery({ id: randomUUID(), sessionId: "s", texts: ["脱着4本、1650円。"], from: q.from, now: new Date() }), null);

  const js = officeJsonSchemas();
  assert.deepEqual(Object.keys(js).sort(), Object.keys(SCHEMAS).sort());
  const ans = js["customer.answer"] as { properties: Record<string, unknown> };
  assert.ok(ans.properties.queryId && ans.properties.result);
});

// --- 受け口 ---

test("受け口: 合言葉が未設定なら 503、無い・違えば 401、形の違いは 400、作業が無ければ 404。比べ方は長さが違っても同じ", async () => {
  await env();
  const m = answer({ id: randomUUID(), sessionId: "none" }, FOUND);
  delete process.env.NDA_OFFICE_TOKEN;
  assert.equal((await reply(m)).status, 503);
  process.env.NDA_OFFICE_TOKEN = TOKEN;
  assert.equal((await reply(m, null)).status, 401);
  assert.equal((await reply(m, "wrong")).status, 401);
  assert.equal((await reply(m, `${TOKEN}x`)).status, 401);
  const bad = await handleOfficeReply(
    new Request("http://localhost/x", { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: "{" }),
  );
  assert.equal(bad.status, 400);
  assert.equal((await reply({ ...m, kind: "customer.query" } as unknown as ToFactory)).status, 400);
  assert.equal((await reply(m)).status, 404);
  assert.equal(tokenMatches(`Bearer ${TOKEN}`, TOKEN), true);
  assert.equal(tokenMatches(TOKEN, TOKEN), false, "Bearer が無い");
  assert.equal(tokenMatches(null, TOKEN), false);
});

// --- 照合と抽出の並び ---

test("照合は抽出を待たずに置く。抽出より先に答えが返っても、抽出の後に書く作業が客を消さない", async () => {
  const { dir, box, office } = await env();
  const id = `p${seq++}`;
  // 抽出の途中で、事務所（偽物）が受け箱の問い合わせに答える
  const extract = extractor(async () => {
    // 問い合わせは抽出と並んで置かれる（抽出の終わりを待たない）
    for (let i = 0; i < 50 && (await boxFiles(box)).length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    const qs = await readBox(box);
    assert.equal(qs.length, 1, "抽出の途中で問い合わせが置かれている");
    const s = await readSession(dir, id);
    assert.equal(s?.status, "thinking");
    await processBox({ box, customers, post });
    assert.deepEqual((await readSession(dir, id))?.customer, { customerNo: "cust-001", carNo: "car-cust-001" });
  });
  const s = await startSession({ dir, transcript: fict([TALK]), ledger, extract, office, id });
  assert.deepEqual(s.customer, { customerNo: "cust-001", carNo: "car-cust-001" });
  assert.equal(s.customerQuery?.status, "answered");
  assert.deepEqual(s.questions, [], "客の質問は消えている");
  const v = toMonitorView(s, getLabel(s.id));
  assert.equal(v.awaitingApproval, true);
  assert.equal(v.customer, "お客様: 仮田 様・架空の軽トラ");
  assert.equal(toMonitorView(s).customer, "お客様: 決まりました", "label が無ければ（再起動の後など）");
});

test("照合の答えが抽出の後に返る: 客の質問が残り、答えで消えて承認待ちになる", async () => {
  const { dir, box, office } = await env();
  const s = await startSession({ dir, transcript: fict([TALK]), ledger, extract: extractor(), office, id: `p${seq++}` });
  assert.equal(s.customer, null);
  assert.deepEqual(
    s.questions.map((q) => q.text),
    [CUSTOMER_QUESTION],
  );
  assert.equal(toMonitorView(s).say, SAY.checking);
  assert.equal(toMonitorView(s).customer, "お客様: 確かめています…");
  assert.equal(toMonitorView(s).awaitingApproval, false);
  await processBox({ box, customers, post });
  const s1 = await readSession(dir, s.id);
  assert.ok(s1);
  assert.deepEqual(s1.questions, []);
  assert.equal(toMonitorView(s1).awaitingApproval, true);
});

test("said は作業ファイルに残らない（受け箱の問い合わせにだけある）。label も作業ファイルに残らない", async () => {
  const { dir, box, office } = await env();
  const s = await startSession({ dir, transcript: fict([TALK]), ledger, extract: extractor(), office, id: `p${seq++}` });
  const qs = await readBox(box);
  assert.equal(qs.length, 1);
  assert.equal(qs[0].kind, "customer.query");
  assert.deepEqual(qs[0].kind === "customer.query" && qs[0].said, ["えっと", "仮田さんの1111"], "4 桁を含む文と直前の文の原文");
  const file = await readFile(join(dir, `${s.id}.json`), "utf8");
  for (const w of ["仮田", "1111", "said"]) assert.ok(!file.includes(w), w);
  await processBox({ box, customers, post });
  assert.deepEqual(await boxFiles(box), [], "偽の事務所は答えた問い合わせを消す");
  const after1 = await readFile(join(dir, `${s.id}.json`), "utf8");
  for (const w of ["仮田", "1111", "軽トラ", "label"]) assert.ok(!after1.includes(w), w);
  assert.ok(after1.includes("cust-001"), "番号だけは残す");
});

test("事務所が無ければ照合しない（問い合わせを置かず、客を聞かずに承認できる）。伏せ字は効く", async () => {
  const { dir, box } = await env();
  const s = await startSession({ dir, transcript: fict(["脱着4本。お願いします。えっと。山田さんの9876。"]), ledger, extract: extractor(), id: `p${seq++}` });
  assert.equal(s.customerRequired, false);
  assert.deepEqual(await boxFiles(box), []);
  assert.ok(!JSON.stringify(s).includes("山田") && !JSON.stringify(s).includes("9876"));
  const done = await replySession({ dir, session: s, utterance: say("請求書頼む"), ledger });
  assert.equal(done.status, "done");
  assert.equal(toMonitorView(done).say, SAY.done(1));
});

// --- 期限・二重・待っていない答え ---

test("照合の期限: 10 秒で expired、遅れて来た答えは stale で捨てる。声は言い直しを頼む", async () => {
  const { dir, box, office } = await env();
  const s = await startSession({ dir, transcript: fict([TALK]), ledger, extract: extractor(), office, id: `p${seq++}` });
  const [q] = await readBox(box);
  const late = new Date(Date.parse(s.customerQuery?.sentAt ?? "") + QUERY_TIMEOUT_SEC * 1000);
  assert.equal(expireQuery(s, new Date(late.getTime() - 1)).customerQuery?.status, "pending");
  const t = await tickOffice(dir, office, s, late);
  assert.equal(t.customerQuery?.status, "expired");
  assert.equal(toMonitorView(t).say, SAY.noReply);
  assert.equal(toMonitorView(t).customer, "お客様: 事務所から返事がありません");
  const r = await reply(answer(q, FOUND));
  assert.deepEqual(await r.json(), { accepted: false, why: "stale" });
  assert.equal((await readSession(dir, s.id))?.customer, null);
  // 言い直せば新しい問い合わせ
  const s2 = await replySession({ dir, session: t, utterance: say("仮田さんです、1111"), ledger, office });
  assert.equal(s2.customerQuery?.status, "pending");
  assert.notEqual(s2.customerQuery?.id, q.id);
  assert.deepEqual(s2.answers.at(-1)?.action, { kind: "askOffice", queryId: s2.customerQuery?.id });
  assert.ok(!JSON.stringify(s2).includes("仮田") && !JSON.stringify(s2).includes("1111"));
});

test("二重の id は 2 回目から何もしない。別の問い合わせへの答え・retry の答え", async () => {
  const { dir, box, office } = await env();
  const s = await startSession({ dir, transcript: fict([TALK]), ledger, extract: extractor(), office, id: `p${seq++}` });
  const [q] = await readBox(box);
  assert.deepEqual(await (await reply(answer({ id: randomUUID(), sessionId: s.id }, FOUND))).json(), { accepted: false, why: "stale" });
  const retry = answer(q, { status: "retry", reason: "none" });
  assert.deepEqual(await (await reply(retry)).json(), { accepted: true });
  const s1 = await readSession(dir, s.id);
  assert.equal(s1?.customer, null);
  assert.equal(toMonitorView(s1).say, SAY.notFound);
  assert.equal(toMonitorView(s1).customer, "お客様: 決まりませんでした");
  assert.deepEqual(await (await reply(retry)).json(), { accepted: true, duplicate: true });
  assert.deepEqual((await readSession(dir, s.id))?.appliedIds, [retry.id]);
  // 純粋な関数でも
  const once = applyToFactory(s, answer(q, FOUND), new Date());
  assert.ok(once.accepted);
  const twice = applyToFactory(once.session, { ...answer(q, FOUND), id: once.session.appliedIds[0] }, new Date());
  assert.ok(twice.accepted && twice.duplicate);
});

test("受け箱に置けなければ「事務所の PC に届きません」。ほかの質問は続けられる", async () => {
  const { dir } = await env();
  const broken: BoxWriter = {
    kind: "broken",
    async put() {
      throw new Error("偽の失敗 C:\\nda\\box");
    },
  };
  const s = await startSession({
    dir,
    transcript: fict(["ゴムバルブも替えた。お願いします。えっと。仮田さんの1111。"]),
    ledger,
    extract: extractor(),
    office: { box: broken, timeoutMs: 1000 },
    id: `p${seq++}`,
  });
  assert.equal(s.customerQuery?.status, "unreachable");
  assert.equal(toMonitorView(s).customer, "お客様: 事務所に届きません");
  assert.equal(s.questions[0].reason, "qty", "明細の質問が先");
  const s1 = await replySession({ dir, session: s, utterance: say("4本"), ledger, office: { box: broken, timeoutMs: 1000 } });
  assert.deepEqual(s1.answers.at(-1)?.action, { kind: "setQty", value: 4, unit: "本" });
  assert.equal(toMonitorView(s1).say, SAY.unreachable);
  // sftp の口は置かずに失敗する（事務所の PC で確かめるまで）
  const o = officeFromEnv({ NDA_OFFICE_SFTP: "user@nda-office:C:/nda/box/in" } as unknown as NodeJS.ProcessEnv);
  await assert.rejects(o?.box.put("x.json", "{}") ?? Promise.reject(new Error("null")));
  assert.equal(officeFromEnv({} as unknown as NodeJS.ProcessEnv), null);
});

// --- 承認の後 ---

/** 承認の言葉を当てずに done にした作業（依頼の配線だけを試す）。 */
function approvedSession(s: Session): Session {
  const at = new Date().toISOString();
  const approve = {
    at,
    questionIndex: -1,
    lineIndex: -1,
    provenance: { recordingId: `${s.id}#answer-1`, startSec: 0, endSec: 1, speaker: "father" as const, quote: "請求書頼む" },
    source: "answer" as const,
    action: { kind: "approve" as const },
  };
  return transition({ ...s, approved: true, approvedAt: at, answers: [...s.answers, approve] }, "done", new Date());
}

/** 客が決まって承認待ちの作業。 */
async function ready() {
  const e = await env();
  const s0 = await startSession({ dir: e.dir, transcript: fict([TALK]), ledger, extract: extractor(), office: e.office, id: `p${seq++}` });
  await processBox({ box: e.box, customers, post });
  const s = await readSession(e.dir, s0.id);
  assert.ok(s);
  assert.equal(toMonitorView(s).awaitingApproval, true);
  return { ...e, s };
}

test("偽の事務所で一周: 話す → 照合 → 承認 → すぐ依頼を置く → entered。札と声", async () => {
  const { dir, box, office, s } = await ready();
  const done = await replySession({ dir, session: s, utterance: say("請求書頼む"), ledger, office });
  assert.equal(done.status, "sent");
  assert.deepEqual(
    done.history.slice(-3).map((h) => h.status),
    ["done", "sending", "sent"],
  );
  assert.equal(toMonitorView(done).say, SAY.sent);
  const [req] = await readBox(box);
  assert.equal(req.kind, "invoice.request");
  if (req.kind !== "invoice.request") return;
  assert.equal(req.id, done.office?.requestId);
  assert.deepEqual(req.customer, { customerNo: "cust-001", carNo: "car-cust-001" });
  assert.deepEqual(
    req.lines.map((l) => [l.item, l.qty, l.unit, l.unitPrice, l.amount, l.unitPriceFrom]),
    [["タイヤ脱着", 4, "本", 550, 2200, "ledger"]],
  );
  assert.equal(req.total, 2200);
  assert.equal(req.approval.quote, "請求書頼む");
  assert.ok(!JSON.stringify(req).includes("仮田") && !JSON.stringify(req).includes("1111"), "依頼の出所は伏せ字の後の文");

  await processBox({ box, customers, post });
  const end = await readSession(dir, s.id);
  assert.equal(end?.status, "entered");
  assert.equal(end?.office?.result?.enteredLines, 1);
  assert.equal(toMonitorView(end).say, SAY.entered(1));
  assert.equal(toMonitorView(end).office, "1行入れました。保存は人が押してください");
  // 同じ結果がもう一度届いても変わらない
  const again = answerRequest(req);
  assert.deepEqual(await (await reply({ ...again, id: end?.office?.result?.id ?? "" })).json(), { accepted: true, duplicate: true });
  assert.deepEqual(await (await reply(again)).json(), { accepted: false, why: "stale" }, "終わった作業への別の結果");
});

test("状態: stopped の理由で札が変わる。置けなければ sending のまま 30 秒ごとに送り直す。結果が置けた知らせより先でも進む", async () => {
  const { dir, box, office, s } = await ready();
  // 置けない受け箱で承認
  let fail = true;
  const flaky: OfficeLink = {
    box: {
      kind: "flaky",
      async put(name: string, body: string) {
        if (fail) throw new Error("つながらない");
        await office.box.put(name, body);
      },
    },
    timeoutMs: 1000,
  };
  const t0 = new Date();
  const sending = await replySession({ dir, session: s, utterance: say("請求書頼む"), ledger, office: flaky, now: () => t0 });
  assert.equal(sending.status, "sending");
  assert.equal(sending.office?.lastError, "受け箱に置けませんでした（Error）");
  assert.equal(toMonitorView(sending).say, SAY.sendFailed);
  assert.equal(toMonitorView(sending).office, "事務所の PC に届きません（書き込めません）。つながったら送ります");
  // 30 秒たつまでは送り直さない
  fail = false;
  const early = await tickOffice(dir, flaky, sending, new Date(t0.getTime() + (RESEND_EVERY_SEC - 1) * 1000));
  assert.equal(early.status, "sending");
  const later = await tickOffice(dir, flaky, early, new Date(t0.getTime() + RESEND_EVERY_SEC * 1000));
  assert.equal(later.status, "sent");
  const [req] = await readBox(box);
  assert.equal(req.id, sending.office?.requestId, "送り直しても同じ id");

  // stopped（使用中）
  if (req.kind !== "invoice.request") throw new Error("依頼でない");
  const stopped: InvoiceResult = { ...answerRequest(req), outcome: "stopped", enteredLines: 0, reason: "busy", readback: null };
  assert.deepEqual(await (await reply(stopped)).json(), { accepted: true });
  const st = await readSession(dir, s.id);
  assert.equal(st?.status, "stopped");
  assert.equal(toMonitorView(st).say, "事務所のソフトが使用中でした。人が入れてください");
  assert.equal(toMonitorView(st).office, "事務所のソフトが使用中です。人が入れてください");
  assert.throws(() => transition(st as Session, "entered", new Date()), /許されない遷移/);

  // 結果が「置けた」より先に着いた（sending のまま）
  const e2 = await ready();
  const d2 = approvedSession(e2.s);
  const noPut: OfficeLink = { box: { kind: "slow", put: () => Promise.reject(new Error("x")) }, timeoutMs: 100 };
  await writeSession(e2.dir, d2);
  const sd = await submitInvoice(e2.dir, noPut, d2);
  assert.equal(sd.status, "sending");
  const result: InvoiceResult = {
    v: 1,
    id: randomUUID(),
    sessionId: sd.id,
    sentAt: new Date().toISOString(),
    kind: "invoice.result",
    requestId: sd.office?.requestId ?? "",
    outcome: "entered",
    enteredLines: 1,
    reason: null,
    readback: null,
    screenshotFile: null,
  };
  assert.deepEqual(await (await reply(result)).json(), { accepted: true });
  const e2end = await readSession(e2.dir, sd.id);
  assert.equal(e2end?.status, "entered");
  assert.deepEqual(
    e2end?.history.slice(-3).map((h) => h.status),
    ["sending", "sent", "entered"],
  );
});

test("状態: 依頼を組めない作業（値の欠け）は置かずに stopped・invalid。承認の後の作業は承認・客が無ければ書けない", async () => {
  const { dir, office, s } = await ready();
  const done = approvedSession(s);
  const broken = { ...done, invoice: done.invoice && { ...done.invoice, lines: done.invoice.lines.map((l) => ({ ...l, qty: null })) } };
  await writeSession(dir, broken as Session);
  const r = await submitInvoice(dir, office, broken as Session);
  assert.equal(r.status, "stopped");
  assert.equal(r.office?.result?.reason, "invalid");
  await assert.rejects(writeSession(dir, { ...r, customer: null }), /done/);
  await assert.rejects(writeSession(dir, { ...r, approved: false }), /done/);
});

test("偽の事務所の照合: 名前と 4 桁が同じ 1 件のときだけ found。否定・被り・名前だけは retry で、名前を返さない", () => {
  const q = (said: string[]) => ({
    v: 1 as const,
    id: randomUUID(),
    sessionId: "s",
    sentAt: new Date().toISOString(),
    kind: "customer.query" as const,
    said,
    plate4: ["2222"],
    from: { recordingId: "r", startSec: 0, endSec: 1 },
    ttlSec: 10,
  });
  assert.equal(answerQuery(q(["見本花子さんの2222。"]), customers).result.status, "found");
  for (const said of [["2222の車。"], ["見本さんじゃなくて新規の山田さん、2222。"], ["見本さんと例野さん、2222。"]]) {
    const a = answerQuery(q(said), customers);
    assert.deepEqual(a.result, { status: "retry", reason: "none" }, said[0]);
  }
  clearLabels();
});

test("書き出した JSON Schema（office/box/schema）は zod と同じ（pnpm office:schema を流し忘れていない）", async () => {
  for (const [name, schema] of Object.entries(officeJsonSchemas())) {
    const file = JSON.parse(await readFile(join(ROOT, "office", "box", "schema", `${name}.json`), "utf8"));
    assert.deepEqual(file, JSON.parse(JSON.stringify(schema)), name);
  }
});

test("§9-4 共有フォルダ: 受け箱が無い・目印が無い（mount が外れた）は「見えません」、書けないは「書き込めません」。工場は受け箱を作らない", async () => {
  const { dir } = await env();
  const root = await tmp();
  const start = (box: string) =>
    startSession({
      dir,
      transcript: fict([TALK]),
      ledger,
      extract: extractor(),
      office: { box: folderBox(box, NOMOUNT), timeoutMs: 1000 },
      id: `m${seq++}`,
    });

  // フォルダが無い
  const missing = join(root, "unmounted", "in");
  const s1 = await start(missing);
  assert.equal(s1.customerQuery?.status, "unreachable");
  assert.equal(s1.customerQuery?.retryReason, "boxMissing");
  assert.equal(toMonitorView(s1).customer, "お客様: 事務所に届きません");
  await assert.rejects(readdir(missing), "工場は受け箱を作らない");

  // フォルダはあるが目印が無い（mount 先の空のフォルダ）
  const empty = join(root, "empty");
  await mkdir(empty);
  const s2 = await start(empty);
  assert.equal(s2.customerQuery?.retryReason, "boxMissing");
  assert.deepEqual(await readdir(empty), [], "外れた mount 先に書かない");

  // 書けない
  const ro = join(root, "readonly");
  await mkdir(ro);
  await writeFile(join(ro, BOX_MARKER), "");
  await chmod(ro, 0o500);
  try {
    const s3 = await start(ro);
    assert.equal(s3.customerQuery?.retryReason, "writeFailed");
    assert.equal(toMonitorView(s3).customer, "お客様: 事務所に届きません");
    assert.equal(toMonitorView(s3).say, SAY.unreachable);

    // 承認の後の依頼も同じ札
    const decided = { ...s3, customer: { customerNo: "c", carNo: "k" }, questions: [] };
    await writeSession(dir, decided);
    const done = approvedSession(decided);
    await writeSession(dir, done);
    const sd = await submitInvoice(dir, { box: folderBox(ro, NOMOUNT), timeoutMs: 1000 }, done);
    assert.equal(sd.status, "sending");
    assert.equal(toMonitorView(sd).office, "事務所の PC に届きません（書き込めません）。つながったら送ります");
    const other = approvedSession({ ...decided, id: `m${seq++}` });
    await writeSession(dir, other);
    const sm = await submitInvoice(dir, { box: folderBox(missing, NOMOUNT), timeoutMs: 1000 }, other);
    assert.equal(toMonitorView(sm).office, "事務所の PC に届きません（共有フォルダが見えません）。つながったら送ります");
  } finally {
    await chmod(ro, 0o700);
  }
});

test("Codex 2: mount の確かめ。受け箱が / と同じ dev なら置かない。書いている間に目印が消えたら（unmount）置いたファイルを消して見えない扱い", async () => {
  const root = await tmp();
  const box = join(root, "in");
  await mkdir(box);
  await writeFile(join(box, BOX_MARKER), "");
  // 受け箱が rootDir と同じ dev（mount した先でない）
  await assert.rejects(folderBox(box, { rootDir: root }).put("a.json", "{}"), BoxMissingError);
  assert.deepEqual(await readdir(box), [BOX_MARKER]);
  // 書いている間に unmount された（目印が見えなくなった）
  const gone = folderBox(box, { requireMount: false, beforeCommit: () => rm(join(box, BOX_MARKER)) });
  await assert.rejects(gone.put("b.json", "{}"), BoxMissingError);
  assert.deepEqual(await readdir(box), [], "置いたファイルも .tmp も残さない");
  // 環境変数: 既定は確かめる。0・false・no で外す
  assert.equal(requireMountFromEnv({} as unknown as NodeJS.ProcessEnv), true);
  for (const v of ["0", "false", "no"]) assert.equal(requireMountFromEnv({ NDA_OFFICE_BOX_REQUIRE_MOUNT: v } as unknown as NodeJS.ProcessEnv), false);
});

test("Codex 3: 同時の見回りでも送り直しは 1 本。.tmp は書き手ごとに別の名前", async () => {
  const { dir, box, office, s } = await ready();
  let fail = true;
  const puts: string[] = [];
  const counting: OfficeLink = {
    box: {
      kind: "counting",
      async put(name: string, body: string) {
        if (fail) throw new Error("つながらない");
        puts.push(name);
        await new Promise((r) => setTimeout(r, 30)); // 置くのに時間がかかる間に、ほかの見回りが来る
        await office.box.put(name, body);
      },
    },
    timeoutMs: 1000,
  };
  const t0 = new Date();
  const sending = await replySession({ dir, session: s, utterance: say("請求書頼む"), ledger, office: counting, now: () => t0 });
  assert.equal(sending.status, "sending");
  fail = false;
  const later = new Date(t0.getTime() + RESEND_EVERY_SEC * 1000);
  const results = await Promise.all([1, 2, 3, 4].map(() => tickOffice(dir, counting, sending, later)));
  assert.equal(puts.length, 1, "送り直しは 1 回だけ");
  assert.ok(results.some((r) => r.status === "sent"));
  assert.equal((await readSession(dir, s.id))?.status, "sent");
  assert.equal((await boxFiles(box)).length, 1);

  // 同じ名前を 2 本の書き手が同時に置いても、互いの .tmp を消し合わない
  const b = folderBox(box, NOMOUNT);
  await Promise.all([b.put("same.json", '{"a":1}'), b.put("same.json", '{"a":2}')]);
  assert.ok(["{\"a\":1}", "{\"a\":2}"].includes(await readFile(join(box, "same.json"), "utf8")));
  assert.deepEqual((await readdir(box)).filter((n) => n.endsWith(".tmp")), []);
});

test("Codex 4: stopped・duplicate は 1 回目の結果を遮らない（状態を変えず記録だけ）", async () => {
  const { dir, box, office, s } = await ready();
  const sent = await replySession({ dir, session: s, utterance: say("請求書頼む"), ledger, office });
  assert.equal(sent.status, "sent");
  const [req] = await readBox(box);
  if (req.kind !== "invoice.request") throw new Error("依頼でない");
  const dup: InvoiceResult = { ...answerRequest(req), outcome: "stopped", enteredLines: 0, reason: "duplicate", readback: null };
  // 本来の結果より先に duplicate が届く
  assert.deepEqual(await (await reply(dup)).json(), { accepted: true });
  const mid = await readSession(dir, s.id);
  assert.equal(mid?.status, "sent", "duplicate では止まらない");
  assert.deepEqual(mid?.appliedIds.at(-1), dup.id);
  assert.equal(toMonitorView(mid).say, SAY.sent);
  // 本来の結果が届けば entered
  assert.deepEqual(await (await reply(answerRequest(req))).json(), { accepted: true });
  const end = await readSession(dir, s.id);
  assert.equal(end?.status, "entered");
  // entered の後に duplicate が届いても entered のまま
  const dup2 = { ...dup, id: randomUUID() };
  assert.deepEqual(await (await reply(dup2)).json(), { accepted: true });
  assert.equal((await readSession(dir, s.id))?.status, "entered");
});

test("Codex 2 回目 3: 同時 2 本の承認でも依頼は 1 件だけ置かれる（作業ごとの排他）。同時の答えも片方を消さない", async () => {
  process.env.NDA_LEDGER_PATH = join(ROOT, "tests/fixtures/tire-ledger.json");
  const { dir, box, s } = await ready();
  process.env.NDA_OFFICE_BOX = box;
  process.env.NDA_OFFICE_BOX_REQUIRE_MOUNT = "0";
  try {
    const route = await import("../app/api/session/[id]/answer/route");
    const approve = () =>
      route.POST(
        new Request("http://localhost/x", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ utterance: { startSec: 0, endSec: 1, speaker: "father", text: "請求書頼む" } }),
        }),
        { params: Promise.resolve({ id: s.id }) },
      );
    const [a, b] = await Promise.all([approve(), approve()]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    const reqs = (await readBox(box)).filter((m) => m.kind === "invoice.request");
    assert.equal(reqs.length, 1, "依頼は 1 件");
    const end = await readSession(dir, s.id);
    assert.equal(end?.status, "sent");
    assert.equal(end?.office?.requestId, reqs[0].id);
    assert.equal(end?.answers.filter((x) => x.action.kind === "approve").length, 1);
  } finally {
    delete process.env.NDA_OFFICE_BOX;
    delete process.env.NDA_OFFICE_BOX_REQUIRE_MOUNT;
  }
});

test("Codex 2 回目 4: 事務所が rename の直後に取り込んでも成功。目印が消えていれば失敗", async () => {
  const root = await tmp();
  const box = join(root, "in");
  const taken = join(root, "work");
  await mkdir(box);
  await mkdir(taken);
  await writeFile(join(box, BOX_MARKER), "");
  // すぐ取り込まれた（ファイルが移った）
  const quick = folderBox(box, { requireMount: false, afterCommit: (f) => rename(f, join(taken, "a.json")) });
  await quick.put("a.json", "{}");
  assert.deepEqual(await readdir(taken), ["a.json"]);
  // 取り込まれたが、目印も消えていた（unmount）
  const lost = folderBox(box, {
    requireMount: false,
    afterCommit: async (f) => {
      await rename(f, join(taken, "b.json"));
      await rm(join(box, BOX_MARKER));
    },
  });
  await assert.rejects(lost.put("b.json", "{}"), BoxMissingError);
  // ファイルが残ったまま目印が消えた: ファイルを消して失敗
  await writeFile(join(box, BOX_MARKER), "");
  const gone = folderBox(box, { requireMount: false, afterCommit: () => rm(join(box, BOX_MARKER)) });
  await assert.rejects(gone.put("c.json", "{}"), BoxMissingError);
  assert.deepEqual(await readdir(box), []);
});
