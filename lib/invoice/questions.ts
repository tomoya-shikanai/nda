/**
 * 確認事項を、父に聞き返す単位にまとめる（設計 docs/design/invoice-verify.md の (e)、V5 の一部）。
 * 純粋な関数。API を呼ばない、入力を書き換えない。確認事項は減らさず、どれかの質問に必ず入れる。
 * 行（lineIndex 0 以上）は 1 行につき 1 問、行に付かない事項（lineIndex -1）は理由ごとに 1 問。
 * 同じ質問の確認事項は理由の種類にまとめ、優先度の最上位の理由で 1 文の質問を作る。数は候補の文字列だけを使う。
 */
import type { Transcript } from "../stt/types";
import type { Candidate } from "./candidates";
import type { Confirmation, PricedInvoice } from "./price";

/** 聞き返す理由の種類。並びは優先度の順（最後の other は、どれにも当たらないもの）。 */
export const QUESTION_REASONS = [
  "negation", // 否定
  "correction", // 言い直し（使われない数を含む）
  "unparsed", // 読めない数
  "qty", // 数量
  "unitPrice", // 単価
  "unit", // 単位
  "ledger", // 料金表
  "total", // 合計
  "other", // その他（同じ根拠・20 秒・参照が不正・確かでない など）
] as const;
export type QuestionReason = (typeof QUESTION_REASONS)[number];

export type Question = {
  /** 行の添字。-1 は行に付かない事項。 */
  lineIndex: number;
  /** 行の品目（-1 は、まとめた事項の名前を「・」でつないだもの）。 */
  item: string;
  /** 質問文を作った、優先度の最上位の理由。 */
  reason: QuestionReason;
  /** この質問に入る確認事項の理由の種類（優先度の順、重複なし）。 */
  reasons: QuestionReason[];
  /** 音声で読む 1 文の質問。 */
  text: string;
  /** この質問にまとめた元の確認事項（元の順）。 */
  confirmations: Confirmation[];
};

/** 確認事項の理由の種類。文言の括弧の印（resolve.ts・price.ts・check.ts が付ける）と欄で決める。 */
export function reasonOf(c: Confirmation): QuestionReason {
  if (c.message.includes("（否定）")) return "negation";
  if (c.message.includes("言い直し")) return "correction";
  if (c.message.includes("読めない）")) return "unparsed";
  if (c.field === "total") return "total";
  if (c.field === "qty") return "qty";
  if (c.field === "unitPrice") return "unitPrice";
  if (c.field === "unit") return "unit";
  if (c.field === "item" && /料金表|別名|二重/.test(c.message)) return "ledger";
  return "other";
}

const rank = (r: QuestionReason) => QUESTION_REASONS.indexOf(r);

type Result = Pick<PricedInvoice, "lines" | "confirmations">;
type Line = Result["lines"][number];

export function toQuestions(result: Result, candidates: Candidate[], t: Transcript): Question[] {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const order = new Map(candidates.map((c, i) => [c.id, i]));
  /** 確認事項たちが指す候補（発話の順、重複なし）。 */
  const related = (cs: Confirmation[]): Candidate[] =>
    [...new Set(cs.flatMap((c) => c.candidates ?? []))]
      .filter((id) => byId.has(id))
      .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
      .map((id) => byId.get(id) as Candidate);
  const distinctTexts = (cs: Candidate[]) => [...new Set(cs.map((c) => c.text))];

  /**
   * 行の品目を、父が言った語で呼ぶ（行の根拠の時間にある、その品目の候補）。無ければ行の品目名。
   * 同じ品目の語が 2 つあれば（「履き替え、脱着4本」）、同じ発話の数に近い方。
   */
  const spoken = (line: Line): string => {
    const { startSec, endSec } = line.provenance;
    const hits = candidates.filter((c) => {
      if (c.kind !== "item" || (c.ledgerItem ?? c.text) !== line.item) return false;
      const s = t.segments[c.seg];
      return s !== undefined && s.startSec >= startSec && s.endSec <= endSec;
    });
    const distance = (c: Candidate) =>
      Math.min(
        Infinity,
        ...candidates
          .filter((n) => n.seg === c.seg && (n.kind === "qty" || n.kind === "bareNumber"))
          .map((n) => Math.abs(n.start - c.end)),
      );
    const best = hits.reduce<Candidate | null>((b, c) => (b === null || distance(c) < distance(b) ? c : b), null);
    return best?.text ?? line.item;
  };
  const qtyText = (line: Line) => (line.qty === null ? null : `${line.qty}${line.unit ?? ""}`);
  const choice = (vals: string[]) =>
    vals.length === 2 ? `${vals[0]}と${vals[1]}のどちらですか` : `${vals.slice(0, 3).join("・")}のどれですか`;

  const lineText = (line: Line, reason: QuestionReason, cs: Confirmation[]): string => {
    const name = spoken(line);
    const mine = cs.filter((c) => reasonOf(c) === reason);
    switch (reason) {
      case "negation": {
        const v = distinctTexts(related(mine).filter((c) => c.kind === "qty"))[0] ?? qtyText(line);
        const verb = line.item.endsWith("交換") ? "替えなかった" : "やらなかった";
        return `${name}${v ? `の${v}` : ""}は${verb}のですか`;
      }
      case "correction": {
        const explicit = mine.filter((c) => !c.message.includes("使われない数"));
        const q = qtyText(line);
        if (explicit.length === 0 && q !== null) {
          const others = distinctTexts(related(mine)).filter((x) => x !== q);
          if (others.length) return `${name}は${q}ですか。${others.slice(0, 2).join("・")}は何の数ですか`;
        }
        const vals = distinctTexts(related(mine));
        if (vals.length === 0 && q !== null) vals.push(q);
        if (vals.length === 0) return `${name}の数はいくつですか`;
        if (vals.length === 1) return `${name}は${vals[0]}で合っていますか`;
        return `${name}は${choice(vals)}`;
      }
      case "unparsed":
        return `${name}の数が聞き取れません。いくつですか`;
      case "qty": {
        const unit = line.ledger.unit ?? line.unit;
        return unit ? `${name}は何${unit}ですか` : `${name}はいくつですか`;
      }
      case "unitPrice":
        return `${name}の単価はいくらですか`;
      case "unit":
        return line.ledger.unit ? `${name}は何${line.ledger.unit}ですか` : `${name}の単位は何ですか`;
      case "ledger":
        if (mine.some((c) => c.message.includes("二重"))) return `${name}が2行あります。別の作業ですか`;
        return `${name}は料金表のどの品目ですか`;
      case "total":
      case "other":
        return `${name}は、言ったとおりで合っていますか`;
    }
  };

  const globalText = (reason: QuestionReason, cs: Confirmation[]): string => {
    const rel = related(cs);
    const items = [...new Set(cs.map((c) => c.item))];
    switch (reason) {
      case "unparsed":
        return items.length === 1
          ? `「${items[0]}」は何と言いましたか`
          : `聞き取れない数が${items.length}か所あります。何と言いましたか`;
      case "unitPrice":
        return `${distinctTexts(rel).slice(0, 2).join("・") || items[0]}はどの作業の値段ですか`;
      case "ledger": {
        const names = distinctTexts(rel.filter((c) => c.kind === "item"));
        return `${(names.length ? names : items).slice(0, 3).join("・")}もやりましたか`;
      }
      case "total": {
        if (cs.some((c) => c.message.includes("作業が 1 つもない"))) return "請求する作業はありませんか";
        const said = rel.find((c) => c.kind === "total" && c.taxIncluded !== true);
        if (said && said.value !== null) {
          const amounts = result.lines.map((l) => l.amount);
          const computed = amounts.every((a): a is number => a !== null) ? amounts.reduce((s, a) => s + a, 0) : null;
          return computed === null
            ? `合計は${said.value}円で合っていますか`
            : `合計は${said.value}円と${computed}円のどちらですか`;
        }
        return "税込みの合計は確かめられません。税抜きでいくらですか";
      }
      default:
        return `「${items[0]}」は、どういうことですか`;
    }
  };

  const make = (lineIndex: number, cs: Confirmation[], text: (reason: QuestionReason) => string, item: string) => {
    const reasons = [...new Set(cs.map(reasonOf))].sort((a, b) => rank(a) - rank(b));
    const reason = reasons[0];
    return { lineIndex, item, reason, reasons, text: text(reason), confirmations: cs };
  };

  const out: Question[] = [];
  const lineIndexes = [...new Set(result.confirmations.map((c) => c.lineIndex).filter((i) => i >= 0))].sort(
    (a, b) => a - b,
  );
  for (const li of lineIndexes) {
    const cs = result.confirmations.filter((c) => c.lineIndex === li);
    const line = result.lines[li];
    if (line === undefined) {
      // 行の無い添字（起きないはず）。落とさずに、その他として聞く
      out.push(make(li, cs, () => `「${cs[0].item}」は、どういうことですか`, cs[0].item));
      continue;
    }
    out.push(make(li, cs, (r) => lineText(line, r, cs), line.item));
  }
  const globals = result.confirmations.filter((c) => c.lineIndex < 0);
  for (const reason of QUESTION_REASONS) {
    const cs = globals.filter((c) => reasonOf(c) === reason);
    if (cs.length === 0) continue;
    out.push(make(-1, cs, (r) => globalText(r, cs), [...new Set(cs.map((c) => c.item))].join("・")));
  }
  return out;
}
