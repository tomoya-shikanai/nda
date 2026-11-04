/**
 * 作業の客（#45）。客が決まるまでは承認できない（確認事項として数える）。純粋な関数。node の API を使わない（画面からも読む）。
 * 作業に保存するのは客の id だけ。名前と車は表示のときに一覧から引く。
 */
import type { Customer } from "../customer/match";
import type { Question } from "../invoice/questions";

/** 客を聞く質問（候補の名前・ナンバーは出さない）。 */
export const CUSTOMER_QUESTION = "お客様の名前とナンバーの下4桁をお願いします";

type CustomerFields = { customerRequired: boolean; customerId: string | null };

/** 客の照合が有効で、まだ決まっていないか。 */
export const customerPending = (s: CustomerFields): boolean => s.customerRequired && s.customerId === null;

/** 明細の確認事項の数に、客が未定なら 1 を足した数。承認・done・画面の承認待ちはこれで見る。 */
export function pendingCount(s: CustomerFields & { invoice: { confirmations: unknown[] } | null }): number {
  return (s.invoice?.confirmations.length ?? 0) + (customerPending(s) ? 1 : 0);
}

/** 明細の質問の後ろに、客が未定なら客を聞く質問を足す（明細の質問を先に聞く）。 */
export function withCustomerQuestion(questions: Question[], s: CustomerFields): Question[] {
  const rest = questions.filter((q) => q.reason !== "customer");
  if (!customerPending(s)) return rest;
  return [...rest, { lineIndex: -1, item: "お客様", reason: "customer", reasons: ["customer"], text: CUSTOMER_QUESTION, confirmations: [] }];
}

/** 画面に出す客（一覧から id で引く）。一覧に無い・未定なら null。 */
export function customerView(id: string | null, customers: Customer[] | null): { name: string; car: string } | null {
  const c = id === null ? undefined : customers?.find((x) => x.id === id);
  return c ? { name: c.name, car: c.car } : null;
}
