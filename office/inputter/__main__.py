"""使い方（office フォルダで）:
  python -m inputter plan <job.json> --items <items.json> [--columns <columns.json>]
      … 承認済みの明細から入れる手順を作り、JSON で出す（試し。窓には何も送らない）
  python -m inputter send <job.json> --items <items.json>
      … 送るはずのキーと、各歩で確かめる部品の位置を出すだけ（ドライラン。窓には何も送らない）
  python -m inputter send <job.json> --items <items.json> --send
      … 実際に送る。keypath.json と columns.json の confirmed が両方 true のときだけ動く

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
        kp = sendmod.load_keypath(load_json(sendmod.KEYPATH_PATH))
        groups = sendmod.prepare(steps, kp)
    except (PlanError, guard.GuardError, sendmod.SendError, OSError, json.JSONDecodeError) as ex:
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

    try:
        sendmod.run(WinDesktop(), kp, groups, lambda m: print(m, flush=True))
    except sendmod.Stop as ex:
        print(f"止めた（これ以上は何も送らない）: {ex}", file=sys.stderr)
        print("伝票は保存せず、人が画面を確かめてください。", file=sys.stderr)
        return 3
    except Exception as ex:  # 読み取り・送るところの失敗も、何も押さずに止める。中身（値）は出さない
        print(f"止めた（これ以上は何も送らない）: {type(ex).__name__}", file=sys.stderr)
        print("伝票は保存せず、人が画面を確かめてください。", file=sys.stderr)
        return 3
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
    args = p.parse_args(argv)
    return _cmd_plan(args) if args.cmd == "plan" else _cmd_send(args)


if __name__ == "__main__":
    sys.exit(main())
