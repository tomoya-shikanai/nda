/**
 * 文字起こしを受けて、明細と質問を作り、作業 1 件の状態を保存する（W2）。
 * 抽出の前に thinking を書くので、モニターは「考え中」を見られる。
 * 確認事項が 0 件でも asking で止める。done にするのは承認だけ（W4）。
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { assembleInvoice } from "../invoice/build";
import type { Candidate } from "../invoice/candidates";
import { extractInvoice } from "../invoice/extract";
import { toQuestions } from "../invoice/questions";
import type { InvoiceRefs } from "../invoice/schema";
import type { LedgerEntry } from "../ledger/lookup";
import type { Transcript } from "../stt/types";
import { newSession, type Session, transition, writeSession } from "./store";

/** POST の body の文字起こしの形（lib/stt/types.ts の Transcript）。 */
export const TranscriptSchema = z.object({
  recordingId: z.string().min(1),
  vendor: z.string(),
  language: z.literal("ja"),
  glossaryHint: z.boolean(),
  segments: z.array(
    z.object({
      startSec: z.number(),
      endSec: z.number(),
      speaker: z.string().nullable(),
      text: z.string(),
    }),
  ),
}) satisfies z.ZodType<Transcript>;

export type Extractor = (t: Transcript, ledger: LedgerEntry[]) => Promise<{ candidates: Candidate[] } & InvoiceRefs>;

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

  let out: { candidates: Candidate[] } & InvoiceRefs;
  try {
    out = await extract(x.transcript, x.ledger);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const failed = { ...transition(s, "idle", now()), error: message };
    await writeSession(x.dir, failed);
    throw e;
  }

  const { candidates, ...refs } = out;
  const invoice = assembleInvoice(out, x.transcript, x.ledger);
  const questions = toQuestions(invoice, candidates, x.transcript, x.ledger);
  s = {
    ...transition(s, "drafting", now()),
    candidates,
    refs: { lines: refs.lines, negations: refs.negations },
    invoice,
    questions,
  };
  await writeSession(x.dir, s);
  s = transition(s, "asking", now());
  await writeSession(x.dir, s);
  return s;
}
