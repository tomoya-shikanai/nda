/**
 * 客と車の照合（#45）: 名前＋ナンバー下 4 桁が一覧の同じ 1 件に合うときだけ結び付け、名前と 4 桁は伏せ字にして Claude に渡さない。
 * 素材は架空の一覧（tests/fixtures/customers.json）と架空の発話。抽出は偽物（API を呼ばない）。data/ は読まない。
 * 見るのは自分で作った一時フォルダの中だけ。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { loadCustomers } from "../lib/customer/load";
import { type Customer, CustomerList, identifyCustomer, MASK_NAME, MASK_PLATE } from "../lib/customer/match";
import { enumerateCandidates } from "../lib/invoice/candidates";
import { ledgerEntries, parseLedgerBook } from "../lib/ledger/lookup";
import { CUSTOMER_QUESTION } from "../lib/session/customer";
import { type Extractor, replySession, startSession } from "../lib/session/run";
import { readSession, type Session, transition, writeSession } from "../lib/session/store";
import { toMonitorView } from "../lib/session/view";
import type { Segment, Transcript } from "../lib/stt/types";

const ROOT = resolve(import.meta.dirname, "..");
const CUSTOMERS_PATH = join(ROOT, "tests/fixtures/customers.json");
const customers: Customer[] = CustomerList.parse(JSON.parse(readFileSync(CUSTOMERS_PATH, "utf8")));
const ledger = ledgerEntries(parseLedgerBook(JSON.parse(readFileSync(join(ROOT, "tests/fixtures/tire-ledger.json"), "utf8"))));

const made: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "nda-customer-"));
  made.push(d);
  return d;
}
after(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
});

let clock = 0;
const now = () => new Date(Date.UTC(2026, 10, 5, 12, 0, clock++));
let seq = 0;

/** 一覧の名前・読み・下 4 桁のどれかが文字列に入っているか。 */
const leaks = (s: string) =>
  customers.some((c) => [c.name, ...c.name.split(" "), c.kana, ...c.kana.split(" "), c.plate4].some((w) => s.includes(w)));

const id = (texts: string[]) => identifyCustomer(texts, customers);

test("照合: 名前とナンバーの両方が同じ 1 件に合うときだけ決まる", () => {
  assert.equal(id(["仮田一郎さんの1111、タイヤ脱着4本。"]).customerId, "cust-001");
  assert.equal(id(["仮田さん、1111。"]).customerId, "cust-001", "姓だけでもよい");
  assert.equal(id(["仮田さんです。", "ナンバーは11-11。"]).customerId, "cust-001", "発話をまたいでよい・区切りの「-」は飛ばす");
  // ナンバーだけ・名前だけ・合わない
  assert.equal(id(["1111の車、脱着4本。"]).customerId, null);
  assert.equal(id(["仮田一郎さん、脱着4本。"]).customerId, null);
  assert.equal(id(["仮田さんの2222。"]).customerId, null, "名前と下 4 桁が別の客");
  assert.equal(id(["仮田さんの3333。"]).customerId, null, "一覧に無い 4 桁");
});

test("照合: 被りの下 4 桁は名前で 1 件に決まる。名前が 2 人なら決めない", () => {
  assert.equal(id(["2222の車。"]).customerId, null);
  assert.equal(id(["見本花子さんの2222。"]).customerId, "cust-002");
  assert.equal(id(["例野さん、2222。"]).customerId, "cust-003");
  assert.equal(id(["見本さんと例野さん、2222。"]).customerId, null);
});

test("照合: 読みはひらがな・カタカナを同じに扱い、空白を無視する", () => {
  assert.equal(id(["ミホン ハナコさん、2222"]).customerId, "cust-002");
  assert.equal(id(["みほんはなこ 2222"]).customerId, "cust-002");
  assert.equal(id(["レイノさん　２２２２"]).customerId, "cust-003", "全角の数字・空白");
});

test("伏せ字: 照合に使った名前と 4 桁、決まらなくても一覧の名前・4 桁を伏せる。円の 4 桁・5 桁の数は伏せない。入力は書き換えない", () => {
  const texts = ["仮田一郎さんの1111、組替1650円。", "見本さんにも電話。12345は関係ない。"];
  const before = [...texts];
  const r = id(texts);
  assert.deepEqual(texts, before);
  assert.equal(r.customerId, "cust-001");
  assert.deepEqual(r.texts, [`${MASK_NAME}さんの${MASK_PLATE}、組替1650円。`, `${MASK_NAME}さんにも電話。12345は関係ない。`]);
  assert.ok(!r.texts.some(leaks));
  assert.deepEqual(id(["ミホン ハナコさん"]).texts, [`${MASK_NAME}さん`]);
});

test("一覧を読む: 置き場が無ければ null（無効）、読めない・形が違えば空、架空の一覧は 3 件", async () => {
  assert.equal(await loadCustomers(""), null);
  assert.equal(await loadCustomers(undefined), null);
  const dir = await tmp();
  assert.deepEqual(await loadCustomers(join(dir, "none.json")), []);
  const bad = join(dir, "bad.json");
  await writeFile(bad, JSON.stringify([{ id: "x", name: "x", kana: "x", plate4: "12", car: "x" }]));
  assert.deepEqual(await loadCustomers(bad), []);
  assert.equal((await loadCustomers(CUSTOMERS_PATH))?.length, 3);
});

// --- 作業の通し ---

const fict = (texts: string[]): Transcript => ({
  recordingId: `cust-${seq}`,
  vendor: "fictional",
  language: "ja",
  glossaryHint: false,
  segments: texts.map((text, i) => ({ startSec: i * 4, endSec: i * 4 + 3, speaker: null, text })),
});

/** 偽の抽出: 料金表の品目ごとに 1 行、同じ発話の数量。渡された文字起こしと候補を残す。 */
function spyExtract(): { extract: Extractor; seen: Transcript[] } {
  const seen: Transcript[] = [];
  const extract: Extractor = async (t, l) => {
    seen.push(structuredClone(t));
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
  return { extract, seen };
}

const say = (text: string): Segment => ({ startSec: 0, endSec: 2, speaker: "speaker_0", text });

async function start(texts: string[], list: Customer[] | null = customers) {
  const dir = await tmp();
  const spy = spyExtract();
  const s = await startSession({ dir, transcript: fict(texts), ledger, extract: spy.extract, now, id: `cu${seq++}`, customers: list });
  return { dir, s, ...spy };
}
const reply = (dir: string, s: Session, text: string, extract?: Extractor) =>
  replySession({ dir, session: s, utterance: say(text), ledger, extract, now, customers });

test("伏せ字が抽出に渡り、4 桁は数量の候補に紛れない。保存する作業にも名前・4 桁を残さず、客の id だけ", async () => {
  const { dir, s, seen } = await start(["仮田一郎さんの1111、脱着4本。"]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].segments[0].text, `${MASK_NAME}さんの${MASK_PLATE}、脱着4本。`);
  const cs = enumerateCandidates(seen[0], ledger);
  assert.deepEqual(
    cs.filter((c) => c.kind !== "item").map((c) => [c.kind, c.value]),
    [["qty", 4]],
  );
  assert.equal(s.customerId, "cust-001");
  assert.equal(s.customerRequired, true);
  assert.equal(s.invoice?.lines[0].qty, 4);
  const saved = await readSession(dir, s.id);
  assert.ok(!leaks(JSON.stringify(saved)));
  // 決まっていれば客の質問は無く、承認待ち。画面に名前と車
  assert.deepEqual(s.questions, []);
  const v = toMonitorView(s, customers);
  assert.equal(v.awaitingApproval, true);
  assert.deepEqual(v.customer, { name: "仮田 一郎", car: "架空の軽トラ" });
  assert.equal(toMonitorView(s).customer, null, "一覧が無ければ出さない");
  const done = await reply(dir, s, "請求書頼む");
  assert.equal(done.status, "done");
});

test("客が未定だと承認できない。客の質問は明細の質問の後で、候補を出さない。返事で決まれば承認できる", async () => {
  const { dir, s } = await start(["1111の車、脱着4本。"]);
  assert.equal(s.customerId, null);
  assert.equal(s.invoice?.confirmations.length, 0);
  assert.deepEqual(
    s.questions.map((q) => q.text),
    [CUSTOMER_QUESTION],
  );
  const v0 = toMonitorView(s, customers);
  assert.equal(v0.awaitingApproval, false);
  assert.equal(v0.confirmationCount, 1);
  assert.equal(v0.say, CUSTOMER_QUESTION);
  assert.equal(v0.customer, null);
  assert.ok(!leaks(JSON.stringify(v0)));

  // 承認の言葉は効かない
  const s1 = await reply(dir, s, "請求書頼む");
  assert.equal(s1.status, "asking");
  assert.deepEqual(s1.answers.at(-1)?.action, { kind: "unread", reason: "確認事項が残っている" });
  assert.throws(() => transition({ ...s1, approved: true }, "done", now()), /お客様/);
  await assert.rejects(writeSession(dir, { ...s1, status: "done", approved: true }), /done/);

  // 名前だけ・別の客の 4 桁: 決まらない。聞き直しにも候補を出さない
  for (const t of ["仮田さんです", "見本さん、1111"]) {
    const r = await reply(dir, s1, t);
    assert.equal(r.customerId, null, t);
    assert.deepEqual(r.answers.at(-1)?.action, { kind: "unread", reason: "お客様が分からない" }, t);
    const v = toMonitorView(r, customers);
    assert.equal(v.say, `もう一度お願いします。${CUSTOMER_QUESTION}`);
    assert.ok(!leaks(JSON.stringify(r)), t);
  }

  // 両方合う返事で決まる（答えの言葉も伏せ字で残す）
  const s2 = await reply(dir, s1, "仮田一郎、1111");
  assert.equal(s2.customerId, "cust-001");
  assert.deepEqual(s2.answers.at(-1)?.action, { kind: "setCustomer", id: "cust-001" });
  assert.equal(s2.answers.at(-1)?.provenance.quote, `${MASK_NAME}、${MASK_PLATE}`);
  assert.deepEqual(s2.questions, []);
  assert.equal(toMonitorView(s2, customers).awaitingApproval, true);
  assert.ok(!leaks(JSON.stringify(await readSession(dir, s.id))));
  const done = await reply(dir, s2, "請求書頼む");
  assert.equal(done.status, "done");
  assert.equal(done.invoice?.total, 2200);
});

test("明細の質問があるうちに客を言っても決まる。明細の質問は残る", async () => {
  const { dir, s } = await start(["ゴムバルブも替えた。"]);
  assert.deepEqual(
    s.questions.map((q) => q.reason),
    ["qty", "customer"],
  );
  const s1 = await reply(dir, s, "ミホン ハナコさん、2222");
  assert.equal(s1.customerId, "cust-002");
  assert.deepEqual(
    s1.questions.map((q) => q.reason),
    ["qty"],
  );
  const s2 = await reply(dir, s1, "4本");
  assert.equal(toMonitorView(s2, customers).awaitingApproval, true);
});

test("一覧が無ければ照合しない（伏せ字もしない）。客を聞かずに承認できる。画面は未指定", async () => {
  const { s, seen } = await start(["1111の車、脱着4本。"], null);
  assert.equal(s.customerRequired, false);
  assert.equal(seen[0].segments[0].text, "1111の車、脱着4本。");
  assert.ok(s.questions.every((q) => q.reason !== "customer"));
  assert.equal(toMonitorView(s).customer, null);
  const plain = await start(["脱着4本。"], null);
  assert.deepEqual(plain.s.questions, []);
  const done = await replySession({ dir: plain.dir, session: plain.s, utterance: say("請求書頼む"), ledger, now });
  assert.equal(done.status, "done");

});

test("GET /api/session/current: 一覧があれば客の名前と車、無ければ null", async () => {
  const { dir } = await start(["仮田一郎さんの1111、脱着4本。"]);
  process.env.NDA_SESSION_DIR = dir;
  const route = await import("../app/api/session/current/route");
  const get = async () => (await (await route.GET(new Request("http://localhost/api/session/current"))).json()) as { customer: unknown };
  const prev = process.env.NDA_CUSTOMERS_PATH;
  try {
    process.env.NDA_CUSTOMERS_PATH = CUSTOMERS_PATH;
    assert.deepEqual((await get()).customer, { name: "仮田 一郎", car: "架空の軽トラ" });
    delete process.env.NDA_CUSTOMERS_PATH;
    assert.equal((await get()).customer, null);
  } finally {
    if (prev === undefined) delete process.env.NDA_CUSTOMERS_PATH;
    else process.env.NDA_CUSTOMERS_PATH = prev;
  }
});

// --- Codex 指摘 1: 一覧に無い客の情報も伏せる ---

test("Codex 指摘 1: 一覧に無い名前（さん・様・さま）と 4 桁（算用・全角・漢数字）も伏せる。一覧が空でも同じ。円の数は伏せない", () => {
  for (const list of [customers, []]) {
    const r = identifyCustomer(["山田さん、ナンバー9876。脱着4本。"], list);
    assert.equal(r.customerId, null);
    assert.deepEqual(r.texts, [`${MASK_NAME}さん、ナンバー${MASK_PLATE}。脱着4本。`]);
    assert.deepEqual(identifyCustomer(["ヤマダ様の一一一一"], list).texts, [`${MASK_NAME}様の${MASK_PLATE}`]);
    assert.deepEqual(identifyCustomer(["やまださま、９８７６"], list).texts, [`${MASK_NAME}さま、${MASK_PLATE}`]);
    assert.deepEqual(identifyCustomer(["山田 太郎さん"], list).texts, [`${MASK_NAME}さん`], "姓と名の間の空白");
    assert.deepEqual(identifyCustomer(["組替1650円、たくさん。お客さんの車"], list).texts, ["組替1650円、たくさん。お客さんの車"]);
  }
  // 漢数字の下 4 桁でも照合できる
  assert.equal(identifyCustomer(["仮田さん、一一一一。"], customers).customerId, "cust-001");
  // 敬称の前の一覧の名前は、一覧外の名前として数えない
  assert.equal(identifyCustomer(["お客さんの見本さん、2222。"], customers).customerId, "cust-002");
});

test("Codex 指摘 1: 一覧に無い客の名前と 4 桁は、抽出にも保存にも画面にも残らず、4 桁は数量の候補にならない", async () => {
  for (const list of [customers, []]) {
    const { dir, s, seen } = await start(["山田さん、ナンバー9876。脱着4本。"], list);
    const t = seen[0].segments[0].text;
    assert.ok(!t.includes("山田") && !t.includes("9876"), t);
    assert.deepEqual(
      enumerateCandidates(seen[0], ledger)
        .filter((c) => c.kind !== "item")
        .map((c) => [c.kind, c.value]),
      [["qty", 4]],
    );
    const saved = JSON.stringify(await readSession(dir, s.id));
    assert.ok(!saved.includes("山田") && !saved.includes("9876"));
    const heard = toMonitorView(s, list).heard ?? "";
    assert.ok(!heard.includes("山田") && !heard.includes("9876"), heard);
    assert.equal(s.customerId, null);
    // 返事の言葉も伏せる
    const r = await replySession({ dir, session: s, utterance: say("山田さん、9876"), ledger, now, customers: list });
    assert.equal(r.customerId, null);
    assert.ok(!JSON.stringify(r).includes("山田") && !JSON.stringify(r).includes("9876"));
  }
});

// --- Codex 指摘 2: 否定された名前・一覧外の名前と並んだ名前で決めない ---

test("Codex 指摘 2: 一覧の名前を含む文に否定・訂正の合図、または同じ発話に一覧外のさん付けの名前があれば決めない", async () => {
  for (const t of [
    "見本さんじゃなくて新規の山田さん、2222。",
    "見本さんは違う。2222。",
    "見本さんじゃなくて、2222。",
    "見本さんと山田さん、2222。",
  ]) {
    const r = identifyCustomer([t], customers);
    assert.equal(r.customerId, null, t);
    assert.ok(!leaks(r.texts[0]) && !r.texts[0].includes("山田"), r.texts[0]);
  }
  // 合図が別の文なら決める
  assert.equal(identifyCustomer(["それは違う。見本さんの2222。"], customers).customerId, "cust-002");

  // 作業でも: 決まらず、客の質問（候補を出さない）
  const { dir, s } = await start(["見本さんじゃなくて新規の山田さん、2222。脱着4本。"]);
  assert.equal(s.customerId, null);
  assert.equal(s.questions.at(-1)?.text, CUSTOMER_QUESTION);
  const r = await reply(dir, s, "見本さんじゃなくて山田さん、2222");
  assert.equal(r.customerId, null);
  assert.equal(toMonitorView(r, customers).say, `もう一度お願いします。${CUSTOMER_QUESTION}`);
});
