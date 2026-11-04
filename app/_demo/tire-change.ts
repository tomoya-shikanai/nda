// 試作の画面で使う架空のタイヤ交換。客・車両・値段はすべて架空（docs/anonymization.md の仮名）。
// 本物の料金表ではない。値段の分からない行は price: null のまま確認事項に回す。

export type DemoItem = {
  name: string;
  qty: number;
  unit: string;
  price: number | null;
  /** どの発話から取ったか */
  source: string;
};

export const HEARD = "タイヤ 4 本、組替とバランス。廃タイヤも 4 本。バルブも替えた";

export const ITEMS: DemoItem[] = [
  { name: "タイヤ組替（脱着込み）", qty: 4, unit: "本", price: 2200, source: "タイヤ 4 本、組替" },
  { name: "ホイールバランス調整", qty: 4, unit: "本", price: 1100, source: "とバランス" },
  { name: "廃タイヤ処分", qty: 4, unit: "本", price: 330, source: "廃タイヤも 4 本" },
  { name: "エアバルブ交換", qty: 4, unit: "個", price: null, source: "バルブも替えた" },
];

/** 確認事項に整備士が答えた後の値（架空） */
export const ANSWERED_VALVE_PRICE = 330;

export const CUSTOMER = { name: "顧客A 様", vehicle: "車両001（軽自動車）", work: "冬タイヤへの交換" };

export const TAX_RATE = 0.1;

export function yen(n: number): string {
  return `¥${n.toLocaleString("ja-JP")}`;
}
