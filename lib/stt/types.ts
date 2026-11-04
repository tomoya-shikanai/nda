import { z } from "zod";

/** 文字起こしの共通形。ベンダに依存しない。 */
export type Segment = {
  startSec: number;
  endSec: number;
  speaker: string | null; // ベンダの話者分離結果。無ければ null（自前では分離しない）
  text: string;
};

export type Transcript = {
  recordingId: string;
  vendor: string;
  language: "ja";
  segments: Segment[];
  /** 語彙ヒントを渡したか。STT 比較の条件。 */
  glossaryHint: boolean;
};

const finite = z.number().refine(Number.isFinite, "有限の数でない");

export const SegmentSchema = z
  .object({
    startSec: finite,
    endSec: finite,
    speaker: z.string().nullable(),
    text: z.string().refine((s) => s.trim() !== "", "発話が空"),
  })
  .refine((s) => s.startSec <= s.endSec, "開始が終了より後") satisfies z.ZodType<Segment>;

/**
 * 文字起こしの形（STT の出口と POST の body で必ず通す）。各発話の時刻は有限で開始 ≤ 終了、
 * 発話の順に開始の時刻が逆転しない、発話が空でない。合わなければ throw（黙って捨てない・時刻を推測しない）。
 */
export const TranscriptSchema = z.object({
  recordingId: z.string().min(1),
  vendor: z.string(),
  language: z.literal("ja"),
  glossaryHint: z.boolean(),
  segments: z.array(SegmentSchema).superRefine((segs, ctx) => {
    for (let i = 1; i < segs.length; i++) {
      if (segs[i].startSec < segs[i - 1].startSec) {
        ctx.addIssue({ code: "custom", path: [i, "startSec"], message: "発話の順で時刻が逆転している" });
      }
    }
  }),
}) satisfies z.ZodType<Transcript>;

export interface SttAdapter {
  readonly name: string;
  transcribe(audioPath: string, opts: { glossary: string[] }): Promise<Transcript>;
}
