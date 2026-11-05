"""事務所の受け箱を見て、工場の「承認済みの請求」を業務ソフトの伝票に入れる（office フォルダで）。

  python -m box check <request.json> [--root C:\\nda\\box]
      … 1 ファイルを確かめ、送るはずのキーを出すだけ（受け箱も窓も変えない）
  python -m box run [--root C:\\nda\\box]
      … 受け箱を見張り、届いたものを確かめてドライランを出す（受け箱も窓も変えない）
  python -m box run --send [--root C:\\nda\\box]
      … 届いたものを確かめ、人が正しい客の伝票を開いたのを確かめてから、明細を送る。
        keypath.json と columns.json の confirmed が両方 true のときだけ動く。保存は人が押す。

設定は <root>\\config.json（Git に入れない）:
  {"allowed_customers": ["<練習用の客の番号>"], "item_codes": {"<品目の正式名>": <項目CD>},
   "pi_url": "http://<工場>:3000/api/office/reply", "secret": "<合言葉>"}   ← pi_url・secret は無くてよい
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from inputter import guard
from inputter import send as sendmod
from inputter.plan import COLUMNS_PATH, build_plan, load_json

from .inbox import Abort, Hooks, Inbox
from .message import Reject, check_request, envelope, load_config

DEFAULT_ROOT = Path(r"C:\nda\box")
POLL_S = 0.5


def log(m: str) -> None:
    print(time.strftime("%H:%M:%S ") + m, flush=True)


def _plan(job: dict, cfg: dict):
    columns = load_json(COLUMNS_PATH)
    steps = guard.check_plan(build_plan(job, {"items": cfg["item_codes"]}, columns))
    kp = sendmod.load_keypath(load_json(sendmod.KEYPATH_PATH))
    return kp, columns, sendmod.prepare(steps, kp, columns)


def confirmed() -> bool:
    kp = sendmod.load_keypath(load_json(sendmod.KEYPATH_PATH))
    columns = load_json(COLUMNS_PATH)
    return kp.confirmed and isinstance(columns, dict) and columns.get("confirmed") is True


def make_post(cfg: dict):
    def post(result: dict) -> str:
        if not cfg["pi_url"]:
            return "noPi"
        body = json.dumps(result, ensure_ascii=False).encode("utf-8")
        for wait in (0, 1, 2, 4):
            time.sleep(wait)
            req = urllib.request.Request(cfg["pi_url"], data=body, method="POST", headers={
                "Content-Type": "application/json", "Authorization": f"Bearer {cfg['secret']}"})
            try:
                with urllib.request.urlopen(req, timeout=5):
                    return "posted"
            except urllib.error.HTTPError as ex:
                if ex.code == 401:
                    log("工場が合言葉を受け付けない（401）。config.json の secret を確かめてください")
                    return "unauthorized"
                if ex.code < 500:
                    return f"rejected{ex.code}"
            except (urllib.error.URLError, OSError):
                pass
        return "failed"

    return post


def ask_operator(job: dict) -> bool:
    """人に正しい客の伝票を開いてもらい、顧客番号を打ってもらう。番号はこの PC の画面にだけ出す。"""
    print("", flush=True)
    print(f"  工場から請求が届きました（明細 {len(job['lines'])} 行）。", flush=True)
    print(f"  業務ソフトで 顧客番号 {job['customer_code']}・車両 {job['car_code']} の伝票を開いてください。", flush=True)
    print("  開いたら、ここに顧客番号を打って Enter。やめるときは何も打たずに Enter。", flush=True)
    try:
        typed = input("  顧客番号> ").strip()
    except EOFError:
        return False
    if typed != str(job["customer_code"]):
        print("  番号が違うか空なので、入れません。", flush=True)
        return False
    return True


def real_enter(prepared) -> int:
    from inputter.winsend import WinDesktop

    kp, _, groups = prepared
    desk = WinDesktop()
    try:
        sendmod.run(desk, kp, groups, lambda m: log(m))
    except sendmod.Stop as ex:
        log(f"止めた（これ以上は何も送らない）: {ex}")  # send の文は値を *** にしてある
        raise Abort("other", "入力が途中で止まった。画面は人が確かめて閉じる") from None
    finally:
        desk.close()
    return len(groups) // len(kp.path)


def _load_cfg(root: Path) -> dict:
    return load_config(json.loads((root / "config.json").read_text(encoding="utf-8")))


def cmd_check(args) -> int:
    root = Path(args.root)
    try:
        cfg = _load_cfg(root)
        job = check_request(load_json(args.file), cfg)
        kp, _, groups = _plan(job, cfg)
    except Reject as ex:
        print(f"入れない（{ex.reason}）: {ex}", file=sys.stderr)
        return 1
    except Exception as ex:
        print(f"確かめられない: {type(ex).__name__}", file=sys.stderr)
        return 1
    print(f"入れてよい形です。明細 {len(job['lines'])} 行。keypath・columns の確認済み: {confirmed()}")
    for line in sendmod.dry_run_lines(groups, kp):
        print("  " + line)
    return 0


def cmd_run(args) -> int:
    root = Path(args.root)
    try:
        cfg = _load_cfg(root)
    except Exception as ex:
        print(f"config.json を読めない: {ex}", file=sys.stderr)
        return 2
    if args.send:
        if sys.platform != "win32":
            print("送るのは Windows でだけ。", file=sys.stderr)
            return 2
        if not confirmed():
            print("keypath.json と columns.json の confirmed が両方 true でないので、送らない。店で画面を確かめてから人が true にする。", file=sys.stderr)
            return 2
        hooks = Hooks(prepare=lambda job: _plan(job, cfg), confirm=ask_operator, enter=real_enter,
                      post=make_post(cfg), log=log)
        box = Inbox(root, cfg, hooks)
        box.recover()
        box.resend()
        log(f"受け箱を見ています: {box.inbox}（Ctrl+C で終わる）")
        try:
            while True:
                box.run_once()
                time.sleep(POLL_S)
        except KeyboardInterrupt:
            return 0

    # ドライラン: 受け箱は変えない。同じファイルは 1 回だけ見る
    seen: set[str] = set()
    inbox = root / "in"
    log(f"ドライランで受け箱を見ています: {inbox}（何も入れない。Ctrl+C で終わる）")
    try:
        while True:
            for p in sorted(inbox.glob("*.json")):
                if p.name.startswith(".") or p.name in seen:
                    continue
                seen.add(p.name)
                try:
                    msg = load_json(p)
                    kind, rid, _ = envelope(msg)
                    if kind != "invoice.request":
                        continue
                    job = check_request(msg, cfg)
                    kp, _, groups = _plan(job, cfg)
                    log(f"{rid[:8]} 入れてよい形。明細 {len(job['lines'])} 行。送るはずのキー:")
                    for line in sendmod.dry_run_lines(groups, kp):
                        print("    " + line, flush=True)
                except Reject as ex:
                    log(f"{p.name}: 入れない（{ex.reason}）: {ex}")
                except Exception as ex:
                    log(f"{p.name}: 確かめられない: {type(ex).__name__}")
            time.sleep(POLL_S)
    except KeyboardInterrupt:
        return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m box", allow_abbrev=False)
    sub = p.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("check", allow_abbrev=False)
    c.add_argument("file")
    c.add_argument("--root", default=str(DEFAULT_ROOT))
    r = sub.add_parser("run", allow_abbrev=False)
    r.add_argument("--root", default=str(DEFAULT_ROOT))
    r.add_argument("--send", action="store_true")
    args = p.parse_args(argv)
    return cmd_check(args) if args.cmd == "check" else cmd_run(args)


if __name__ == "__main__":
    sys.exit(main())
