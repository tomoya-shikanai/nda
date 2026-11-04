import { normalize } from "../karte/verify";
import { type LedgerEntry, findEntry } from "../ledger/lookup";
import type { Segment, Transcript } from "../stt/types";
import type { InvoiceDraft, InvoiceLine } from "./schema";

const SLACK_SEC = 1;
/** 1 つの引用が占めてよい時間の幅。離れた発話をつないで値を作らせない。 */
export const MAX_QUOTE_SEC = 20;

/** 数量に付く単位。この単位が付いた数だけを数量として認める。長いものを先に置く。 */
const UNITS = ["セット", "箇所", "か所", "ヶ所", "本", "個", "台", "輪", "つ", "枚", "式", "回"];
const UNIT = `(${UNITS.join("|")})`;
const NUM = "(\\d+(?:\\.\\d+)?)";
/** 1 単位あたりの値段を示すつなぎ（「1本あたり330円」「単価は330円」）。 */
const PER = "(?:あたり|当たり|につき)?(?:は|が|で)?[、,]?";

const KANJI_DIGIT: Record<string, number> = {
  〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};
const KANJI_MULT: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };

/** 「二十四」「三三〇」「1万2千」を数にする。 */
function kanjiToNumber(s: string): number {
  let total = 0;
  let section = 0;
  let cur = 0;
  for (const c of s) {
    if (c >= "0" && c <= "9") cur = cur * 10 + Number(c);
    else if (c in KANJI_DIGIT) cur = cur * 10 + KANJI_DIGIT[c];
    else if (c in KANJI_MULT) {
      section += (cur || 1) * KANJI_MULT[c];
      cur = 0;
    } else if (c === "万") {
      total += (section + cur || 1) * 10000;
      section = 0;
      cur = 0;
    }
  }
  return total + section + cur;
}

/**
 * 数量・単価の照合用の正規化。`lib/karte/verify.ts` の normalize と違い、小数点を残す。
 * 全角を半角に、漢数字を算用数字に、数字の間の千の位のカンマだけを外す。
 */
export function normalizeNumbers(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/(\d),(?=\d)/g, "$1")
    .replace(/[0-9〇一二三四五六七八九十百千万]+/g, (run) =>
      /[〇一二三四五六七八九十百千万]/.test(run) ? String(kanjiToNumber(run)) : run,
    )
    .replace(/(\d)\s+(?=\d)/g, "$1|")
    .replace(/\s+/g, "");
}

/** 「数＋単位」として言われた数量。1 単位あたりの値段（「1本330円」の「1本」）は数量にしない。 */
export function spokenQuantities(text: string): { qty: number; unit: string }[] {
  const re = new RegExp(`(?<![\\d.])${NUM}${UNIT}(?!あたり|当たり|につき|(?:は|が)?[、,]?\\d+(?:\\.\\d+)?円)`, "g");
  return [...normalizeNumbers(text).matchAll(re)].map((m) => ({ qty: Number(m[1]), unit: m[2] }));
}

/**
 * 1 単位あたりと分かる形（「1本330円」「単価330円」）で言われた値段。合計額は含めない。
 * unit は「1本」の形ならその単位、「単価」の形なら null。
 */
export function spokenUnitPrices(text: string): { price: number; unit: string | null }[] {
  const re = new RegExp(`(?:(?<![\\d.])1${UNIT}|単価)${PER}${NUM}円`, "g");
  return [...normalizeNumbers(text).matchAll(re)].map((m) => ({ price: Number(m[2]), unit: m[1] ?? null }));
}

/** 形を問わず「数字＋円」として言われた金額。 */
function spokenYen(text: string): number[] {
  const re = new RegExp(`(?<![\\d.])${NUM}円`, "g");
  return [...normalizeNumbers(text).matchAll(re)].map((m) => Number(m[1]));
}

/**
 * 引用（normalize 後）が、つないだ発話のどこに当たるか。当たるごとに、その引用を作った発話の組を返す。
 */
function quoteSources(key: string, near: Segment[]): Segment[][] {
  const texts = near.map((s) => normalize(s.text));
  const starts: number[] = [];
  let pos = 0;
  for (const x of texts) {
    starts.push(pos);
    pos += x.length;
  }
  const joined = texts.join("");
  const out: Segment[][] = [];
  for (let i = joined.indexOf(key); i >= 0; i = joined.indexOf(key, i + 1)) {
    out.push(near.filter((_, j) => texts[j].length > 0 && starts[j] < i + key.length && starts[j] + texts[j].length > i));
  }
  return out;
}

/** 引用を作った発話の組に対して、話者・数量・単価を 1 つの発話の中だけで確かめる。 */
function sourceFailures(line: InvoiceLine, sources: Segment[], label: string, priceSpoken: boolean): string[] {
  const p = line.provenance;
  const failures: string[] = [];
  const other = sources.find((s) => s.speaker !== null && s.speaker !== p.speaker);
  if (other) failures.push(`${label}: 話者が発話（${other.speaker}）と違う (${p.speaker})`);

  if (line.qty !== null) {
    const inQuote = spokenQuantities(p.quote).filter((q) => q.qty === line.qty);
    const said = inQuote.filter((q) => sources.some((s) => spokenQuantities(s.text).some((x) => x.qty === q.qty && x.unit === q.unit)));
    if (said.length === 0) {
      failures.push(`${label}: 数量が発話に無い (${line.qty})`);
    } else if (!said.some((q) => q.unit === line.unit)) {
      failures.push(`${label}: 数量の単位が発話（${said.map((q) => q.unit).join("・")}）と明細（${line.unit ?? "なし"}）で違う`);
    }
  }

  if (line.unitPrice !== null && priceSpoken) {
    const price = line.unitPrice;
    // 「1セット1000円」を 1 本あたりの値段にしない
    const fits = (x: { price: number; unit: string | null }) =>
      x.price === price && (x.unit === null || line.unit === null || x.unit === line.unit);
    const ok =
      spokenUnitPrices(p.quote).some(fits) && sources.some((s) => spokenUnitPrices(s.text).some(fits));
    if (!ok) failures.push(`${label}: 単価の根拠が発話に無い (${price}円。1 単位あたりの値段として 1 つの発話の中に無い)`);
  }
  return failures;
}

/** 行の品目が引用の中で言われているか。料金表に当たる品目は、その正式名か別名のどれかで照らす。 */
function itemSpoken(item: string, quote: string, ledger: LedgerEntry[]): boolean {
  const entry = findEntry(ledger, item);
  const names = entry ? [entry.item, ...entry.aliases] : [item];
  const q = normalize(quote);
  return names.some((n) => {
    const k = normalize(n);
    return k.length > 0 && q.includes(k);
  });
}

/** 明細 1 行の後検証。空配列なら合格。 */
export function verifyLine(line: InvoiceLine, t: Transcript, ledger: LedgerEntry[] = []): string[] {
  const failures: string[] = [];
  const p = line.provenance;
  const label = `${line.item}「${p.quote}」`;
  const priceSpoken = line.unitPrice === null || spokenYen(p.quote).includes(line.unitPrice);
  if (!priceSpoken) failures.push(`${label}: 単価が発話に無い (${line.unitPrice}円)`);
  if (!itemSpoken(line.item, p.quote, ledger)) failures.push(`${label}: 品目が発話に無い (${line.item})`);
  if (p.recordingId !== t.recordingId) {
    failures.push(`${label}: 録音 ID が違う (${p.recordingId})`);
    return failures;
  }
  if (!(p.startSec < p.endSec)) {
    failures.push(`${label}: 時刻範囲が不正 (${p.startSec}-${p.endSec})`);
    return failures;
  }
  if (p.endSec - p.startSec > MAX_QUOTE_SEC) {
    failures.push(`${label}: 引用の時間の幅が長すぎる (${p.endSec - p.startSec}s > ${MAX_QUOTE_SEC}s)`);
    return failures;
  }
  const near = t.segments.filter(
    (s) => s.endSec >= p.startSec - SLACK_SEC && s.startSec <= p.endSec + SLACK_SEC,
  );
  const key = normalize(p.quote);
  if (!key || !normalize(near.map((s) => s.text).join("")).includes(key)) {
    failures.push(`${label}: 指定の時刻付近の文字起こしに無い (${p.startSec}-${p.endSec}s)`);
    return failures;
  }
  if (p.speaker !== "unknown" && near.every((s) => s.speaker === null)) {
    failures.push(`${label}: 話者情報が無い録音で話者を ${p.speaker} と推定している`);
  }
  // 引用が当たる場所が複数あれば、どれか 1 つで全部そろえば合格
  const perSource = quoteSources(key, near).map((src) => sourceFailures(line, src, label, priceSpoken));
  if (!perSource.some((f) => f.length === 0)) failures.push(...(perSource[0] ?? []));
  return failures;
}

/**
 * 明細の後検証。出所は verifyDraft と同じ規則で文字起こしと突き合わせ、さらに次を確かめる。
 * - 品目: 引用の中で言われている（料金表に当たる品目は正式名か別名で）。
 * - 数量: 引用の中に「数＋単位」としてあり、引用に重なる 1 つの発話の中でも言われている。単位は明細と同じ。
 * - 単価: 引用の中に「その数字＋円」がある。さらに 1 単位あたりの形で、1 つの発話の中で言われている。
 * - 話者: 話者情報のある録音では、引用を作った発話の話者と一致する。
 * - 引用の時間の幅は MAX_QUOTE_SEC 以下。
 */
export function verifyInvoice(d: InvoiceDraft, t: Transcript, ledger: LedgerEntry[] = []): string[] {
  return d.lines.flatMap((line) => verifyLine(line, t, ledger));
}
