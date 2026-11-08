/**
 * 作業の客（#45・#25）。客は事務所が照合して番号で返す（customer.answer）。客が決まるまでは承認できない（確認事項として数える）。
 * 純粋な関数。node の API を使わない（画面からも読む）。作業に保存するのは客と車の番号だけ。
 */
import type { Question } from "../invoice/questions";

/**
 * 行が 0 件のときの質問（客を聞かない作業。lib/invoice/questions.ts が使う）。客を聞く作業は ASK_WORK に置き換える。
 * 画面からも読むので、node の API を読む questions.ts でなくここに置く。
 */
export const NO_WORK_QUESTION = "請求する作業はありませんか";

/** 客を聞く質問（候補の名前・ナンバーは出さない）。 */
export const CUSTOMER_QUESTION = "お客様の名前とナンバーの下4桁をお願いします";

type CustomerFields = {
  customerRequired: boolean;
  customer: { customerNo: string; carNo: string } | null;
  /** 声の指示の道（#56）で客の手がかりを受けた時刻。あれば客は決まったものとして扱う（客と車は事務所が決める）。 */
  customerClueAt?: string | null;
  /** 照合の問い合わせ（query の道）。あれば客は言われている（照合中・届かない等）。 */
  customerQuery?: unknown;
};

/** 客の照合が有効で、まだ決まっていないか（番号も手がかりも無い）。 */
export const customerPending = (s: CustomerFields): boolean => s.customerRequired && s.customer === null && !s.customerClueAt;

/** 明細の確認事項の数に、客が未定なら 1 を足した数。承認・done・画面の承認待ちはこれで見る。 */
export function pendingCount(s: CustomerFields & { invoice: { confirmations: unknown[] } | null }): number {
  return (s.invoice?.confirmations.length ?? 0) + (customerPending(s) ? 1 : 0);
}

/** 客を聞く作業で、明細が 0 行のときの質問（父は「客 → 作業 → 請求書頼む」の順で話す）。 */
export const ASK_WORK = "作業を教えてください";

/**
 * 客が未定なら客を聞く質問を足す。客をまだ一度も言っていなければ（手がかりも問い合わせも無い）一番先に（父はまず客を言う）、
 * 問い合わせ済み（照合中・届かない・決まらない）なら明細の質問の後ろに（ほかの質問を続けられる）。
 * 客を聞く作業（customerRequired）では、行が 0 件の質問「請求する作業はありませんか」を「作業を教えてください」にする。
 */
export function withCustomerQuestion(questions: Question[], s: CustomerFields): Question[] {
  const rest = questions
    .filter((q) => q.reason !== "customer")
    .map((q) => (s.customerRequired && q.reason === "total" && q.text.startsWith(NO_WORK_QUESTION) ? { ...q, text: ASK_WORK + q.text.slice(NO_WORK_QUESTION.length) } : q));
  if (!customerPending(s)) return rest;
  const q: Question = { lineIndex: -1, item: "お客様", reason: "customer", reasons: ["customer"], text: CUSTOMER_QUESTION, confirmations: [] };
  return s.customerQuery ? [...rest, q] : [q, ...rest];
}
