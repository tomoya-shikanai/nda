/**
 * 事務所が返した客の label（姓と車種、§9-1）は画面に出すだけで、作業ファイルにもログにも残さない。
 * プロセスのメモリにだけ持つ（再起動で消え、そのときの画面は「お客様: 決まりました」）。
 * route ごとにモジュールが分かれても同じ入れ物を使うよう globalThis に置く。
 */
const KEY = Symbol.for("nda.office.labels");
type Store = Map<string, string>;

function store(): Store {
  const g = globalThis as unknown as Record<symbol, Store | undefined>;
  g[KEY] ??= new Map();
  return g[KEY];
}

export function setLabel(sessionId: string, label: string | null): void {
  if (label === null || label.trim() === "") store().delete(sessionId);
  else store().set(sessionId, label);
}

export function getLabel(sessionId: string | null): string | null {
  return sessionId === null ? null : (store().get(sessionId) ?? null);
}

/** 試験用。 */
export function clearLabels(): void {
  store().clear();
}
