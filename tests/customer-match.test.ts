/**
 * 客と車の照合（#45）: 名前＋ナンバー下 4 桁が一覧の同じ 1 件に合うときだけ結び付け、名前と 4 桁は伏せ字にして Claude に渡さない。
 * 一覧つきの照合は偽の事務所（lib/office/fake.ts）が使う。工場は一覧なしの伏せ字だけ（#25）。
 * 素材は架空の一覧（tests/fixtures/customers.json）と架空の発話。抽出は偽物（API を呼ばない）。data/ は読まない。
 * 見るのは自分で作った一時フォルダの中だけ。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { type Customer, CustomerList, identifyCustomer, MASK_NAME, MASK_PLATE, maskCustomerInfo } from "../lib/customer/match";
import { enumerateCandidates } from "../lib/invoice/candidates";
import { ledgerEntries, parseLedgerBook } from "../lib/ledger/lookup";
import { type Extractor, replySession, startSession } from "../lib/session/run";
import { readSession } from "../lib/session/store";
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

/** 工場は客の一覧を持たない（#25）。伏せ字は一覧なしで、事務所の有無にかかわらず効く。 */
async function start(texts: string[]) {
  const dir = await tmp();
  const spy = spyExtract();
  const s = await startSession({ dir, transcript: fict(texts), ledger, extract: spy.extract, now, id: `cu${seq++}` });
  return { dir, s, ...spy };
}

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

test("Codex 指摘 1・#25: 一覧なしの伏せ字で、客の名前と 4 桁は抽出にも保存にも画面にも残らず、4 桁は数量の候補にならない", async () => {
  {
    const { dir, s, seen } = await start(["山田さん、ナンバー9876。脱着4本。"]);
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
    const heard = toMonitorView(s).heard ?? "";
    assert.ok(!heard.includes("山田") && !heard.includes("9876"), heard);
    assert.equal(s.customer, null);
    // 返事の言葉も伏せる
    const r = await replySession({ dir, session: s, utterance: say("山田さん、9876"), ledger, now });
    assert.equal(r.customer, null);
    assert.ok(!JSON.stringify(r).includes("山田") && !JSON.stringify(r).includes("9876"));
  }
});

// --- Codex 指摘 2: 否定された名前・一覧外の名前と並んだ名前で決めない ---

test("Codex 指摘 2: 一覧の名前を含む文に否定・訂正の合図、または同じ発話に一覧外のさん付けの名前があれば決めない", async () => {
  for (const t of [
    "見本さんじゃなくて新規の山田さん、2222。",
    "見本さんは違う。2222。",
    "見本さんじゃなくて、2222。",
    "見本さんじゃない、2222。",
    "見本さんと山田さん、2222。",
  ]) {
    const r = identifyCustomer([t], customers);
    assert.equal(r.customerId, null, t);
    assert.ok(!leaks(r.texts[0]) && !r.texts[0].includes("山田"), r.texts[0]);
  }
  // 合図が別の文なら決める
  assert.equal(identifyCustomer(["それは違う。見本さんの2222。"], customers).customerId, "cust-002");

});

test("自動のセキュリティ点検: 字の種類が混ざった名前・々・ヶ・ラテン文字の名前も丸ごと伏せる。助詞・句読点・数字で止める", () => {
  for (const list of [customers, []]) {
    const m = (t: string) => identifyCustomer([t], list).texts[0];
    assert.equal(m("山田ヨシ子さんの車"), `${MASK_NAME}さんの車`);
    assert.equal(m("佐々木さん"), `${MASK_NAME}さん`);
    assert.equal(m("一ヶ谷さん"), `${MASK_NAME}さん`);
    assert.equal(m("Tanakaさん、脱着4本"), `${MASK_NAME}さん、脱着4本`);
    assert.equal(m("Ｔａｎａｋａ様"), `${MASK_NAME}様`);
    assert.equal(m("マイケル・ジョーダンさん"), `${MASK_NAME}さん`);
    assert.equal(m("やまださま"), `${MASK_NAME}さま`);
    // 助詞・句読点・数字・前の敬称で止める（品目の語は残す）
    assert.equal(m("脱着4本は山田さん"), `脱着4本は${MASK_NAME}さん`);
    assert.equal(m("タイヤの山田ヨシ子さん"), `タイヤの${MASK_NAME}さん`);
    assert.equal(m("脱着、Tanakaさん"), `脱着、${MASK_NAME}さん`);
    assert.equal(m("番号は4佐々木さん"), `番号は4${MASK_NAME}さん`);
    // 名前でない語は、並び全体がその語のときだけ伏せない（「お客さん」「父さん」）。後ろに付くだけなら丸ごと伏せる
    assert.equal(m("お客さん、父さん"), "お客さん、父さん");
    assert.equal(m("山田父さん"), `${MASK_NAME}さん`);
    assert.equal(m("脱着したお客さん"), `${MASK_NAME}さん`, "伏せすぎる側");
  }
  // 一覧の名前と並んだ一覧外の名前（字の種類が混ざっても）で決めない
  assert.equal(identifyCustomer(["見本さんと山田ヨシ子さん、2222。"], customers).customerId, null);
  assert.equal(identifyCustomer(["見本さんとTanakaさん、2222。"], customers).customerId, null);
  assert.equal(identifyCustomer(["見本花子さん、2222。"], customers).customerId, "cust-002");
});

test("自動のセキュリティ点検: 姓とひらがなの名の間の「は」「の」で止めず、姓まで伏せる", () => {
  for (const list of [customers, []]) {
    const m = (t: string) => identifyCustomer([t], list).texts[0];
    assert.equal(m("山田はなこさん"), `${MASK_NAME}さん`);
    assert.equal(m("佐藤のぞみさん"), `${MASK_NAME}さん`);
    assert.equal(m("田中ゆみなさん"), `${MASK_NAME}さん`);
    // 助詞の後ろが漢字・カタカナを含めば、これまでどおり助詞で止める
    assert.equal(m("脱着4本は山田さん"), `脱着4本は${MASK_NAME}さん`);
  }
});

// --- 自動のセキュリティ点検: 敬称の無い姓（一覧なし） ---

test("一覧なしの伏せ字: 4 桁を含む句と、その直前の品目の語の無い句を伏せる。敬称の無い姓が残らず、品目と数量は残る", async () => {
  const words = ledger.flatMap((e) => [e.item, ...e.aliases]);
  const m = (texts: string[]) => maskCustomerInfo(texts, words);
  for (const [t, keep] of [
    ["田中 1234", []],
    ["田中、1234。脱着4本", ["脱着4本"]],
    ["脱着4本、田中1234", ["脱着4本"]],
    ["1234の田中", []],
    ["田中さん1234、脱着4本", ["脱着4本"]],
    ["タイヤ交換4本、田中、1234", ["タイヤ交換4本"]],
  ] as const) {
    const [out] = m([t]);
    assert.ok(!out.includes("田中") && !out.includes("1234"), `${t} → ${out}`);
    for (const k of keep) assert.ok(out.includes(k), `${t} → ${out}`);
  }
  // 発話をまたぐ（前の発話の最後の句が姓）
  assert.deepEqual(m(["田中です", "1234。脱着4本。"]), [MASK_NAME, `${MASK_PLATE}。脱着4本。`]);
  // 4 桁が無ければ句は伏せない。円の 4 桁は伏せない
  assert.deepEqual(m(["田中、脱着4本、1650円"]), ["田中、脱着4本、1650円"]);

  // 作業でも: 抽出と作業ファイルに姓が残らず、明細は作れる
  const { dir, s, seen } = await start(["田中、1234。脱着4本。"]);
  assert.ok(!seen[0].segments[0].text.includes("田中"));
  assert.ok(!JSON.stringify(await readSession(dir, s.id)).includes("田中"));
  assert.equal(s.invoice?.lines[0]?.qty, 4);
});
