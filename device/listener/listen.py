"""現場の聞き役。マイクを常時聞き、起動語「んだ クロード」で合図音を鳴らして録音し、/api/session/voice へ送る。

録音はメモリの中だけで、ファイルに残さない。起動語の判定はこの機械の中（Vosk、オフライン）。文字起こしはサーバーが STT に渡す。
使い方は README.md。設定は引数か環境変数（引数が優先）。
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from listener_core import (  # noqa: E402
    DEFAULT_WAKE_CONF,
    GRAMMAR,
    RATE,
    Endpointer,
    beep_pcm,
    log_event,
    multipart,
    pick_device,
    rms,
    send_result,
    wake_conf,
    wav_bytes,
)

DEFAULT_MODEL = "/Users/dev/tools/nda/vosk-model-dl/vosk-model-small-ja-0.22"
BLOCK_SEC = 0.1


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    env = os.environ.get
    p = argparse.ArgumentParser(description="起動語で録音して nDa のサーバーへ送る")
    p.add_argument("--list-devices", action="store_true", help="音声デバイスの一覧を出して終わる")
    p.add_argument("--server", default=env("NDA_SERVER_URL", "http://127.0.0.1:3000"), help="サーバーの URL（NDA_SERVER_URL）")
    p.add_argument("--device", default=env("NDA_INPUT_DEVICE"), help="入力デバイス名の部分一致。無ければシステムの既定（NDA_INPUT_DEVICE）")
    p.add_argument("--output-device", default=env("NDA_OUTPUT_DEVICE"), help="合図音を鳴らすデバイス名の部分一致。無ければ既定（NDA_OUTPUT_DEVICE）")
    p.add_argument("--vendor", default=env("NDA_STT_VENDOR", "scribe"), choices=["scribe", "gemini"], help="STT（NDA_STT_VENDOR）")
    p.add_argument("--wake-conf", type=float, default=float(env("NDA_WAKE_CONF", DEFAULT_WAKE_CONF)), help="起動語の両語の conf の下限（NDA_WAKE_CONF）")
    p.add_argument("--silence-rms", type=float, default=float(env("NDA_SILENCE_RMS", "500")), help="これ未満を無音とみなす RMS（NDA_SILENCE_RMS）")
    p.add_argument("--silence-sec", type=float, default=1.5, help="声の後この秒数の無音で録音を止める")
    p.add_argument("--max-sec", type=float, default=30.0, help="録音の最大秒数")
    p.add_argument("--model", default=env("NDA_VOSK_MODEL", DEFAULT_MODEL), help="Vosk のモデルのフォルダ（NDA_VOSK_MODEL）")
    p.add_argument("--log-dir", default=env("NDA_LOG_DIR"), help="出来事の記録の置き場。無ければ記録しない（NDA_LOG_DIR。Pi は /var/lib/nda/logs）")
    p.add_argument("--show-level", action="store_true", help="録音中の音量（RMS）を出す（無音の閾値を決めるとき）")
    return p.parse_args(argv)


def list_devices(sd) -> None:
    default_in, default_out = sd.default.device
    for i, d in enumerate(sd.query_devices()):
        kinds = []
        if d["max_input_channels"] > 0:
            kinds.append("入力" + ("（既定）" if i == default_in else ""))
        if d["max_output_channels"] > 0:
            kinds.append("出力" + ("（既定）" if i == default_out else ""))
        print(f"{i:3d}  {d['name']}  [{' / '.join(kinds)}]  {int(d['default_samplerate'])}Hz")


def beep(sd, device: int | None) -> None:
    """合図音。鳴らせなくても聞き役は止めない。"""
    try:
        with sd.RawOutputStream(samplerate=RATE, channels=1, dtype="int16", device=device) as out:
            out.write(beep_pcm())
    except Exception as e:  # noqa: BLE001
        print(f"合図音を鳴らせなかった（{type(e).__name__}）", file=sys.stderr)


def drain(q: queue.Queue) -> None:
    while True:
        try:
            q.get_nowait()
        except queue.Empty:
            return


def record(q: queue.Queue, ep: Endpointer, show_level: bool) -> bytes:
    chunks = []
    while True:
        data = q.get()
        chunks.append(data)
        level = rms(data)
        if show_level:
            print(f"  音量 {level:7.0f}", file=sys.stderr)
        if ep.feed(level, len(data) / 2 / RATE):
            return b"".join(chunks)


def send(server: str, vendor: str, wav: bytes) -> int | None:
    """送って HTTP の状態コードを返す。届かなければ None。"""
    body, ctype = multipart({"vendor": vendor}, "file", "voice.wav", "audio/wav", wav)
    req = urllib.request.Request(f"{server.rstrip('/')}/api/session/voice", data=body, method="POST", headers={"Content-Type": ctype})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            j = json.loads(r.read())
            view = j.get("view", {})
            print(f"送った（{r.status}）: {view.get('state')} 「{view.get('say')}」")
            return r.status
    except urllib.error.HTTPError as e:
        try:
            err = json.loads(e.read()).get("error")
        except Exception:  # noqa: BLE001
            err = None
        if e.code == 409:
            # 聞いている間に作業が変わった（別の答えが入った・終わった）。古い声は当てていない
            print("作業が変わったので当てなかった。もう一度（起動語から）お願いします", flush=True)
        else:
            print(f"サーバーが断った（{e.code}）: {err}", file=sys.stderr)
        return e.code
    except (urllib.error.URLError, TimeoutError) as e:
        print(f"サーバーに届かない: {getattr(e, 'reason', e)}", file=sys.stderr)
        return None


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    import sounddevice as sd

    if args.list_devices:
        list_devices(sd)
        return 0

    devices = list(sd.query_devices())
    try:
        dev_in = pick_device(devices, args.device, "input")
        dev_out = pick_device(devices, args.output_device, "output")
    except ValueError as e:
        print(e, file=sys.stderr)
        return 2

    import vosk

    vosk.SetLogLevel(-1)
    if not Path(args.model).is_dir():
        print(f"Vosk のモデルが無い: {args.model}", file=sys.stderr)
        return 2
    model = vosk.Model(args.model)
    rec = vosk.KaldiRecognizer(model, RATE, json.dumps(GRAMMAR, ensure_ascii=False))
    rec.SetWords(True)

    q: queue.Queue = queue.Queue()

    def on_audio(indata, frames, time, status) -> None:  # noqa: ARG001
        q.put(bytes(indata))

    name_in = devices[dev_in]["name"] if dev_in is not None else "システムの既定"
    with sd.RawInputStream(samplerate=RATE, blocksize=int(RATE * BLOCK_SEC), device=dev_in, dtype="int16", channels=1, callback=on_audio):
        print(f"起動語待ち（入力: {name_in}、送り先: {args.server}、STT: {args.vendor}）。止めるには Ctrl-C", flush=True)
        while True:
            data = q.get()
            if not rec.AcceptWaveform(data):
                continue
            conf = wake_conf(json.loads(rec.Result()))
            if conf is None:
                continue
            log_event("wake", {"conf": conf, "accepted": conf >= args.wake_conf, "minConf": args.wake_conf}, args.log_dir)
            if conf < args.wake_conf:  # is_wake と同じ判定
                continue
            print("起動語を聞いた。話してください", flush=True)
            beep(sd, dev_out)
            drain(q)  # 合図音と、それまでの音を録音に入れない
            ep = Endpointer(silence_rms=args.silence_rms, silence_sec=args.silence_sec, max_sec=args.max_sec)
            pcm = record(q, ep, args.show_level)
            log_event("record", {"sec": round(ep.elapsed, 2), "spoke": ep.spoke}, args.log_dir)
            if ep.spoke:
                print(f"録音 {ep.elapsed:.1f} 秒。送ります", flush=True)
                t0 = time.monotonic()
                status = send(args.server, args.vendor, wav_bytes(pcm))
                ms = round((time.monotonic() - t0) * 1000)
                log_event("send", {"ms": ms, "status": status, "result": send_result(status)}, args.log_dir)
            else:
                print("声が無かったので送らない", flush=True)
            pcm = b""
            drain(q)
            rec.Reset()
            print("起動語待ち", flush=True)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
