"""使い方（office フォルダで）:
  python -m inputter plan <job.json> --items <items.json> [--columns <columns.json>]
      … 承認済みの明細から入れる手順を作り、JSON で出す（試し。窓には何も送らない）

送る機能はまだ無い。--send を付けると、何もせずに止まる。
"""

from __future__ import annotations

import argparse
import json
import sys

from . import guard
from .plan import COLUMNS_PATH, PlanError, build_plan, load_json

SEND_REFUSED = (
    "送る機能（--send）はまだ作っていない。"
    "送る前に、鹿内さんが店で画面を見て確かめることと、Codex の敵対レビューが要る。"
)


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    # どの位置に付けても、略しても（--se など）送らない
    if any(a.startswith("--se") for a in argv):
        print(SEND_REFUSED, file=sys.stderr)
        return 2
    p = argparse.ArgumentParser(prog="python -m inputter", allow_abbrev=False)
    sub = p.add_subparsers(dest="cmd", required=True)
    pp = sub.add_parser("plan", help="入れる手順を JSON で出す（試し）", allow_abbrev=False)
    pp.add_argument("job")
    pp.add_argument("--items", required=True)
    pp.add_argument("--columns")
    args = p.parse_args(argv)
    try:
        job = load_json(args.job)
        columns = load_json(args.columns if args.columns else COLUMNS_PATH)
        steps = build_plan(job, load_json(args.items), columns)
        guard.check_plan(steps)  # build_plan の中でも通すが、出す直前にもう一度
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


if __name__ == "__main__":
    sys.exit(main())
