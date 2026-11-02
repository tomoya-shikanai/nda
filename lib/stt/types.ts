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

export interface SttAdapter {
  readonly name: string;
  transcribe(audioPath: string, opts: { glossary: string[] }): Promise<Transcript>;
}
