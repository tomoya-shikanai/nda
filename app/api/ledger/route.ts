/**
 * モニター用: 言える作業の一覧（料金表の品目名・別名・単位・単価と、言い換えの言葉）。出所の欄は出さない（#46）。
 * 毎回動かす書き方は ../session/current/route.ts の注と同じ。
 */
import { ledgerPath, loadLedgerBook, publicLedger } from "../../../lib/ledger/lookup";

export async function GET(request: Request) {
  request.headers.has("accept"); // 毎回動かすための印
  const book = await loadLedgerBook(ledgerPath());
  return Response.json(publicLedger(book), { headers: { "cache-control": "no-store" } });
}
