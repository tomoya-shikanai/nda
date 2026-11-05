/**
 * 工場→事務所の受け箱への置き方（docs/design/pi-office.md §2・§6）と、作業への配線（照合の問い合わせ・承認後の依頼・期限・送り直し）。
 * 置き方は差し替えられる（BoxWriter）。本番もローカルのフォルダ（NDA_OFFICE_BOX）: 事務所の PC の共有（SMB）を工場が mount した先に、
 * .<名前>.tmp で書いて rename する（§9-4）。mount が外れていると mount 先はただの空のフォルダになり、書けてしまうので、
 * 受け箱に目印のファイル（.nda-box。事務所側が置く）があることを毎回確かめる。フォルダや目印が無ければ BoxMissingError、
 * 書き込みの失敗は BoxWriteError（画面の札を分ける）。受け箱のフォルダは工場が作らない（外れた mount 先に作ってしまうため）。
 * sftp（NDA_OFFICE_SFTP）は口だけで、置かずに失敗する（§9-4 で使わなくなった。同じ LAN でない場合の控え）。
 *
 * 問い合わせの said（原文）は、受け箱に書くためのメモリの上だけに置く。作業ファイルにもログにも書かない。
 * 作業ファイルの読み書きは「読む → 当てる → 書く」で、同時の書き込みのロックはまだ無い（#47）。
 */
import { randomBytes, randomUUID } from "node:crypto";
import { access, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readSession, type Session, writeSession } from "../session/store";
import {
  beginSending,
  buildInvoiceRequest,
  expireQuery,
  markRetrying,
  markSendFailed,
  markSent,
  queryUnreachable,
  sendError,
  shouldResend,
} from "./flow";
import { boxFileName, type CustomerQuery, type ToOffice, ToOffice as ToOfficeSchema } from "./schema";

/** 受け箱に 1 件置く。失敗は throw。 */
export type BoxWriter = { readonly kind: string; put(name: string, body: string): Promise<void> };

/** 置くのを待つ上限（§4: 5 秒以内に失敗を知る）。 */
export const PUT_TIMEOUT_MS = 5000;

/** 受け箱にあるはずの目印のファイル（事務所側が置く。mount が外れていないことの確かめ）。 */
export const BOX_MARKER = ".nda-box";

/** 受け箱が見えない（フォルダが無い・フォルダでない・目印が無い＝mount が外れている）。 */
export class BoxMissingError extends Error {}
/** 受け箱は見えるが書けない（権限・容量・共有の切断など）。 */
export class BoxWriteError extends Error {}

export type FolderBoxOptions = {
  /**
   * 受け箱が mount した先にあることを確かめる（既定は真。本番）。偽の事務所・試験の一時フォルダは mount した先でないので偽にする
   * （NDA_OFFICE_BOX_REQUIRE_MOUNT=0）。確かめ方: 受け箱の dev が rootDir（既定 /）の dev と違う。
   */
  requireMount?: boolean;
  rootDir?: string;
  /** 試験用: .tmp を書いた後、rename の前に呼ぶ（その間に unmount された場合を作る）。 */
  beforeCommit?: () => Promise<void>;
};

/**
 * ローカルのフォルダ（本番は SMB の共有を mount した先。Mac の中の偽の事務所・試験も同じ）。.<名前>.<乱数>.tmp に書いて rename。
 * 書く前に、フォルダ・目印・mount を確かめる。書いて rename した後にも、置いたファイルが目印と同じ dev にあり目印がまだあることを
 * 確かめ、違えば（途中で unmount されてローカルに書いた）置いたファイルを消して BoxMissingError。.tmp の名前は書き手ごとに違う。
 */
export function folderBox(dir: string, opts: FolderBoxOptions = {}): BoxWriter {
  const requireMount = opts.requireMount ?? true;
  const rootDir = opts.rootDir ?? "/";
  const marker = join(dir, BOX_MARKER);
  return {
    kind: "folder",
    async put(name, body) {
      let rootDev: number | null = null;
      try {
        if (!(await stat(dir)).isDirectory()) throw new Error("not a directory");
        await access(marker);
        if (requireMount) {
          rootDev = (await stat(rootDir)).dev;
          if ((await stat(dir)).dev === rootDev) throw new Error("not mounted");
        }
      } catch {
        throw new BoxMissingError("受け箱が見えない");
      }
      const tmp = join(dir, `.${name}.${randomBytes(6).toString("hex")}.tmp`);
      const final = join(dir, name);
      try {
        await writeFile(tmp, body, { encoding: "utf8", mode: 0o600 });
        await opts.beforeCommit?.();
        await rename(tmp, final);
      } catch {
        await rm(tmp, { force: true }).catch(() => {});
        throw new BoxWriteError("受け箱に書けない");
      }
      try {
        const [f, m] = await Promise.all([stat(final), stat(marker)]);
        if (f.dev !== m.dev || (rootDev !== null && f.dev === rootDev)) throw new Error("moved");
      } catch {
        await rm(final, { force: true }).catch(() => {});
        throw new BoxMissingError("書いている間に受け箱が見えなくなった");
      }
    },
  };
}

/** NDA_OFFICE_BOX_REQUIRE_MOUNT が 0・false・no なら mount を確かめない（偽の事務所・試験）。既定は確かめる。 */
export const requireMountFromEnv = (env: NodeJS.ProcessEnv) => !/^(0|false|no)$/i.test(env.NDA_OFFICE_BOX_REQUIRE_MOUNT ?? "");

/** 置けなかった理由の種類（画面の札を分ける）。 */
export const unreachableReason = (e: unknown): "boxMissing" | "writeFailed" =>
  e instanceof BoxMissingError ? "boxMissing" : "writeFailed";

/**
 * sftp の口（NDA_OFFICE_SFTP=ユーザー@ホスト:受け箱のパス）。§9-4 で運び道は LAN の共有フォルダになったので作らない
 * （同じ LAN でない場合の控え）。置かずに失敗する。
 */
export function sftpBox(target: string): BoxWriter {
  return {
    kind: "sftp",
    async put() {
      throw new Error(`sftp での受け箱はまだ作っていない（${target.split(":")[0] ? "設定あり" : "設定なし"}）`);
    },
  };
}

export type OfficeLink = { box: BoxWriter; timeoutMs: number };

/** 環境変数から。NDA_OFFICE_BOX（フォルダ）か NDA_OFFICE_SFTP。どちらも無ければ null（事務所なし。客の照合もしない）。 */
export function officeFromEnv(env: NodeJS.ProcessEnv = process.env): OfficeLink | null {
  if (env.NDA_OFFICE_BOX) {
    return { box: folderBox(env.NDA_OFFICE_BOX, { requireMount: requireMountFromEnv(env) }), timeoutMs: PUT_TIMEOUT_MS }; // 既定（§9-4）
  }
  if (env.NDA_OFFICE_SFTP) return { box: sftpBox(env.NDA_OFFICE_SFTP), timeoutMs: PUT_TIMEOUT_MS };
  return null;
}

/** 形を確かめてから、期限つきで受け箱に置く。 */
export async function putMessage(link: OfficeLink, m: ToOffice): Promise<void> {
  const msg = ToOfficeSchema.parse(m);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("受け箱に置くのが期限を過ぎた")), link.timeoutMs);
  });
  try {
    await Promise.race([link.box.put(boxFileName(msg), JSON.stringify(msg)), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** 作業を読み直して f を当てて書く（ほかの route が先に書いた分を消さない）。作業が無ければ null。 */
export async function updateSession(dir: string, id: string, f: (s: Session) => Session): Promise<Session | null> {
  const s = await readSession(dir, id);
  if (s === null) return null;
  const next = f(s);
  if (next !== s) await writeSession(dir, next);
  return next;
}

/**
 * 照合の問い合わせを置く（作業には先に pending を書いておくこと。答えが置くより早く着いても当てられるように）。
 * 置けなければ、その問い合わせを今も待っているときだけ unreachable にする。
 */
export async function sendQuery(dir: string, link: OfficeLink, q: CustomerQuery): Promise<boolean> {
  try {
    await putMessage(link, q);
    return true;
  } catch (e) {
    await updateSession(dir, q.sessionId, (s) => queryUnreachable(s, q.id, new Date(), unreachableReason(e)));
    return false;
  }
}

/** 置いて結果を作業に書く（sending → sent か、置けなければ sending のまま理由を残す）。 */
async function putRequest(dir: string, link: OfficeLink, s: Session, now: Date): Promise<Session> {
  const o = s.office;
  if (o === null) return s;
  const request = buildInvoiceRequest(s, o.requestId, now);
  if (request === null) return s;
  try {
    await putMessage(link, request);
    return (await updateSession(dir, s.id, (x) => markSent(x, o.requestId, now))) ?? s;
  } catch (e) {
    return (await updateSession(dir, s.id, (x) => markSendFailed(x, o.requestId, sendError(e), now))) ?? s;
  }
}

/** 承認した作業（done）の依頼をすぐ置く（§9-2）。done でなければ何もしない。 */
export async function submitInvoice(dir: string, link: OfficeLink, s: Session, now = new Date()): Promise<Session> {
  if (s.status !== "done") return s;
  const { session, request } = beginSending(s, randomUUID(), now);
  await writeSession(dir, session);
  if (request === null) return session;
  return putRequest(dir, link, session, now);
}

/** 作業ごとの送り直しのロック（同じプロセスの中で 1 本にする）。route ごとにモジュールが分かれても同じ入れ物を使う。 */
const LOCKS_KEY = Symbol.for("nda.office.resendLocks");
function resendLocks(): Set<string> {
  const g = globalThis as unknown as Record<symbol, Set<string> | undefined>;
  g[LOCKS_KEY] ??= new Set();
  return g[LOCKS_KEY];
}

/**
 * 画面の見回り（GET /api/session/current）のついで: 照合の期限切れと、依頼の送り直し（30 秒に 1 回、1 時間まで）。常駐は作らない。
 * 送り直しは作業ごとのロックで 1 本にし、ロックの中で作業ファイルを読み直して、送る時かを決め直す（同時の見回りで二重に送らない）。
 */
export async function tickOffice(dir: string, link: OfficeLink | null, s: Session, now = new Date()): Promise<Session> {
  let cur = s;
  const expired = expireQuery(cur, now);
  if (expired !== cur) cur = (await updateSession(dir, cur.id, (x) => expireQuery(x, now))) ?? expired;
  if (link === null || !shouldResend(cur, now)) return cur;
  const locks = resendLocks();
  if (locks.has(cur.id)) return cur; // ほかの見回りが送っている
  locks.add(cur.id);
  try {
    const fresh = await readSession(dir, cur.id);
    if (fresh === null || !shouldResend(fresh, now)) return fresh ?? cur;
    const marked = markRetrying(fresh, now);
    await writeSession(dir, marked);
    return await putRequest(dir, link, marked, now);
  } finally {
    locks.delete(cur.id);
  }
}
