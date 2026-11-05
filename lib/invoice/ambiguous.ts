/**
 * 言い換えの言葉（料金表の 2 つ以上の品目のどれか分からない言葉。「タイヤ交換」→ 脱着か組替か）の行を補う（#46）。
 * 純粋な関数。API を呼ばない、入力を書き換えない。
 *
 * 発話に言い換えの言葉があり、モデルがその言葉の行も、同じ発話の選択肢の品目の行も作らず、否定の文でもないとき、
 * その言葉の item 候補を指す行を 1 つ足す。数量は、その言葉と同じ文（。！？で区切る）の中で、その言葉の後・次の品目の語の前にある
 * 最初の数量の候補（ほかの行が使っていなければ）。別の文の数量は使わない（「倉庫にはタイヤ4本ある」を作業の本数にしない）。
 * 取れなければ null で、品目を選んだ後に本数を聞く。
 * 足した行は料金表で「別名があいまい」の確認事項になり、父が品目を選ぶまで金額を出さない（品目を推測で決めない）。
 * 足した参照は抽出の参照と一緒に作業に保存する（答えの後の組み直しが同じ行を作るため）。
 */
import { choicesOf, type LedgerEntry } from "../ledger/lookup";
import type { Transcript } from "../stt/types";
import type { Candidate } from "./candidates";
import { normalizeText } from "./candidates";
import { sentenceAt } from "./resolve";
import type { InvoiceRefs, LineRef } from "./schema";

export function addAmbiguousLines(
  x: { candidates: Candidate[] } & InvoiceRefs,
  t: Transcript,
  ledger: LedgerEntry[],
): InvoiceRefs {
  const byId = new Map(x.candidates.map((c) => [c.id, c]));
  const lines: LineRef[] = x.lines.map((l) => ({ ...l, evidence: [...l.evidence] }));
  for (const c of x.candidates) {
    if (c.kind !== "item" || c.ledgerItem !== undefined) continue;
    const choices = choicesOf(ledger, c.text);
    if (choices.length === 0) continue;
    if (x.negations.some((n) => n.seg === c.seg)) continue;
    const names = new Set(choices.map((e) => e.item));
    const covered = lines.some((l) => {
      if (typeof l.item !== "string") return l.item.seg === c.seg && normalizeText(l.item.text).includes(c.text);
      if (l.item === c.id) return true;
      const ic = byId.get(l.item);
      return ic !== undefined && ic.seg === c.seg && ic.ledgerItem !== undefined && names.has(ic.ledgerItem);
    });
    if (covered) continue;
    const used = new Set(lines.map((l) => l.qty).filter((q): q is string => q !== null));
    // 候補の位置は正規化後の発話の文字位置（candidates.ts）
    const sentence = sentenceAt(normalizeText(t.segments[c.seg]?.text ?? ""), c.start, c.end);
    const nextItem = x.candidates.find((o) => o.kind === "item" && o.seg === c.seg && o.start >= c.end);
    const qty = x.candidates.find(
      (o) =>
        o.kind === "qty" &&
        o.seg === c.seg &&
        o.start >= c.end &&
        o.end <= sentence.end &&
        (nextItem === undefined || o.start < nextItem.start),
    );
    lines.push({
      item: c.id,
      qty: qty !== undefined && !used.has(qty.id) ? qty.id : null,
      unitPrice: null,
      amount: null,
      status: "done",
      evidence: [],
      correctedFrom: null,
      correctedTo: null,
    });
  }
  return { lines, negations: x.negations.map((n) => ({ ...n })) };
}
