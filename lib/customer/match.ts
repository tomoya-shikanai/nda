/**
 * 客と車の照合（#45）。名前（name か kana）とナンバーの下 4 桁の両方が、一覧の同じ 1 件に合うときだけ結び付ける。
 * 純粋な関数。API を呼ばない（照合は Claude に任せない）、入力を書き換えない。node の API を使わない（画面からも読む）。
 *
 * 比べ方: 1 字ずつ NFKC にし、カタカナをひらがなにそろえ、空白・「-」を飛ばした文字列で探す（元の文字の位置を覚えておき、伏せ字は元の文に当てる）。
 * 名前の語は name と kana の全体と、空白の前（姓）。下 4 桁は、前後が数字でない 4 桁の数字の並びで、「円」が続かないもの。
 * 一覧のどれかの名前の語と、一覧のどれかの下 4 桁に当たる部分は、照合が決まっても決まらなくても伏せ字にする（他の客の情報も Claude に渡さない）。
 */
import { z } from "zod";

export const Customer = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kana: z.string().min(1),
  plate4: z.string().regex(/^[0-9]{4}$/),
  car: z.string(),
});
export type Customer = z.infer<typeof Customer>;
export const CustomerList = z.array(Customer);

/** 伏せ字。数字・品目の語・数量の候補にならない文字。 */
export const MASK_NAME = "＊＊";
export const MASK_PLATE = "＊＊＊＊";

const SKIP = /[\s\-‐－−ー]/;

/** カタカナ → ひらがな（長音「ー」は飛ばす文字に入れる）。 */
function hira(c: string): string {
  const code = c.charCodeAt(0);
  return code >= 0x30a1 && code <= 0x30f6 ? String.fromCharCode(code - 0x60) : c;
}

/** 比べるための文字列と、各文字の元の位置。 */
function fold(text: string): { s: string; at: number[] } {
  let s = "";
  const at: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (SKIP.test(c)) continue;
    for (const d of c.normalize("NFKC")) {
      if (SKIP.test(d)) continue;
      s += hira(d).toLowerCase();
      at.push(i);
    }
  }
  return { s, at };
}

const foldWord = (w: string) => fold(w).s;

/** 名前の語（name・kana の全体と姓）。比べる形。 */
export function nameWords(c: Customer): string[] {
  const words = [c.name, c.kana, c.name.split(/\s+/)[0], c.kana.split(/\s+/)[0]].map(foldWord).filter((w) => w.length >= 2);
  return [...new Set(words)];
}

type Span = { start: number; end: number };

export type Identified = {
  /** 伏せ字にした発話の文。並びは入力と同じ。 */
  texts: string[];
  /** 名前と下 4 桁の両方が同じ 1 件に合ったときだけ、その客の id。 */
  customerId: string | null;
};

/**
 * 発話の文（1 つ以上）から客を探し、名前と下 4 桁を伏せ字にする。
 * 名前だけ・下 4 桁だけ・2 件以上に合う・合わないときは customerId は null（候補をどこにも出さない）。
 */
export function identifyCustomer(texts: string[], customers: Customer[]): Identified {
  const plates = new Set(customers.map((c) => c.plate4));
  const named = new Set<string>();
  const saidPlates = new Set<string>();
  const out = texts.map((text) => {
    const f = fold(text);
    const spans: (Span & { mask: string })[] = [];
    for (const c of customers) {
      for (const w of nameWords(c)) {
        for (let i = f.s.indexOf(w); i >= 0; i = f.s.indexOf(w, i + 1)) {
          named.add(c.id);
          spans.push({ start: f.at[i], end: f.at[i + w.length - 1] + 1, mask: MASK_NAME });
        }
      }
    }
    for (const m of f.s.matchAll(/[0-9]+/g)) {
      const i = m.index ?? 0;
      if (m[0].length !== 4 || !plates.has(m[0]) || f.s[i + 4] === "円") continue;
      saidPlates.add(m[0]);
      spans.push({ start: f.at[i], end: f.at[i + 3] + 1, mask: MASK_PLATE });
    }
    return mask(text, spans);
  });
  const hits = customers.filter((c) => named.has(c.id) && saidPlates.has(c.plate4));
  return { texts: out, customerId: hits.length === 1 ? hits[0].id : null };
}

/** 重なる範囲はまとめ、後ろから伏せ字に置き換える。 */
function mask(text: string, spans: (Span & { mask: string })[]): string {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: (Span & { mask: string })[] = [];
  for (const sp of sorted) {
    const last = merged.at(-1);
    if (last && sp.start < last.end) {
      last.end = Math.max(last.end, sp.end);
      if (sp.mask === MASK_PLATE) last.mask = MASK_PLATE;
    } else merged.push({ ...sp });
  }
  let s = text;
  for (const sp of merged.reverse()) s = s.slice(0, sp.start) + sp.mask + s.slice(sp.end);
  return s;
}
