"""使い方（office フォルダで）:
  python -m inputter plan <job.json> --items <items.json> [--columns <columns.json>]
      … 承認済みの明細から入れる手順を作り、JSON で出す（試し。窓には何も送らない）
  python -m inputter send <job.json> --items <items.json>
      … 送るはずのキーと、各歩で確かめる部品の位置を出すだけ（ドライラン。窓には何も送らない）
  python -m inputter send <job.json> --items <items.json> --send
      … 実際に送る。keypath.json と columns.json の confirmed が両方 true のときだけ動く

  python -m inputter watch [--minutes 30]
      … 人が伝票の画面で Enter を押す間、フォーカスの道を読むだけで keypath と照らす（何も送らない）

send の欄の順・位置は inputter/keypath.json と inputter/columns.json に固定（差し替えない）。
"""

from __future__ import annotations

import argparse
import json
import sys

from . import guard
from . import send as sendmod
from .plan import COLUMNS_PATH, PlanError, build_plan, load_json

SEND_REFUSED = (
    "--send は「python -m inputter send <job.json> --items <items.json> --send」の形でだけ使える。"
    "送る前に、鹿内さんが店で画面を見て確かめることと、Codex の敵対レビューが要る。"
)
NOT_CONFIRMED = (
    "keypath.json と columns.json の confirmed が両方 true でないので、送らない。"
    "店で画面を見て欄の順・位置・読み返しの形を確かめてから、人が true にする。"
)


def _send_flag_problem(argv: list[str]) -> bool:
    # --send は send の後にだけ、略さずに付ける（--se・--send=1・plan --send は断る）
    for a in argv:
        if a.startswith("--se") and a != "--send":
            return True
    return "--send" in argv and (not argv or argv[0] != "send")


def _plan(job_path: str, items_path: str, columns_path: str | None) -> tuple[dict, object, list[dict]]:
    job = load_json(job_path)
    columns = load_json(columns_path if columns_path else COLUMNS_PATH)
    steps = build_plan(job, load_json(items_path), columns)
    guard.check_plan(steps)  # build_plan の中でも通すが、出す直前にもう一度
    return job, columns, steps


def _cmd_plan(args) -> int:
    try:
        job, columns, steps = _plan(args.job, args.items, args.columns)
    except (PlanError, guard.GuardError, OSError, json.JSONDecodeError) as ex:
        print(f"手順を作れない: {ex}", file=sys.stderr)
        return 1
    out = {
        "mode": "dry-run",
        "job_id": job["job_id"],
        "customer_code": job["customer_code"],
        "car_code": job["car_code"],
        # 欄の順を画面で確かめるまで false。false のままの手順は送ってはいけない
        "columns_confirmed": isinstance(columns, dict) and columns.get("confirmed") is True,
        "steps": steps,
    }
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


def _cmd_send(args) -> int:
    try:
        _, columns, steps = _plan(args.job, args.items, None)
    except (PlanError, guard.GuardError, OSError, json.JSONDecodeError) as ex:
        # 手順を作る段のエラーの文には、品目の名前・数量などの値が入るので、send では出さない（Codex の指摘）
        print(f"送る手順を作れない（何も送っていない）: {type(ex).__name__}。理由は plan で見る。", file=sys.stderr)
        return 1
    try:
        kp = sendmod.load_keypath(load_json(sendmod.KEYPATH_PATH))
        groups = sendmod.prepare(steps, kp, columns)
    except (sendmod.SendError, OSError, json.JSONDecodeError) as ex:
        # send.py のエラーの文は、欄の名前と理由だけで、値を入れない
        print(f"送る手順を作れない（何も送っていない）: {ex}", file=sys.stderr)
        return 1
    columns_confirmed = isinstance(columns, dict) and columns.get("confirmed") is True
    print(f"keypath.json confirmed: {kp.confirmed} / columns.json confirmed: {columns_confirmed}")
    print("各歩の前に、前面の窓と、フォーカスのある部品のクラス・位置（窓の左上から）を確かめる。値は *** と文字数だけ出す。")
    for line in sendmod.dry_run_lines(groups, kp):
        print("  " + line)
    if not args.send:
        print("ドライラン: 窓には何も送っていない。")
        return 0
    if not (kp.confirmed and columns_confirmed):
        print(NOT_CONFIRMED, file=sys.stderr)
        return 2
    if sys.platform != "win32":
        print("送るのは Windows でだけ。", file=sys.stderr)
        return 2
    from .winsend import WinDesktop

    desk = None
    try:
        desk = WinDesktop()
        sendmod.run(desk, kp, groups, lambda m: print(m, flush=True))
    except sendmod.Stop as ex:
        print(f"止めた（これ以上は何も送らない）: {ex}", file=sys.stderr)
        print("伝票は保存せず、人が画面を確かめてください。", file=sys.stderr)
        return 3
    except Exception as ex:  # 読み取り・送るところの失敗も、何も押さずに止める。中身（値）は出さない
        print(f"止めた（これ以上は何も送らない）: {type(ex).__name__}", file=sys.stderr)
        print("伝票は保存せず、人が画面を確かめてください。", file=sys.stderr)
        return 3
    finally:
        if desk is not None:
            desk.close()
    return 0


class _ReadOnly:
    """WinDesktop の読む部分だけを見せる（watch はキーを送る関数を持たない）。"""

    def __init__(self, desk) -> None:
        self._d = desk

    def foreground(self):
        return self._d.foreground()

    def focused(self):
        return self._d.focused()

    def visible_windows(self):
        return self._d.visible_windows()


def _cmd_watch(args) -> int:
    import os
    import time
    from pathlib import Path

    from . import watch

    if sys.platform != "win32":
        print("watch は Windows でだけ。", file=sys.stderr)
        return 2
    kp_data = load_json(sendmod.KEYPATH_PATH)
    kp = sendmod.load_keypath(kp_data)
    out_dir = Path(os.path.expandvars(r"%LOCALAPPDATA%\nda-recorder\watch"))
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / time.strftime("watch-%Y%m%d-%H%M%S.jsonl")
    from .winsend import WinDesktop

    desk = WinDesktop()
    try:
        with open(out_path, "a", encoding="utf-8") as fp:
            def out(e: dict) -> None:
                e = {"at": time.strftime("%H:%M:%S"), **e}
                fp.write(json.dumps(e, ensure_ascii=False) + "\n")
                fp.flush()
                print(e["at"] + " " + watch.line(e), flush=True)

            w = watch.Watcher(_ReadOnly(desk), kp, kp_data, out)
            print("読むだけで見ています。キーもクリックも送りません。伝票の画面で、人が Enter を押してください。Ctrl+C で終わる。")
            end = time.time() + args.minutes * 60
            try:
                while time.time() < end:
                    w.step_safely()
                    time.sleep(0.05)
            except KeyboardInterrupt:
                pass
            print(f"まとめ: {w.counts}  記録: {out_path}")
    finally:
        desk.close()
    return 0


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if _send_flag_problem(argv):
        print(SEND_REFUSED, file=sys.stderr)
        return 2
    p = argparse.ArgumentParser(prog="python -m inputter", allow_abbrev=False)
    sub = p.add_subparsers(dest="cmd", required=True)
    pp = sub.add_parser("plan", help="入れる手順を JSON で出す（試し）", allow_abbrev=False)
    pp.add_argument("job")
    pp.add_argument("--items", required=True)
    pp.add_argument("--columns")
    sp = sub.add_parser("send", help="伝票の画面に送る（既定はドライラン）", allow_abbrev=False)
    sp.add_argument("job")
    sp.add_argument("--items", required=True)
    sp.add_argument("--send", action="store_true", help="実際に送る（keypath・columns の confirmed が要る）")
    wp = sub.add_parser("watch", help="人が押す Enter の道を、読むだけで keypath と照らす", allow_abbrev=False)
    wp.add_argument("--minutes", type=float, default=30)
    args = p.parse_args(argv)
    if args.cmd == "watch":
        return _cmd_watch(args)
    return _cmd_plan(args) if args.cmd == "plan" else _cmd_send(args)


if __name__ == "__main__":
    sys.exit(main())
