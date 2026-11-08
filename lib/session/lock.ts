/**
 * 作業ごとの排他（#47 のうち、Node の 1 プロセスの中の分）。作業ファイルを読んで書く経路は、すべてこの中で読み直してから書く。
 * 待ち行列で順に動かす（非同期の mutex）。同じ作業の中から呼び直しても待たない（AsyncLocalStorage で持っている鍵を覚える）。
 * プロセスをまたぐ排他は持たない（工場の本体は 1 プロセスで動かす前提。docs/design/pi-office.md の注）。
 */
import { AsyncLocalStorage } from "node:async_hooks";

const KEY = Symbol.for("nda.session.locks");
type Locks = { tails: Map<string, Promise<void>>; held: AsyncLocalStorage<ReadonlySet<string>> };

function locks(): Locks {
  const g = globalThis as unknown as Record<symbol, Locks | undefined>;
  g[KEY] ??= { tails: new Map(), held: new AsyncLocalStorage() };
  return g[KEY];
}

/** 作業 id の排他の中で f を動かす。同じ id を持っている中からの呼び直しはそのまま動かす。 */
export async function withSessionLock<T>(id: string, f: () => Promise<T>): Promise<T> {
  const l = locks();
  const held = l.held.getStore() ?? new Set<string>();
  if (held.has(id)) return f();
  const prev = l.tails.get(id) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const tail = prev.then(() => mine);
  l.tails.set(id, tail);
  await prev;
  try {
    return await l.held.run(new Set([...held, id]), f);
  } finally {
    release();
    if (l.tails.get(id) === tail) l.tails.delete(id);
  }
}

/**
 * 持っている鍵を外した文脈で f を動かす（期限の後に遅れて終わった書き込みの後始末など、排他の外で後から走る処理のため。
 * そのままでは呼んだ時の鍵を受け継ぎ、排他を取らずに書いてしまう）。
 */
export function outsideSessionLocks<T>(f: () => T): T {
  return locks().held.exit(f);
}
