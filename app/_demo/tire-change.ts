// 試作の画面で使う架空のタイヤ交換。客・車両・値段はすべて架空（docs/anonymization.md の仮名）。
// 本物の料金表ではない。品目名・単位・単価は試験用の架空の料金表（tests/fixtures/tire-ledger.json）と同じ書き方。
// 数の分からない行は qty: null のまま確認事項に回す（docs/decisions.md 2026-11-04「本数だけを 1 問聞き返す」）。

export type DemoItem = {
  name: string;
  /** null なら発話から数が分からない（確認事項で聞き返す） */
  qty: number | null;
  unit: string;
  /** 架空の料金表の単価 */
  price: number;
  /** どの発話から取ったか */
  source: string;
};

export const HEARD = "タイヤ4本、組替とバランスだ。廃タイヤも4本、処分してけって。バルブも替えた。";

export const ITEMS: DemoItem[] = [
  { name: "タイヤ組替", qty: 4, unit: "本", price: 1650, source: "タイヤ4本、組替" },
  { name: "ホイールバランス", qty: 4, unit: "本", price: 1100, source: "とバランスだ" },
  { name: "廃タイヤ処分", qty: 4, unit: "本", price: 330, source: "廃タイヤも4本" },
  { name: "エアバルブ交換", qty: null, unit: "本", price: 330, source: "バルブも替えた" },
];

/** 確認事項に整備士が答えた後の数（架空） */
export const ANSWERED_VALVE_QTY = 4;

export const CUSTOMER = { name: "顧客A 様", vehicle: "車両001（軽自動車）", work: "冬タイヤへの交換" };

export const TAX_RATE = 0.1;

export function yen(n: number): string {
  return `¥${n.toLocaleString("ja-JP")}`;
}
