/**
 * 客の手がかり（ナンバーの下 4 桁と、客の返事の原文からナンバーを除いた言葉。#56）は、声の指示を受け箱に置くまでメモリにだけ持つ。
 * 作業ファイルにもログにも書かない（customer.query の said と同じ扱い）。置けたら消す。再起動で消える（そのときは送らない）。
 * route ごとにモジュールが分かれても同じ入れ物を使うよう globalThis に置く（labels.ts と同じ）。
 */
export type CustomerClue = { plateNo: string; customerWords?: string };

const KEY = Symbol.for("nda.office.clues");
type Store = Map<string, CustomerClue>;

function store(): Store {
  const g = globalThis as unknown as Record<symbol, Store | undefined>;
  g[KEY] ??= new Map();
  return g[KEY];
}

export function setClue(sessionId: string, clue: CustomerClue): void {
  store().set(sessionId, clue);
}

export function getClue(sessionId: string): CustomerClue | null {
  return store().get(sessionId) ?? null;
}

export function dropClue(sessionId: string): void {
  store().delete(sessionId);
}

/** 試験用（再起動でメモリが消えた場合も作る）。 */
export function clearClues(): void {
  store().clear();
}
