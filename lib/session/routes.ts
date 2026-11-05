/**
 * 作業の route が共用する処理（音声の受け取り・文字起こし・新しい作業・答え）。route のファイルは入口だけにする。
 * 音声はファイルに保存しない（メモリで STT に渡すだけ）。応答に API キーや失敗の中身を入れない。
 * ベンダーは呼ぶ側が選ぶ（2 社の照合・自動の切り替えは #31 で実録音の後に決める）。
 */
import { randomUUID } from "node:crypto";
import { loadCustomers } from "../customer/load";
import { type LedgerEntry, ledgerPath, loadLedger } from "../ledger/lookup";
import { transcribeGemini } from "../stt/gemini";
import { transcribeScribe } from "../stt/scribe";
import { type Segment, SegmentSchema, type Transcript } from "../stt/types";
import { replySession, startSession } from "./run";
import { latestSession, readSession, sessionDir } from "./store";
import { toMonitorView } from "./view";
import { answerUtterance, routeVoice, sessionVersion } from "./voice";

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const KEY_ENV = { scribe: "ELEVENLABS_API_KEY", gemini: "GEMINI_API_KEY" } as const;
type Vendor = keyof typeof KEY_ENV;

export type AudioForm = { vendor: Vendor; file: Blob };

const NO_STORE = { "cache-control": "no-store" };

export function ledger(): Promise<LedgerEntry[]> {
  return loadLedger(ledgerPath());
}

/** multipart の vendor と file を確かめる。不正なら 400 の Response。 */
export async function readAudioForm(request: Request): Promise<AudioForm | Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "body が multipart でない" }, { status: 400 });
  }
  const vendor = form.get("vendor");
  if (vendor !== "scribe" && vendor !== "gemini") {
    return Response.json({ error: "vendor は scribe か gemini" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof Blob) || file.size === 0) {
    return Response.json({ error: "file が無い" }, { status: 400 });
  }
  return { vendor, file };
}

/** 文字起こし。キーが無ければ 500（STT を呼ばない）、STT の失敗は 502 の Response。 */
async function transcribe(form: AudioForm, recordingId: string): Promise<Transcript | Response> {
  const apiKey = process.env[KEY_ENV[form.vendor]];
  if (!apiKey) return Response.json({ error: "API キーが無い" }, { status: 500 });
  const audio = { data: new Uint8Array(await form.file.arrayBuffer()), mimeType: form.file.type || "audio/wav", recordingId };
  try {
    return form.vendor === "scribe" ? await transcribeScribe(audio, { apiKey }) : await transcribeGemini(audio, { apiKey });
  } catch {
    return Response.json({ error: "文字起こしに失敗しました" }, { status: 502 });
  }
}

/** 音声から新しい作業を作る。201 と { id, view }。 */
export async function startFromAudio(form: AudioForm): Promise<Response> {
  const id = randomUUID();
  const transcript = await transcribe(form, id);
  if (transcript instanceof Response) return transcript;
  try {
    const customers = await loadCustomers();
    const s = await startSession({ dir: sessionDir(), transcript, ledger: await ledger(), id, customers });
    return Response.json({ id: s.id, view: toMonitorView(s, customers) }, { status: 201 });
  } catch {
    return Response.json({ error: "明細に分けられませんでした" }, { status: 502 });
  }
}

/** 答えを受けられる作業か。無い ID・形の不正な ID は 404、asking でなければ 409 の Response。 */
async function askingSession(id: string) {
  if (!ID_RE.test(id)) return Response.json({ error: "見つからない" }, { status: 404 });
  const s = await readSession(sessionDir(), id);
  if (s === null) return Response.json({ error: "見つからない" }, { status: 404 });
  if (s.status !== "asking") return Response.json({ error: "答えを受けられる状態でない" }, { status: 409 });
  return s;
}

/** 答えの 1 発話を作業に当てる。200 と { view }。答えの読み取りに Claude を使わない（明細が 0 行の作業への返事だけは、話の続きとして抽出し直す）。 */
export async function answerWith(id: string, utterance: Segment, expectedVersion?: string): Promise<Response> {
  const s = await askingSession(id);
  if (s instanceof Response) return s;
  if (expectedVersion !== undefined && sessionVersion(s) !== expectedVersion) {
    // 聞いている間に作業が変わった（別の答えが入った）。古い音声は当てない。聞き役は「もう一度」と出す
    return Response.json({ error: "作業が変わりました。もう一度お願いします", stale: true }, { status: 409 });
  }
  const customers = await loadCustomers();
  const next = await replySession({ dir: sessionDir(), session: s, utterance, ledger: await ledger(), customers });
  return Response.json({ view: toMonitorView(next, customers) }, { headers: NO_STORE });
}

/**
 * 声の返事を文字起こしして答えに当てる。STT の前に作業を確かめ（無駄に STT を呼ばない）、その版を覚える。
 * 当てる直前に answerWith が版を比べ、STT の間に作業が変わっていたら当てずに 409（古い音声を新しい質問の答えにしない）。
 */
export async function answerFromAudio(id: string, form: AudioForm): Promise<Response> {
  const s = await askingSession(id);
  if (s instanceof Response) return s;
  const version = sessionVersion(s);
  const transcript = await transcribe(form, `${id}-answer-${randomUUID()}`);
  if (transcript instanceof Response) return transcript;
  const u = SegmentSchema.safeParse(transcript.segments.length ? answerUtterance(transcript) : null);
  if (!u.success) return Response.json({ error: "返事が聞き取れませんでした" }, { status: 422 });
  return answerWith(id, u.data, version);
}

/** 声の入口: 最新の作業が asking ならその返事、それ以外は新しい作業（routeVoice）。 */
export async function voiceFromAudio(form: AudioForm): Promise<Response> {
  const r = routeVoice(await latestSession(sessionDir()));
  return r.kind === "answer" ? answerFromAudio(r.id, form) : startFromAudio(form);
}
