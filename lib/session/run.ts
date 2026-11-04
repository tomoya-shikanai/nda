/**
 * 文字起こしを受けて、明細と質問を作り、作業 1 件の状態を保存する（W2）。
 * 抽出の前に thinking を書くので、モニターは「考え中」を見られる。
 * 確認事項が 0 件でも asking で止める。done にするのは承認だけ（W4）。
 * 抽出の失敗は固定の文と例外の種類名だけを保存する。抽出のトークン数とかかった秒数を保存する（文の中身は入れない。事前登録の副の指標）。
 */
import { randomUUID } from "node:crypto";
import { assembleInvoice } from "../invoice/build";
import type { Candidate } from "../invoice/candidates";
import { extractInvoice } from "../invoice/extract";
import { toQuestions } from "../invoice/questions";
import type { InvoiceRefs } from "../invoice/schema";
import type { LedgerEntry } from "../ledger/lookup";
import { type Transcript, TranscriptSchema } from "../stt/types";
import { type ExtractionCost, newSession, type Session, transition, writeSession } from "./store";

/** POST の body の文字起こしの形。正は lib/stt/types.ts。 */
export { TranscriptSchema };

/** 抽出の結果。usage は Messages API のトークン数（費用の記録用。偽の extractor は省いてよい）。 */
export type Extracted = { candidates: Candidate[] } & InvoiceRefs & { usage?: { inputTokens: number; outputTokens: number } };
export type Extractor = (t: Transcript, ledger: LedgerEntry[]) => Promise<Extracted>;

/** 抽出の失敗として保存する文。SDK の文（要求の中身やキーの手がかりが入り得る）は入れず、例外の種類名だけを足す。 */
export function extractionError(e: unknown): string {
  const kind = e instanceof Error ? e.constructor.name || e.name : typeof e;
  return `抽出に失敗しました（${kind}）`;
}

export async function startSession(x: {
  dir: string;
  transcript: Transcript;
  ledger: LedgerEntry[];
  extract?: Extractor;
  now?: () => Date;
  id?: string;
}): Promise<Session> {
  const now = x.now ?? (() => new Date());
  const extract = x.extract ?? extractInvoice;
  let s = newSession(x.id ?? randomUUID(), now());
  s = transition(s, "listening", now());
  s = { ...transition(s, "thinking", now()), transcript: x.transcript };
  await writeSession(x.dir, s);

  let out: Extracted;
  const t0 = performance.now();
  const cost = (usage?: Extracted["usage"]): ExtractionCost => ({
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    seconds: (performance.now() - t0) / 1000,
  });
  try {
    out = await extract(x.transcript, x.ledger);
  } catch (e) {
    const failed = { ...transition(s, "idle", now()), error: extractionError(e), extraction: cost() };
    await writeSession(x.dir, failed);
    throw e;
  }
  const extraction = cost(out.usage);

  const { candidates, ...refs } = out;
  const invoice = assembleInvoice(out, x.transcript, x.ledger);
  const questions = toQuestions(invoice, candidates, x.transcript, x.ledger);
  s = {
    ...transition(s, "drafting", now()),
    candidates,
    refs: { lines: refs.lines, negations: refs.negations },
    invoice,
    questions,
    extraction,
  };
  await writeSession(x.dir, s);
  s = transition(s, "asking", now());
  await writeSession(x.dir, s);
  return s;
}
