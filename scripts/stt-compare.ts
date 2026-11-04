/**
 * 文字起こしのベンダーを架空の台本だけで比べる（#31 の前半）。父の実録音（data/）は読まない。
 *
 * 使い方（<dir> は scratchpad などリポジトリ外。音声と書き起こしの全文はそこに置き、コミットしない）:
 *   pnpm tsx scripts/stt-compare.ts synth <dir> [--voice Kyoko]
 *   pnpm tsx scripts/stt-compare.ts run   <dir> [--only scribe,gemini-flash,...] [--force]
 *   pnpm tsx scripts/stt-compare.ts score <dir>
 *
 * ベンダー: scribe / scribe-keyterms / gemini-flash / gemini-transcribe / gemini-transcribe-vocab /
 *          kotoba / kotoba-prompt / whisper-turbo
 * キーは .env（ELEVENLABS_API_KEY, GEMINI_API_KEY）。whisper 系は MLX_PYTHON（mlx_whisper の入った python）。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

type Script = {
  id: string;
  dialect: boolean;
  text: string;
  speech?: string;
  terms: string[];
  numbers: string[];
  dialectWords?: string[];
};
type Fixture = { glossary: string[]; scripts: Script[] };
type Hyp = { text: string; ms: number };

const fixture = JSON.parse(
  readFileSync(new URL("../tests/fixtures/stt-scripts.json", import.meta.url), "utf8"),
) as Fixture;

const VENDORS = [
  "scribe",
  "scribe-keyterms",
  "gemini-flash",
  "gemini-transcribe",
  "gemini-transcribe-vocab",
  "kotoba",
  "kotoba-prompt",
  "whisper-turbo",
] as const;
type Vendor = (typeof VENDORS)[number];

// ---------- 正規化と比較 ----------

const KANJI_DIGIT: Record<string, number> = {
  〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};
const KANJI_UNIT: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };

function kanjiToNumber(s: string): number {
  let total = 0;
  let section = 0; // 万未満
  let digit = -1;
  for (const ch of s) {
    if (ch in KANJI_DIGIT) {
      digit = digit < 0 ? KANJI_DIGIT[ch] : digit * 10 + KANJI_DIGIT[ch];
    } else if (ch in KANJI_UNIT) {
      section += (digit < 0 ? 1 : digit) * KANJI_UNIT[ch];
      digit = -1;
    } else if (ch === "万") {
      total += (section + (digit < 0 ? 0 : digit) || 1) * 10000;
      section = 0;
      digit = -1;
    }
  }
  return total + section + (digit < 0 ? 0 : digit);
}

/** 比べるための形: NFKC、漢数字→算用数字、桁区切りを除く、句読点・記号・空白を除く（小数点は残す）。 */
export function normalize(s: string): string {
  let t = s.normalize("NFKC");
  // 「二二十」のように位取りと並びが混ざった崩れた漢数字は数に直さない（220 と読み替えて正解扱いにしないため）
  t = t.replace(/[〇零一二三四五六七八九十百千万]+/g, (m) =>
    /[十百千万]/.test(m) && /[〇零一二三四五六七八九]{2}/.test(m) ? m : String(kanjiToNumber(m)),
  );
  t = t.replace(/(\d)点(\d)/g, "$1.$2");
  t = t.replace(/(\d)[,，](?=\d{3})/g, "$1");
  t = t.replace(/(?<!\d)\.|\.(?!\d)/g, "");
  t = t.replace(/[\s\p{P}\p{S}]/gu, (c) => (c === "." ? c : ""));
  return t;
}

type Op = { r: string; h: string }; // r="" は挿入、h="" は削除

function align(ref: string, hyp: string): { dist: number; ops: Op[] } {
  const R = [...ref];
  const H = [...hyp];
  const d = Array.from({ length: R.length + 1 }, (_, i) =>
    Array.from({ length: H.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= R.length; i++)
    for (let j = 1; j <= H.length; j++)
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (R[i - 1] === H[j - 1] ? 0 : 1),
      );
  const ops: Op[] = [];
  let i = R.length;
  let j = H.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (R[i - 1] === H[j - 1] ? 0 : 1)) {
      ops.push({ r: R[--i], h: H[--j] });
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      ops.push({ r: R[--i], h: "" });
    } else {
      ops.push({ r: "", h: H[--j] });
    }
  }
  return { dist: d[R.length][H.length], ops: ops.reverse() };
}

/** 参照の [start, end) に対応する書き起こし側の文字列（取り違えの表示用）。 */
function alignedSpan(ops: Op[], start: number, end: number): string {
  let ri = 0;
  let out = "";
  for (const op of ops) {
    if (op.r === "") {
      if (ri > start && ri < end) out += op.h;
      continue;
    }
    if (ri >= start && ri < end) out += op.h;
    ri++;
  }
  return out;
}

/** 数字の前後が別の数字に続いていないことを確かめて含まれるか見る（「1本」が「11本」に当たらないように）。 */
function containsToken(hayNorm: string, token: string): boolean {
  const n = normalize(token);
  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const before = /^\d/.test(n) ? "(?<![0-9.])" : "";
  const after = /\d$/.test(n) ? "(?![0-9])" : "";
  return new RegExp(`${before}${esc}${after}`).test(hayNorm);
}

/** 方言の言い回しはかな書きの揺れ（まいね／マイネ）を問わない。 */
const toHiragana = (s: string) => s.replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

type Check = { label: string; ok: boolean; got: string };

function check(items: string[], refNorm: string, hypNorm: string, ops: Op[], foldKana = false): Check[] {
  return items.map((item) => {
    const alts = item.split("|");
    const ok = alts.some((a) =>
      foldKana ? containsToken(toHiragana(hypNorm), toHiragana(a)) : containsToken(hypNorm, a),
    );
    const canon = alts.map(normalize).find((a) => refNorm.includes(a)) ?? normalize(alts[0]);
    const at = refNorm.indexOf(canon);
    const got = ok || at < 0 ? "" : alignedSpan(ops, at, at + [...canon].length) || "（抜け）";
    return { label: alts[0], ok, got };
  });
}

// ---------- 音声の作成 ----------

function synth(dir: string, voice: string) {
  mkdirSync(join(dir, "audio"), { recursive: true });
  writeFileSync(join(dir, "scripts.json"), JSON.stringify(fixture, null, 2));
  for (const s of fixture.scripts) {
    const aiff = join(dir, "audio", `${s.id}.aiff`);
    const wav = join(dir, "audio", `${s.id}.wav`);
    execFileSync("say", ["-v", voice, "-o", aiff, s.speech ?? s.text]);
    execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]);
    const info = execFileSync("afinfo", [wav]).toString();
    const sec = /estimated duration: ([\d.]+)/.exec(info)?.[1];
    console.log(`${s.id} ${sec}s`);
  }
}

function durationSec(wav: string): number {
  const info = execFileSync("afinfo", [wav]).toString();
  return Number(/estimated duration: ([\d.]+)/.exec(info)?.[1] ?? 0);
}

// ---------- ベンダー ----------

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} がありません（.env を確かめる）`);
  return v;
}

/** 混雑（429/503）は 3 回まで待って取り直す。時間は成功した 1 回分だけを測る。 */
async function timed(f: () => Promise<string>): Promise<Hyp & { retries: number }> {
  for (let retries = 0; ; retries++) {
    const t = performance.now();
    try {
      const text = await f();
      return { text, ms: Math.round(performance.now() - t), retries };
    } catch (e) {
      if (retries >= 3 || !/ (429|503) /.test(String(e))) throw e;
      console.log(`  混雑のため取り直す（${retries + 1} 回目）`);
      await new Promise((r) => setTimeout(r, 20000 * (retries + 1)));
    }
  }
}

async function scribe(wav: string, keyterms: boolean): Promise<string> {
  const form = new FormData();
  form.append("model_id", "scribe_v2");
  form.append("language_code", "jpn");
  form.append("tag_audio_events", "false");
  if (keyterms) for (const k of fixture.glossary) form.append("keyterms", k);
  form.append("file", new Blob([readFileSync(wav)], { type: "audio/wav" }), "audio.wav");
  const r = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": env("ELEVENLABS_API_KEY") },
    body: form,
  });
  if (!r.ok) throw new Error(`scribe ${r.status} ${await r.text()}`);
  return ((await r.json()) as { text: string }).text;
}

async function geminiFlash(wav: string): Promise<string> {
  const body = {
    contents: [
      {
        parts: [
          { inline_data: { mime_type: "audio/wav", data: readFileSync(wav).toString("base64") } },
          {
            text: "この音声を日本語でそのまま文字起こししてください。言い直し・方言・言いよどみも聞こえたとおりに書き、文字起こしの本文だけを返してください。",
          },
        ],
      },
    ],
  };
  const r = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent",
    {
      method: "POST",
      headers: { "x-goog-api-key": env("GEMINI_API_KEY"), "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!r.ok) throw new Error(`gemini-flash ${r.status} ${await r.text()}`);
  const j = (await r.json()) as { candidates: { content: { parts: { text?: string }[] } }[] };
  return j.candidates[0].content.parts.map((p) => p.text ?? "").join("");
}

/**
 * gemini-3.5-transcribe は generateContent ではなく Interactions API（/v1beta/interactions）で呼ぶ。
 * 本文は steps[type=model_output].content[].text に入る。音声は inline（type:"audio"）でも渡せる。
 */
async function geminiTranscribe(wav: string, vocab: boolean): Promise<string> {
  const body = {
    model: "models/gemini-3.5-transcribe",
    input: [{ type: "audio", mime_type: "audio/wav", data: readFileSync(wav).toString("base64") }],
    generation_config: {
      transcription_config: {
        language_codes: ["ja-JP"],
        ...(vocab ? { custom_vocabulary: fixture.glossary } : {}),
      },
    },
  };
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: { "x-goog-api-key": env("GEMINI_API_KEY"), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`gemini-transcribe ${r.status} ${await r.text()}`);
  const j = (await r.json()) as {
    steps: { type: string; content?: { type: string; text?: string }[] }[];
  };
  return j.steps
    .filter((s) => s.type === "model_output")
    .flatMap((s) => s.content ?? [])
    .map((c) => c.text ?? "")
    .join("");
}

/** mlx_whisper を 1 プロセスで回す。最初の 1 本は読み込みの暖機として 2 回かけ、2 回目の時間を使う。 */
function whisper(repo: string, wavs: string[], prompt?: string): Hyp[] {
  const py = env("MLX_PYTHON");
  const code = `
import json, sys, time, mlx_whisper
repo, prompt = sys.argv[1], sys.argv[2] or None
wavs = sys.argv[3:]
mlx_whisper.transcribe(wavs[0], path_or_hf_repo=repo, language="ja", initial_prompt=prompt)
for w in wavs:
    t = time.perf_counter()
    r = mlx_whisper.transcribe(w, path_or_hf_repo=repo, language="ja", initial_prompt=prompt, condition_on_previous_text=False)
    print(json.dumps({"text": r["text"], "ms": round((time.perf_counter() - t) * 1000)}, ensure_ascii=False))
`;
  const out = execFileSync(py, ["-I", "-c", code, repo, prompt ?? "", ...wavs], {
    maxBuffer: 1 << 24,
    stdio: ["ignore", "pipe", "inherit"],
  }).toString();
  return out
    .trim()
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as Hyp);
}

async function run(dir: string, only: Vendor[], force: boolean) {
  process.loadEnvFile(resolve(import.meta.dirname, "../.env"));
  const wav = (id: string) => join(dir, "audio", `${id}.wav`);
  for (const v of only) {
    const out = join(dir, "hyp", v);
    mkdirSync(out, { recursive: true });
    const todo = fixture.scripts.filter((s) => force || !existsSync(join(out, `${s.id}.json`)));
    if (todo.length === 0) continue;
    if (v === "kotoba" || v === "kotoba-prompt" || v === "whisper-turbo") {
      const repo = v === "whisper-turbo" ? "mlx-community/whisper-large-v3-turbo" : "kaiinui/kotoba-whisper-v2.0-mlx";
      const prompt = v === "kotoba-prompt" ? fixture.glossary.join("、") : undefined;
      const hyps = whisper(repo, todo.map((s) => wav(s.id)), prompt);
      todo.forEach((s, i) => writeFileSync(join(out, `${s.id}.json`), JSON.stringify(hyps[i])));
      console.log(`${v}: ${todo.length} 本`);
      continue;
    }
    for (const s of todo) {
      const f = wav(s.id);
      let h: Hyp;
      try {
        h = await timed(() =>
          v === "scribe" ? scribe(f, false)
          : v === "scribe-keyterms" ? scribe(f, true)
          : v === "gemini-flash" ? geminiFlash(f)
          : v === "gemini-transcribe" ? geminiTranscribe(f, false)
          : geminiTranscribe(f, true),
        );
      } catch (e) {
        // 無料枠の日次上限などで止まったら、そのベンダーは飛ばして次へ（採点は取れた分だけ）
        console.error(`${v} ${s.id} 失敗: ${String(e).slice(0, 200)}`);
        break;
      }
      writeFileSync(join(out, `${s.id}.json`), JSON.stringify(h));
      console.log(`${v} ${s.id} ${h.ms}ms`);
    }
  }
}

// ---------- 採点 ----------

function score(dir: string) {
  const audioSec = fixture.scripts.reduce((a, s) => a + durationSec(join(dir, "audio", `${s.id}.wav`)), 0);
  console.log(`音声 ${fixture.scripts.length} 本、計 ${audioSec.toFixed(1)} 秒\n`);
  console.log("| ベンダー | 整備の言葉 | 本数・金額 | 方言 | CER | 1 本あたり | 取り違え |");
  console.log("|---|---|---|---|---|---|---|");
  for (const v of VENDORS) {
    const hypDir = join(dir, "hyp", v);
    if (!existsSync(hypDir)) continue;
    let terms = 0, termsOk = 0, nums = 0, numsOk = 0, dia = 0, diaOk = 0, edits = 0, chars = 0, ms = 0, n = 0;
    const misses: string[] = [];
    for (const s of fixture.scripts) {
      const p = join(hypDir, `${s.id}.json`);
      if (!existsSync(p)) continue;
      const h = JSON.parse(readFileSync(p, "utf8")) as Hyp;
      const ref = normalize(s.speech ?? s.text); // 採点は実際に読み上げた文に対して行う
      const hyp = normalize(h.text);
      const { dist, ops } = align(ref, hyp);
      edits += dist;
      chars += [...ref].length;
      ms += h.ms;
      n++;
      const t = check(s.terms, ref, hyp, ops);
      const nu = check(s.numbers, ref, hyp, ops);
      const di = check(s.dialectWords ?? [], ref, hyp, ops, true);
      terms += t.length; termsOk += t.filter((c) => c.ok).length;
      nums += nu.length; numsOk += nu.filter((c) => c.ok).length;
      dia += di.length; diaOk += di.filter((c) => c.ok).length;
      for (const c of [...t, ...nu, ...di]) if (!c.ok) misses.push(`${s.id}: ${c.label}→${c.got}`);
    }
    const cer = ((edits / chars) * 100).toFixed(1);
    console.log(
      `| ${v} | ${termsOk}/${terms} | ${numsOk}/${nums} | ${diaOk}/${dia} | ${cer}% | ${(ms / n / 1000).toFixed(2)} 秒 | ${misses.join("、") || "なし"} |`,
    );
  }
}

// ---------- 入口 ----------

const [cmd, dirArg, ...rest] = process.argv.slice(2);
if (!cmd || !dirArg) {
  console.error("usage: tsx scripts/stt-compare.ts <synth|run|score> <dir> [options]");
  process.exit(1);
}
const dir = resolve(dirArg);
if (dir.startsWith(resolve(import.meta.dirname, "../data"))) throw new Error("data/ は使わない");
const opt = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
if (cmd === "synth") synth(dir, opt("voice") ?? "Kyoko");
else if (cmd === "run") {
  const only = (opt("only")?.split(",") ?? VENDORS) as Vendor[];
  for (const v of only) if (!VENDORS.includes(v)) throw new Error(`知らないベンダー: ${v}`);
  await run(dir, only, rest.includes("--force"));
} else if (cmd === "score") score(dir);
else throw new Error(`知らないコマンド: ${cmd}`);
