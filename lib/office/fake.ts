/**
 * Mac の中だけで一周させる偽の事務所（docs/design/pi-office.md §6）。本物の事務所のプログラム（office/box、Python）は事務所の PC の担当。
 * ローカルのフォルダを受け箱にして見張り、customer.query には架空の一覧（tests/fixtures/customers.json）で照合して答え、
 * invoice.request には entered を返す（POST /api/office/reply）。estimate.instruction（#56）は消すだけで返さない（手がかりを残さない）。業務ソフトには触らない。
 * 答えた問い合わせのファイルは消す（said を残さない）。依頼は done/ に移す。
 */
import { mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { type Customer, identifyCustomer } from "../customer/match";
import { type CustomerAnswer, type CustomerQuery, type InvoiceRequest, type InvoiceResult, type ToFactory, ToOffice } from "./schema";

/** 照合の答え。両方合う 1 件だけ found。番号は架空の一覧の id と、それから作った車の番号。 */
export function answerQuery(q: CustomerQuery, customers: Customer[], now = new Date()): CustomerAnswer {
  const id = identifyCustomer(q.said, customers).customerId;
  const c = id === null ? undefined : customers.find((x) => x.id === id);
  const base = { v: 1 as const, id: randomUUID(), sessionId: q.sessionId, sentAt: now.toISOString(), kind: "customer.answer" as const, queryId: q.id };
  if (c === undefined) return { ...base, result: { status: "retry", reason: "none" } };
  const surname = c.name.split(/\s+/)[0];
  return { ...base, result: { status: "found", customerNo: c.id, carNo: `car-${c.id}`, label: `${surname}様・${c.car}` } };
}

/** 入力の結果。偽物は業務ソフトに触らず、全行を入れたことにする。 */
export function answerRequest(r: InvoiceRequest, now = new Date()): InvoiceResult {
  return {
    v: 1,
    id: randomUUID(),
    sessionId: r.sessionId,
    sentAt: now.toISOString(),
    kind: "invoice.result",
    requestId: r.id,
    outcome: "entered",
    enteredLines: r.lines.length,
    reason: null,
    readback: r.lines.map((l) => ({ item: l.item, qty: l.qty, unitPrice: l.unitPrice })),
    screenshotFile: null,
  };
}

export type FakeOffice = {
  box: string;
  customers: Customer[];
  /** 返しを工場に送る（POST /api/office/reply）。 */
  post: (m: ToFactory) => Promise<void>;
  /** 答える前に待つ（照合の遅れを試すため）。 */
  delayMs?: number;
};

/** 受け箱の *.json を 1 回見て、全部に答える。答えた数を返す。 */
export async function processBox(o: FakeOffice): Promise<number> {
  let names: string[];
  try {
    names = await readdir(o.box);
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of names.filter((x) => x.endsWith(".json") && !x.startsWith(".")).sort()) {
    const file = join(o.box, name);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const m = ToOffice.safeParse(JSON.parse(raw));
    if (!m.success) {
      await rm(file, { force: true });
      continue;
    }
    if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
    if (m.data.kind === "customer.query") {
      const a = answerQuery(m.data, o.customers);
      await rm(file, { force: true }); // said を残さない
      await o.post(a);
    } else if (m.data.kind === "estimate.instruction") {
      // 声の指示（#56）: 本物の事務所は返しを送らない。偽物は消すだけ（plateNo・customerWords を残さない。customer.query と同じ）
      await rm(file, { force: true });
    } else {
      const done = join(o.box, "..", "done");
      await mkdir(done, { recursive: true });
      await rename(file, join(done, name));
      await o.post(answerRequest(m.data));
    }
    n++;
  }
  return n;
}

/** 工場の reply の受け口に POST する。 */
export function poster(factoryUrl: string, token: string): (m: ToFactory) => Promise<void> {
  return async (m) => {
    const r = await fetch(`${factoryUrl.replace(/\/+$/, "")}/api/office/reply`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(m),
    });
    await r.body?.cancel();
    if (!r.ok) throw new Error(`工場が受けなかった: HTTP ${r.status}`);
  };
}
