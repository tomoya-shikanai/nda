/**
 * 工場→事務所の受け箱への置き方（docs/design/pi-office.md §2・§6）と、作業への配線（照合の問い合わせ・承認後の依頼・期限・送り直し）。
 * 置き方は差し替えられる（BoxWriter）。本番もローカルのフォルダ（NDA_OFFICE_BOX）: 事務所の PC の共有（SMB）を工場が mount した先に、
 * .<名前>.tmp で書いて rename する（§9-4）。mount が外れていると mount 先はただの空のフォルダになり、書けてしまうので、
 * 受け箱に目印のファイル（.nda-box。事務所側が置く）があることを毎回確かめる。フォルダや目印が無ければ BoxMissingError、
 * 書き込みの失敗は BoxWriteError（画面の札を分ける）。受け箱のフォルダは工場が作らない（外れた mount 先に作ってしまうため）。
 * sftp（NDA_OFFICE_SFTP）は口だけで、置かずに失敗する（§9-4 で使わなくなった。同じ LAN でない場合の控え）。
 *
 * 問い合わせの said（原文）と声の指示の手がかり（clues.ts）は、受け箱に書くためのメモリの上だけに置く。作業ファイルにもログにも書かない。
 * 作業ファイルの読み書きは「読む → 当てる → 書く」で、同時の書き込みのロックはまだ無い（#47）。
 */
import { randomBytes, randomUUID } from "node:crypto";
import { access, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logEvent, since } from "../log/events";
import { outsideSessionLocks, withSessionLock } from "../session/lock";
import { readSession, type Session, writeSession } from "../session/store";
import { dropClue, getClue } from "./clues";
import {
  beginInstruction,
  beginSending,
  buildEstimateInstruction,
  buildInvoiceRequest,
  expireQuery,
  markRetrying,
  markSendFailed,
  markSent,
  queryUnreachable,
  sendError,
  type SlipKind,
  shouldResend,
  stopNoClue,
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
  /** 試験用: rename の後、確かめの前に呼ぶ（事務所がすぐ取り込んだ場合・その間に unmount された場合を作る）。 */
  afterCommit?: (final: string) => Promise<void>;
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
          rootDev = (await stat(/*turbopackIgnore: true*/ rootDir)).dev;
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
      await opts.afterCommit?.(final);
      // 置いた後の確かめ: 目印がまだあり（mount を確かめるなら、その dev が / と違い）、置いたファイルがまだあれば目印と同じ dev。
      // 置いたファイルが無い（ENOENT）のは、事務所がすぐ取り込んだので成功とする
      try {
        const m = await stat(marker);
        if (rootDev !== null && m.dev === rootDev) throw new Error("not mounted");
        const f = await stat(final).catch((e: NodeJS.ErrnoException) => {
          if (e.code === "ENOENT") return null;
          throw e;
        });
        if (f !== null && f.dev !== m.dev) throw new Error("moved");
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

/**
 * 事務所とのやりとりの道（#56）。
 * - instruction（環境変数の既定）: 客の照合を問い合わせず、返事の 4 桁を手がかりとしてメモリに持ち、承認後に声の指示（estimate.instruction）を置く。
 *   事務所は返しを送らないので、置けたら sent のまま。
 * - query: 照合の問い合わせ（customer.query）と入力の依頼（invoice.request）の往復（§3〜§5）。
 * mode を書かずに組んだ OfficeLink は query（前からの試験）。本番は officeFromEnv が NDA_OFFICE_MODE から決める。
 */
export type OfficeMode = "instruction" | "query";
export type OfficeLink = { box: BoxWriter; timeoutMs: number; mode?: OfficeMode; slipKind?: SlipKind };

export const modeOf = (link: OfficeLink | null): OfficeMode => link?.mode ?? "query";

/**
 * 環境変数から。NDA_OFFICE_BOX（フォルダ）か NDA_OFFICE_SFTP。どちらも無ければ null（事務所なし。客の照合もしない）。
 * NDA_OFFICE_MODE=query なら往復の道、それ以外は声の指示の道。NDA_OFFICE_SLIP_KIND=estimate なら見積、それ以外は請求書。
 */
export function officeFromEnv(env: NodeJS.ProcessEnv = process.env): OfficeLink | null {
  const mode: OfficeMode = env.NDA_OFFICE_MODE === "query" ? "query" : "instruction";
  const slipKind: SlipKind = env.NDA_OFFICE_SLIP_KIND === "estimate" ? "estimate" : "invoice";
  if (env.NDA_OFFICE_BOX) {
    const box = folderBox(env.NDA_OFFICE_BOX, { requireMount: requireMountFromEnv(env) }); // 既定（§9-4）
    return { box, timeoutMs: PUT_TIMEOUT_MS, mode, slipKind };
  }
  if (env.NDA_OFFICE_SFTP) return { box: sftpBox(env.NDA_OFFICE_SFTP), timeoutMs: PUT_TIMEOUT_MS, mode, slipKind };
  return null;
}

/** 期限を過ぎた（元の書き込みはまだ走っているかもしれない）。 */
export class PutTimeoutError extends Error {}

/**
 * 作業ごとの「書き込み中」（依頼・声の指示の、元の書き込みの Promise）。期限を過ぎても元の書き込みは止まらないので、
 * それが終わるまで送り直しを始めない（同じ id を 2 回置かない）。route ごとにモジュールが分かれても同じ入れ物を使うよう globalThis に置く。
 */
const INFLIGHT = Symbol.for("nda.office.inflight");
function inflight(): Map<string, Promise<void>> {
  const g = globalThis as unknown as Record<symbol, Map<string, Promise<void>> | undefined>;
  g[INFLIGHT] ??= new Map();
  return g[INFLIGHT];
}
/** その作業の元の書き込みがまだ終わっていないか。 */
export const isWriting = (sessionId: string) => inflight().has(sessionId);
/** その作業の元の書き込み（と遅れて成功したときの後始末）が終わるまで待つ（試験用）。 */
export const writingDone = async (sessionId: string) => {
  await inflight().get(sessionId);
};

/** 形を確かめてから、期限つきで受け箱に置く。かかった ms と、置けなかった種類を記録する（中身は記録しない）。 */
export async function putMessage(link: OfficeLink, m: ToOffice, onPut?: (put: Promise<void>) => void): Promise<void> {
  const msg = ToOfficeSchema.parse(m);
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new PutTimeoutError("受け箱に置くのが期限を過ぎた"));
    }, link.timeoutMs);
  });
  const t0 = performance.now();
  const log = (error: "boxMissing" | "writeFailed" | "timeout" | null) =>
    logEvent("office.put", {
      sessionId: msg.sessionId,
      message: msg.kind,
      messageId: msg.id,
      attempt: msg.kind === "customer.query" ? null : msg.attempt,
      ms: since(t0),
      ok: error === null,
      error,
    });
  try {
    const put = link.box.put(boxFileName(msg), JSON.stringify(msg));
    onPut?.(put);
    await Promise.race([put, timeout]);
    log(null);
  } catch (e) {
    log(timedOut ? "timeout" : unreachableReason(e));
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** 作業の排他の中で読み直して f を当てて書く（ほかの route が先に書いた分を消さない）。作業が無ければ null。 */
export async function updateSession(dir: string, id: string, f: (s: Session) => Session): Promise<Session | null> {
  return withSessionLock(id, async () => {
    const s = await readSession(dir, id);
    if (s === null) return null;
    const next = f(s);
    if (next !== s) await writeSession(dir, next);
    return next;
  });
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

/**
 * 置いて結果を作業に書く（sending → sent か、置けなければ sending のまま理由を残す）。
 * 声の指示は、置くたびに承認済みの作業とメモリの手がかりから組み直す（id は同じ）。手がかりが消えていれば（再起動）送らずに stopped。
 * 置けたら手がかりを消す（送ったら持たない）。
 */
async function putRequest(dir: string, link: OfficeLink, s: Session, now: Date): Promise<Session> {
  const o = s.office;
  if (o === null) return s;
  let message: ToOffice | null;
  if (o.message === "estimate.instruction") {
    const clue = getClue(s.id);
    if (clue === null) return (await updateSession(dir, s.id, (x) => stopNoClue(x, now))) ?? s;
    message = buildEstimateInstruction(s, o.requestId, now, clue, o.slipKind ?? "invoice");
  } else {
    message = buildInvoiceRequest(s, o.requestId, now);
  }
  if (message === null || isWriting(s.id)) return s;
  const sent = message.kind === "estimate.instruction" ? () => dropClue(s.id) : () => {};
  // 期限を過ぎた後に元の書き込みが成功したら、排他の中で読み直して sent にする（手がかりも消す）。終わるまで「書き込み中」
  // 期限を過ぎたかは、この呼び出しの結果が決まってから見る（書き込みが期限の直後に終わっても取りこぼさない）
  let decide!: (timedOut: boolean) => void;
  const timedOut = new Promise<boolean>((r) => (decide = r));
  const track = (put: Promise<void>) => {
    const done = put.then(
      async () => {
        if (!(await timedOut)) return;
        await outsideSessionLocks(async () => {
          sent();
          await updateSession(dir, s.id, (x) => markSent(x, o.requestId, new Date()));
        });
      },
      () => {},
    );
    const tracked = done.catch(() => {}).finally(() => inflight().delete(s.id));
    inflight().set(s.id, tracked);
  };
  try {
    await putMessage(link, message, track);
    decide(false);
    sent();
    return (await updateSession(dir, s.id, (x) => markSent(x, o.requestId, now))) ?? s;
  } catch (e) {
    decide(e instanceof PutTimeoutError);
    return (await updateSession(dir, s.id, (x) => markSendFailed(x, o.requestId, sendError(e), now))) ?? s;
  }
}

/**
 * 承認した作業（done）の依頼（instruction の道では声の指示）をすぐ置く（§9-2・#56）。作業の排他の中で読み直し、done でなければ何もしない
 * （同時の承認・送り直しで、別 ID の依頼を 2 件置かない）。
 */
export async function submitInvoice(dir: string, link: OfficeLink, s: Session, now = new Date()): Promise<Session> {
  return withSessionLock(s.id, async () => {
    const cur = (await readSession(dir, s.id)) ?? s;
    if (cur.status !== "done") return cur;
    if (modeOf(link) === "instruction") {
      const { session, instruction } = beginInstruction(cur, randomUUID(), now, getClue(cur.id), link.slipKind ?? "invoice");
      await writeSession(dir, session);
      if (instruction === null) {
        dropClue(cur.id);
        return session;
      }
      return putRequest(dir, link, session, now);
    }
    const { session, request } = beginSending(cur, randomUUID(), now);
    await writeSession(dir, session);
    if (request === null) return session;
    return putRequest(dir, link, session, now);
  });
}

/**
 * 画面の見回り（GET /api/session/current）のついで: 照合の期限切れと、依頼の送り直し（30 秒に 1 回、1 時間まで）。常駐は作らない。
 * 作業の排他の中で作業ファイルを読み直して、期限と送る時かを決め直す（同時の見回りで二重に送らない）。何もすることが無ければ排他を取らない。
 */
export async function tickOffice(dir: string, link: OfficeLink | null, s: Session, now = new Date()): Promise<Session> {
  const due = (x: Session) => expireQuery(x, now) !== x || (link !== null && shouldResend(x, now));
  if (!due(s)) return s;
  return withSessionLock(s.id, async () => {
    let cur = await readSession(dir, s.id);
    if (cur === null) return s;
    const expired = expireQuery(cur, now);
    if (expired !== cur) {
      cur = expired;
      await writeSession(dir, cur);
    }
    // 前の書き込みが期限を過ぎてもまだ走っている間は送り直さない（同じ id を 2 回置かない）
    if (link === null || !shouldResend(cur, now) || isWriting(cur.id)) return cur;
    const marked = markRetrying(cur, now);
    await writeSession(dir, marked);
    return putRequest(dir, link, marked, now);
  });
}
