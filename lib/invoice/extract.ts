/**
 * 抽出（設計 docs/design/invoice-verify.md の (b)）。モデルは数字を書かず、候補の ID を指す。
 * 候補の ID はリクエストごとに zod の enum にするので、候補に無い ID は解釈の段で落ちる。
 * 値に戻すのと確認事項は resolveInvoice が行う。`verify.ts` は V4 で消すため import しない。
 */
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { claude, MODEL_MAIN } from "../claude";
import type { LedgerEntry } from "../ledger/lookup";
import type { Transcript } from "../stt/types";
import { type Candidate, type CandidateKind, enumerateCandidates } from "./candidates";
import { type InvoiceRefs, NegatedSentence } from "./schema";

const SYSTEM = `あなたは青森市の自動車整備工場で、父（整備士）の声から請求の明細の参照を作る書記です。
発話と、コードが発話から拾った候補（ID 付き）が渡されます。行ごとに候補の ID を指してください。
守ること:
- 数字を書かない。数量・単価・金額は、候補の ID で指す。
- 候補に無い数は指さない。その欄は null にする。推測で埋めない。
- 品目は item 候補の ID で指す。料金表の語が候補に無い品目だけ、発話の添字と発話の語を { seg, text } で書く。
- 津軽弁・俗称を標準語に直さない。{ seg, text } の text も、negations の text も、発話の原文のまま写す。
- 言っていない作業を行にしない。作業でないと判断した発話は行にしない。同じ作業を 2 行に分けない。
- 行ごとに status を付ける: done やった／negated 否定・取り消し・断り／corrected 言い直し／unsure 確かでない。
- status が done 以外なら、evidence にその判定の根拠の候補 ID を入れる。done なら evidence は空でよい。
- 言い直し（「4本、いや2本」の類）は status を corrected にし、correctedFrom に訂正前、correctedTo に訂正後の数の候補 ID を入れる。後の数を自分で選んで done にしない。言い直しでなければ correctedFrom・correctedTo は null。
- 否定・取り消し・断りに当たる文（「替えてない」「しません」「大丈夫です」「いいです」の類）は、行にしたかどうかによらず negations に全部挙げる。seg は発話の添字、text はその文を原文のまま。`;

/** 候補の ID の enum。0 件なら null だけ。 */
const idEnum = (ids: string[]) => (ids.length ? z.enum(ids as [string, ...string[]]) : null);

/** リクエストごとに、候補の ID だけを許すスキーマを作る。 */
export function refSchema(candidates: Candidate[]) {
  const ids = (kind: CandidateKind) => candidates.filter((c) => c.kind === kind).map((c) => c.id);
  const ref = (kind: CandidateKind) => {
    const e = idEnum(ids(kind));
    return e ? e.nullable() : z.null();
  };
  const word = z.object({ seg: z.number(), text: z.string() });
  const itemEnum = idEnum(ids("item"));
  const all = idEnum(candidates.map((c) => c.id));
  const line = z.object({
    item: (itemEnum ? z.union([itemEnum, word]) : word).describe(
      "品目。item 候補の ID か、料金表に無い品目なら発話の添字とその語（原文のまま）",
    ),
    qty: ref("qty").describe("数量の候補の ID。言っていなければ null"),
    unitPrice: ref("unitPrice").describe("単価の候補の ID。言っていなければ null"),
    amount: ref("amount").describe("金額の候補の ID。言っていなければ null"),
    status: z
      .enum(["done", "negated", "corrected", "unsure"])
      .describe("done やった／negated 否定・取り消し・断り／corrected 言い直し／unsure 確かでない"),
    evidence: (all ? z.array(all) : z.array(z.string()).max(0)).describe("判定の根拠の候補 ID。done 以外のとき入れる"),
    correctedFrom: (all ? all.nullable() : z.null()).describe("言い直しの訂正前の数の候補 ID。言い直しでなければ null"),
    correctedTo: (all ? all.nullable() : z.null()).describe("言い直しの訂正後の数の候補 ID。言い直しでなければ null"),
  });
  return z.object({
    lines: z.array(line).describe("発話で言った作業だけ。言っていない作業は入れない"),
    negations: z.array(NegatedSentence).describe("否定・取り消し・断りに当たる文を全部"),
  });
}

function candidateLine(c: Candidate): string {
  const ledger = c.kind === "item" && c.ledgerItem !== undefined ? `（料金表: ${c.ledgerItem}）` : "";
  return `${c.id} [#${c.seg}] ${c.text}${ledger}`;
}

export async function extractInvoice(
  t: Transcript,
  ledger: LedgerEntry[],
): Promise<{ candidates: Candidate[] } & InvoiceRefs> {
  const candidates = enumerateCandidates(t, ledger);
  const segs = t.segments.map((s, i) => `[#${i} ${s.startSec}-${s.endSec} ${s.speaker ?? "?"}] ${s.text}`);
  const text = [
    `録音 ID: ${t.recordingId}`,
    `発話（[#添字 開始-終了秒 話者] 発話）:\n${segs.join("\n")}`,
    candidates.length
      ? `候補（ID [#発話の添字] 文字列）:\n${candidates.map(candidateLine).join("\n")}`
      : "候補: なし",
  ].join("\n\n");

  const res = await claude().messages.parse({
    model: MODEL_MAIN,
    max_tokens: 8000,
    system: SYSTEM,
    messages: [{ role: "user", content: [{ type: "text", text }] }],
    output_config: { format: zodOutputFormat(refSchema(candidates)) },
  });
  if (!res.parsed_output) throw new Error(`参照の出力を解釈できない (stop_reason=${res.stop_reason})`);
  const out = res.parsed_output;
  return { candidates, lines: out.lines, negations: out.negations };
}
