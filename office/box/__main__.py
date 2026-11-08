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
   "free_work_kind": {"<項目CD 0 の品目>": <作業区分>},
   "db_reader_file": "<DB を読むだけの接続の文字列を書いたファイル>",
   "pi_url": "http://<工場>:3000/api/office/reply", "secret": "<合言葉>",   ← pi_url・secret は無くてよい
   "pi_pull": {"host": "<Pi の名前>.local", "user": "<Pi のユーザー>", "key_file": "<鍵>", "known_hosts": "<Pi の鍵の控え>",
               "interval_s": 3}}   ← 無くてよい。あれば run --send のとき Pi の送り箱へ取りに行く（box/pull.py）
  送る前に、db_reader_file で車のナンバーと客の名前を引いて画面に出し、人にナンバーの番号を打ってもらう。
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

from . import lookup
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
    items = {"items": cfg["item_codes"], "free_work_kind": cfg.get("free_work_kind", {})}
    steps = guard.check_plan(build_plan(job, items, columns))
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


def ask_operator(job: dict, cfg: dict | None = None, ctx: dict | None = None) -> bool:
    """人に正しい客の伝票を開いてもらい、ナンバーの番号を打ってもらう。
    人は顧客番号を覚えていないので、DB（読むだけ）で引いたナンバーと客の名前を出す（2026-11-08 鹿内さん）。
    ナンバー・名前はこの PC の画面にだけ出し、記録・工場への返事には書かない。"""
    print("", flush=True)
    print(f"  工場から請求が届きました（明細 {len(job['lines'])} 行）。", flush=True)
    reader = (cfg or {}).get("db_reader_file")
    if not reader:
        print("  config.json に db_reader_file が無く、車のナンバーを引けないので、入れません。", flush=True)
        return False
    try:
        info = lookup.lookup(reader, job["customer_code"], job["car_code"])
    except lookup.LookupError_ as ex:
        print(f"  {ex}。入れません。", flush=True)
        return False
    print(f"  業務ソフトで、ナンバー「{info.plate}」（{info.name} 様）の見積を開いてください。", flush=True)
    print("  開いたら、ナンバーの番号（4 桁）をここに打って Enter。やめるときは何も打たずに Enter。", flush=True)
    try:
        typed = input("  ナンバーの番号> ").strip()
    except EOFError:
        return False
    if not (typed.isascii() and typed.isdigit() and int(typed) == info.no):
        print("  番号が違うか空なので、入れません。", flush=True)
        return False
    if ctx is not None:
        ctx["customer_name"] = info.title_name  # 送る間、伝票の窓の題名と照らす
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


def confirm_then_check(job: dict, cfg: dict | None = None, ctx: dict | None = None) -> bool:
    """人の確かめの後、送る直前にもう一度 keypath・columns の確認済みを読み直す（待つ間に取り消されても送らない。Codex 2 回目）。"""
    if ctx is not None:
        ctx.pop("customer_name", None)  # 前の請求の名前を使い回さない
    if not ask_operator(job, cfg, ctx):
        return False
    if not confirmed():
        print("  keypath.json か columns.json が確認済みでなくなったので、入れません。", flush=True)
        return False
    return True

def real_enter(prepared, customer_name: str | None) -> int:
    from inputter.winsend import WinDesktop

    if not customer_name:
        # 人の確かめで客の名前を引けていなければ、窓の題名と照らせないので送らない
        raise Abort("other", "客の名前を窓の題名と照らせないので、入れない")
    kp, _, groups = prepared
    desk = WinDesktop()
    try:
        sendmod.run(desk, kp, groups, lambda m: log(m), customer_name)
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
        ctx: dict = {}  # 人の確かめで引いた客の名前を、送る所へ渡す
        resolve_vehicle = None
        if args.auto:
            from . import auto, resolve

            if not auto.opener_confirmed():
                print("opener/openpath.json の confirmed が true でないので、--auto は動かさない。", file=sys.stderr)
                return 2
            if not cfg.get("db_reader_file"):
                print("config.json に db_reader_file が無いので、--auto は動かさない。", file=sys.stderr)
                return 2
            resolve_vehicle = resolve.decider(cfg["db_reader_file"])

        def prepare(job):
            if args.until_list and not job.get("instruction"):
                # 初回の確かめ（一覧で止める）の見回りでは、ほかの請求を入れない（Codex の指摘）
                raise RuntimeError("--until-list の見回りでは、声の指示のほかは入れない")
            if job.get("instruction"):
                if not auto.opener_confirmed():
                    # 起動の後に openpath.json の確認が取り消されても、指示ごとに読み直した方で判定する（Codex の指摘）
                    raise RuntimeError("opener/openpath.json が確認済みでない")
                return auto.prepare(job, cfg)  # 読み込んだ keypath・columns そのものの確認済みを prepare の中で見る
            return _plan(job, cfg, need_confirmed=True)

        def confirm(job):
            if job.get("instruction"):
                return True  # 声の指示は人の確かめを置かない（鹿内さんの決定）。人が触れば送る途中で止まる
            return confirm_then_check(job, cfg, ctx)

        def enter(prepared):
            if args.auto and isinstance(prepared, auto.Prepared):
                log("明細を決めた（工場の指示から）:")
                for line in prepared.summary:
                    log("  " + line)
                return auto.enter(prepared, log, stop_at_list=args.until_list)
            return real_enter(prepared, ctx.pop("customer_name", None))

        hooks = Hooks(prepare=prepare, confirm=confirm, enter=enter, post=make_post(cfg), log=log, closed=wait_closed)
        box = Inbox(root, cfg, hooks, resolve_vehicle=resolve_vehicle)
        try:
            box.lock()
        except RuntimeError as ex:
            print(str(ex), file=sys.stderr)
            return 2
        box.recover()
        box.resend()
        puller = None
        if cfg.get("pi_pull") is not None:
            from .pull import Puller

            puller = Puller(root, cfg["pi_pull"], log)
            log(f"工場の Pi の送り箱へ {cfg['pi_pull'].interval_s:g} 秒おきに取りに行く")
        log(f"受け箱を見ています: {box.inbox}（Ctrl+C で終わる）")
        try:
            while True:
                if puller is not None:
                    puller.tick()  # 入れている間は取りに行かない（届いた分は Pi の送り箱で待つ）
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
    r.add_argument("--auto", action="store_true", help="声の指示（estimate.instruction）も、窓を開くところから全部自動で入れる（--send と一緒に）")
    r.add_argument("--until-list", action="store_true", help="初回の確かめ: 窓を開いて一覧を読むところで止める")
    sy = sub.add_parser("say", allow_abbrev=False)
    sy.add_argument("work")
    sy.add_argument("--plate", required=True)
    sy.add_argument("--car", action="append", default=[])
    sy.add_argument("--customer", action="append", default=[])
    sy.add_argument("--kind", choices=("estimate", "invoice"), default="invoice")
    sy.add_argument("--root", default=str(DEFAULT_ROOT))
    pi = sub.add_parser("pi", allow_abbrev=False, help="工場の Pi の送り箱が見えるかだけ確かめる（取らない・印も付けない）")
    pi.add_argument("--root", default=str(DEFAULT_ROOT))
    args = p.parse_args(argv)
    if args.cmd == "say":
        return cmd_say(args)
    if args.cmd == "pi":
        return cmd_pi(args)
    if args.cmd == "run" and (args.auto or args.until_list) and not args.send:
        print("--auto と --until-list は --send と一緒にだけ使える。", file=sys.stderr)
        return 2
    if args.cmd == "run" and args.until_list and not args.auto:
        print("--until-list は --auto と一緒にだけ使える。", file=sys.stderr)
        return 2
    return cmd_check(args) if args.cmd == "check" else cmd_run(args)


def cmd_pi(args) -> int:
    """pi_pull の設定で 1 回つなぎ、送り箱に何件あるかだけを出す（list だけ。get・ack はしない）。"""
    from .pull import NAME_RE, run_ssh

    cfg = load_config(json.loads((Path(args.root) / "config.json").read_text(encoding="utf-8")))
    c = cfg.get("pi_pull")
    if c is None:
        print("config.json に pi_pull が無い。", file=sys.stderr)
        return 2
    try:
        code, out = run_ssh(c, "list")
    except Exception as ex:
        print(f"つながらない（{type(ex).__name__}）。", file=sys.stderr)
        return 1
    if code != 0:
        print(f"つながらない・門番が断った（終わりの番号 {code}）。", file=sys.stderr)
        return 1
    names = [n for n in out.decode("ascii", "replace").splitlines() if NAME_RE.match(n)]
    print(f"工場の Pi の送り箱につながった。届いている指示: {len(names)} 件（取っていない）。")
    return 0


def cmd_say(args) -> int:
    """試すための声の指示（estimate.instruction）を受け箱に置く。工場の Pi から送る部分の代わり。"""
    import uuid
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    where = {"recordingId": "say-cli", "startSec": 0.0, "endSec": 0.0, "quote": "事務所の PC で打った指示"}
    vehicle = {"plateNo": args.plate}
    if args.car:
        vehicle["carWords"] = args.car
    if args.customer:
        vehicle["customerWords"] = args.customer
    msg = {"v": 1, "id": str(uuid.uuid4()), "sessionId": f"say-{uuid.uuid4().hex[:12]}", "sentAt": now,
           "kind": "estimate.instruction", "attempt": 1, "approvedAt": now, "approval": where,
           "vehicle": vehicle, "slipKind": args.kind, "work": args.work}
    inbox = Path(args.root) / "in"
    tmp = inbox / f".{msg['id']}.json.tmp"
    tmp.write_text(json.dumps(msg, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(inbox / f"{msg['id']}.json")
    print(f"受け箱に指示を置いた（{msg['id'][:8]}）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
