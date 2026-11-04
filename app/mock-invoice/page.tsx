// デモ動画用の模擬の請求書入力画面。市販の整備ソフトの見た目は写さず、一般的な入力画面にする。
// ?step=N で最初から N 行入った状態を出す（スクリーンショット用）。?play=1 で開いてすぐ再生する（録画用）。

import type { Metadata } from "next";
import { Suspense } from "react";
import { ITEMS } from "../_demo/tire-change";
import MockInvoice from "./MockInvoice";

export const metadata: Metadata = { title: "模擬画面 — 請求書の入力（試作）" };

export default function MockInvoicePage({ searchParams }: PageProps<"/mock-invoice">) {
  return (
    <Suspense fallback={null}>
      <Invoice searchParams={searchParams} />
    </Suspense>
  );
}

async function Invoice({ searchParams }: Pick<PageProps<"/mock-invoice">, "searchParams">) {
  const { step, play } = await searchParams;
  const n = Number(Array.isArray(step) ? step[0] : step);
  const initial = Number.isInteger(n) ? Math.min(Math.max(n, 0), ITEMS.length) : 0;
  return <MockInvoice initialStep={initial} autoPlay={play === "1"} />;
}
