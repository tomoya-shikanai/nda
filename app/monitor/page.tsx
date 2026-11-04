// 工場のモニター（1920×1080、数メートル離れて見る）。試作なので中身は架空のタイヤ交換。
// ?state=idle|listening|thinking|drafting|asking|done で状態を切り替える。?nav=0 で切り替えの帯を隠す。

import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ANSWERED_VALVE_PRICE, ITEMS, yen } from "../_demo/tire-change";
import Companion from "./Companion";
import styles from "./monitor.module.css";
import { STATE_KEYS, STATES, toStateKey, type ItemStatus } from "./states";

export const metadata: Metadata = { title: "んだ — 工場のモニター（試作）" };

const MARK: Record<ItemStatus, { icon: string; text: string }> = {
  ok: { icon: "✓", text: "入れた" },
  working: { icon: "…", text: "作っている" },
  ask: { icon: "?", text: "確認待ち" },
  pending: { icon: "・", text: "まだ" },
};

export default function MonitorPage({ searchParams }: PageProps<"/monitor">) {
  return (
    <Suspense fallback={null}>
      <Monitor searchParams={searchParams} />
    </Suspense>
  );
}

async function Monitor({ searchParams }: Pick<PageProps<"/monitor">, "searchParams">) {
  const params = await searchParams;
  const key = toStateKey(params.state);
  const s = STATES[key];
  const showNav = params.nav !== "0";

  return (
    <main className={`${styles.screen} ${styles[`s_${key}`]}`}>
      <header className={styles.top}>
        <div className={styles.brand}>
          んだ <span>nDa</span>
        </div>
        <div className={styles.status}>
          <span className={styles.lamp} />
          {s.label}
        </div>
      </header>

      <section className={styles.body}>
        <div className={styles.stage}>
          <Companion state={key} />
        </div>

        <div className={styles.right}>
          <div className={styles.bubble}>
            {s.heard === null ? (
              <p className={styles.hint}>「んだ、Claude」と声をかけてください</p>
            ) : (
              <>
                <p className={styles.small}>聞き取った言葉</p>
                <p className={styles.heard}>
                  「{s.heard}
                  {s.heardPartial ? <span className={styles.caret} /> : "」"}
                </p>
              </>
            )}
            <p className={styles.doing}>{s.doing}</p>
          </div>

          <div className={`${styles.asks} ${s.asks.length > 0 ? styles.asksOn : ""}`}>
            <h2>
              確認事項 {s.asks.length > 0 && <b>{s.asks.length}</b>}
            </h2>
            <ul>
              {s.asks.length === 0 && s.resolved.length === 0 && <li className={styles.none}>ありません</li>}
              {s.asks.map((a) => (
                <li key={a} className={styles.ask}>
                  {a}
                </li>
              ))}
              {s.resolved.map((r) => (
                <li key={r} className={styles.resolved}>
                  ✓ {r}
                </li>
              ))}
            </ul>
          </div>

          <div className={styles.panel}>
            <h2>
              明細
              {s.items.length > 0 && (
                <span className={styles.count}>
                  {s.items.filter((i) => i === "ok").length}／{ITEMS.length} 行
                </span>
              )}
            </h2>
            {s.items.length === 0 ? (
              <p className={styles.none}>{key === "thinking" ? "分けています…" : "まだありません"}</p>
            ) : (
              <ul>
                {ITEMS.map((it, i) => {
                  const st = s.items[i] ?? "pending";
                  const price = it.price ?? (key === "done" ? ANSWERED_VALVE_PRICE : null);
                  return (
                    <li key={it.name} className={`${styles.item} ${styles[`i_${st}`]}`}>
                      <span className={styles.icon}>{MARK[st].icon}</span>
                      <span className={styles.itemName}>
                        {it.name} ×{it.qty}
                      </span>
                      <span className={styles.itemState}>{MARK[st].text}</span>
                      <span className={styles.itemPrice}>{price === null ? "値段？" : yen(price * it.qty)}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </section>

      <footer className={styles.foot}>試作・架空のデータ</footer>

      {showNav && (
        <nav className={styles.nav}>
          {STATE_KEYS.map((k) => (
            <Link key={k} href={`/monitor?state=${k}`} className={k === key ? styles.navOn : undefined}>
              {STATES[k].label}
            </Link>
          ))}
        </nav>
      )}
    </main>
  );
}
