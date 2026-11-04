/**
 * モニター用の 1 つの JSON（W2）。純粋な関数。入力を書き換えない。
 * 金額を推測で出さない。null は null のまま返し、「値段？」の表示は画面がする。
 */
import { keptLines } from "./kept";
import type { Session, SessionStatus } from "./store";

export const VOICE_CREDIT = "VOICEVOX:ずんだもん";

export type MonitorLine = {
  item: string;
  qty: number | null;
  unit: string | null;
  unitPrice: number | null;
  amount: number | null;
  status: "ok" | "ask";
  answered: string[];
};

export type MonitorView = {
  id: string | null;
  state: SessionStatus;
  heard: string | null;
  say: string;
  /**
   * 台詞の通し番号（作業の id・状態の遷移の数・答えの数）。台詞が同じでも、答えが読めなかったときなどに
   * 声を出し直せるよう、画面はこれが変わったときに声を鳴らす。
   */
  sayId: string;
  /** asking で確認事項が 0 件（承認の言葉を待っている）。画面の札と表情を「承認待ち」にする。 */
  awaitingApproval: boolean;
  lines: MonitorLine[];
  total: number | null;
  questions: string[];
  confirmationCount: number;
  approved: boolean;
  credit: typeof VOICE_CREDIT;
};

export const SAY = {
  idle: "待っています。手は整備のままで。",
  error: "うまく分けられませんでした。もう一度話してください",
  listening: "聞いています",
  thinking: "明細に分けています",
  drafting: "請求書を作っています",
  askApprove: "合っていれば「請求書頼む」と言ってください",
  /** 答えが読めなかった（unread）ときの前置き。続けて今の質問を言い直す。 */
  retry: (q: string) => `もう一度お願いします。${q}`,
  /** 確認事項が残っているのに承認の言葉を言ったとき。 */
  notYet: (q: string) => `まだ確かめたいことがあります。${q}`,
  done: (n: number) => `${n}行入れました。発行は人が押してください`,
} as const;

function sayOf(s: Session | null): string {
  if (s === null) return SAY.idle;
  if (s.error !== null) return SAY.error;
  switch (s.status) {
    case "idle":
      return SAY.idle;
    case "listening":
      return SAY.listening;
    case "thinking":
      return SAY.thinking;
    case "drafting":
      return SAY.drafting;
    case "asking": {
      const ask = s.questions[0]?.text ?? SAY.askApprove;
      // 最後の答えが読めなかった・承認の言葉が効かなかったなら、そう言ってから聞き直す
      const last = s.answers.at(-1);
      if (last?.action.kind !== "unread") return ask;
      return last.action.reason === "確認事項が残っている" ? SAY.notYet(ask) : SAY.retry(ask);
    }
    case "done":
      return SAY.done(s.invoice?.lines.length ?? 0);
  }
}

/** 金額の表示（¥3,300）。計算はしない。null は null のまま返す（「値段？」などの言葉は画面が選ぶ） */
export function yenText(n: number | null): string | null {
  return n === null ? null : `¥${n.toLocaleString("ja-JP")}`;
}

const NOT_ANSWERS = new Set(["unread", "approve", "continue"]);

export function toMonitorView(s: Session | null): MonitorView {
  const segs = s?.transcript?.segments ?? [];
  const confirmations = s?.invoice?.confirmations ?? [];
  const answers = s?.answers ?? [];
  // 答えの lineIndex は行を除く前の添字。明細の i 行目の元の添字で引く
  const kept = s?.refs ? keptLines(s.refs.lines.length, answers) : [];
  const lines: MonitorLine[] = (s?.invoice?.lines ?? []).map((l, i) => ({
    item: l.item,
    qty: l.qty,
    unit: l.unit,
    unitPrice: l.unitPrice,
    amount: l.amount,
    status: confirmations.some((c) => c.lineIndex === i) ? "ask" : "ok",
    answered: answers
      .filter((a) => kept[i] !== undefined && a.lineIndex === kept[i] && !NOT_ANSWERS.has(a.action.kind))
      .map((a) => a.provenance.quote),
  }));
  return {
    id: s?.id ?? null,
    state: s?.status ?? "idle",
    heard: segs.length ? segs.map((x) => x.text).join("") : null,
    say: sayOf(s),
    sayId: s === null ? "none" : `${s.id}:${s.history.length}:${s.answers.length}`,
    awaitingApproval: s?.status === "asking" && s.invoice !== null && confirmations.length === 0,
    lines,
    total: s?.invoice?.total ?? null,
    questions: (s?.questions ?? []).map((q) => q.text),
    confirmationCount: confirmations.length,
    approved: s?.approved ?? false,
    credit: VOICE_CREDIT,
  };
}
