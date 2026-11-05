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

from .inbox import MAX_FILE_BYTES, Abort, Hooks, Inbox
from .message import Reject, check_request, envelope, load_config, read_message

DEFAULT_ROOT = Path(r"C:\nda\box")
POLL_S = 0.5


def log(m: str) -> None:
    print(time.strftime("%H:%M:%S ") + m, flush=True)


def _plan(job: dict, cfg: dict, need_confirmed: bool = False):
    columns = load_json(COLUMNS_PATH)
    if need_confirmed and not (isinstance(columns, dict) and columns.get("confirmed") is True):
        # 起動の後に columns.json が書き換わっても、依頼ごとに読み直した方で判定する（Codex の指摘）
        raise RuntimeError("columns.json が確認済みでない")
    steps = guard.check_plan(build_plan(job, {"items": cfg["item_codes"]}, columns))
    kp = sendmod.load_keypath(load_json(sendmod.KEYPATH_PATH))
    if need_confirmed and not kp.confirmed:
        raise RuntimeError("keypath.json が確認済みでない")
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


def wait_closed() -> None:
    """送り始めた後に止まったら、人が伝票を保存せずに閉じるまで待つ。"""
    print("", flush=True)
    print("  入力を途中で止めました。伝票は保存せずに閉じてください（入れかけの行が残っています）。", flush=True)
    while True:
        try:
            typed = input("  閉じたら「閉じた」と打って Enter> ").strip()
        except EOFError:
            time.sleep(5)
            continue
        if typed == "閉じた":
            return


def confirm_then_check(job: dict) -> bool:
    """人の確かめの後、送る直前にもう一度 keypath・columns の確認済みを読み直す（待つ間に取り消されても送らない。Codex 2 回目）。"""
    if not ask_operator(job):
        return False
    if not confirmed():
        print("  keypath.json か columns.json が確認済みでなくなったので、入れません。", flush=True)
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
        job = check_request(read_message(Path(args.file), MAX_FILE_BYTES), cfg)
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
        hooks = Hooks(prepare=lambda job: _plan(job, cfg, need_confirmed=True), confirm=confirm_then_check, enter=real_enter,
                      post=make_post(cfg), log=log, closed=wait_closed)
        box = Inbox(root, cfg, hooks)
        try:
            box.lock()
        except RuntimeError as ex:
            print(str(ex), file=sys.stderr)
            return 2
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
                    msg = read_message(p, MAX_FILE_BYTES)
                    kind, rid, _ = envelope(msg)
                    if kind != "invoice.request":
                        continue
                    job = check_request(msg, cfg)
                    kp, _, groups = _plan(job, cfg)
                    log(f"{rid[:8]} 入れてよい形。明細 {len(job['lines'])} 行。送るはずのキー:")
                    for line in sendmod.dry_run_lines(groups, kp):
                        print("    " + line, flush=True)
                # ファイル名は工場（か誰か）が付けたもので、値が入り得るので出さない（Codex の指摘）
                except Reject as ex:
                    log(f"受け箱のファイル: 入れない（{ex.reason}）: {ex}")
                except Exception as ex:
                    log(f"受け箱のファイル: 確かめられない: {type(ex).__name__}")
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
