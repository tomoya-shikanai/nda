"""指示（ナンバーの手がかり＋作業の文）から、伝票に入れる明細と手順を作って見せる（ドライラン。業務ソフトには何も送らない）。

使い方（office フォルダで）:
  python -m estimator plan --plate 7319 --car サンバー --kind invoice "<作業の文>"
      … 客と車を DB（読むだけ）で決め、項目の目録と Claude で明細を決め、送る手順の数と一覧を出す
  python -m estimator catalog
      … 項目の目録を DB から作り直す（C:\\nda\\box\\cache\\catalog.json）

出すのは、項目CD・名前・数量・単価・印（発話／履歴）と、入れなかった行だけ。客の名前・ナンバー・番号は出さない。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from box import resolve
from inputter import send as sendmod
from inputter.plan import COLUMNS_PATH, build_plan, load_json

from . import catalog, interpret

READER = r"C:\Users\PRS\nda-private\sql-reader.txt"
CACHE = Path(r"C:\nda\box\cache\catalog.json")


def cmd_catalog(args) -> int:
    CACHE.unlink(missing_ok=True)
    c = catalog.load(args.reader, CACHE)
    print(f"目録を作った: 項目 {len(c.items)}・自由入力の名前 {len(c.free)}・技術料の項目 {len(c.labor_codes())}")
    return 0


def cmd_plan(args) -> int:
    try:
        hints = resolve.make_hints(args.plate, kana=args.plate_kana, customer_words=args.customer or None,
                                   car_words=args.car or None)
        res = resolve.resolve(args.reader, hints)
    except resolve.ResolveError as ex:
        print(f"客と車を決められない: {ex}", file=sys.stderr)
        return 1
    print(f"客と車: {res.summary}")
    if res.decided is None:
        print("候補が 1 つに決まらないので、伝票は作らない（手がかりを足してください）。", file=sys.stderr)
        return 1
    c = catalog.load(args.reader, CACHE)
    raw = interpret.ask_claude(args.work, c)
    out = interpret.finish(raw, args.work, c)
    for line in interpret.summary(out):
        print("  " + line)
    if not out.lines:
        print("入れる行が無い。", file=sys.stderr)
        return 1
    job, items, labor = interpret.to_job(out, "dry-run", res.decided.customer_code, res.decided.car_code)
    columns = load_json(COLUMNS_PATH)
    columns = dict(columns, labor_codes=labor)
    steps = build_plan(job, items, columns)
    kp = sendmod.load_keypath(load_json(sendmod.KEYPATH_PATH))
    groups = sendmod.prepare(steps, kp, columns)
    total = sum(int(ln.qty * ln.unit_price) for ln in out.lines)
    print(f"伝票の種類: {'御見積書' if args.kind == 'estimate' else '納品書（請求書）'}・明細 {len(out.lines)} 行・合計 {total} 円（税抜き）")
    print(f"送る手順: {len(groups)} 欄（ドライラン。業務ソフトには何も送っていない）")
    if args.json:
        print(json.dumps({"lines": [vars(l) for l in out.lines], "skipped": out.skipped}, ensure_ascii=False, default=str))
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m estimator", allow_abbrev=False)
    sub = p.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("catalog", allow_abbrev=False)
    c.add_argument("--reader", default=READER)
    pl = sub.add_parser("plan", allow_abbrev=False)
    pl.add_argument("work")
    pl.add_argument("--plate", required=True)
    pl.add_argument("--plate-kana")
    pl.add_argument("--car", action="append", default=[])
    pl.add_argument("--customer", action="append", default=[])
    pl.add_argument("--kind", choices=("estimate", "invoice"), default="invoice")
    pl.add_argument("--reader", default=READER)
    pl.add_argument("--json", action="store_true")
    args = p.parse_args(argv)
    return cmd_catalog(args) if args.cmd == "catalog" else cmd_plan(args)


if __name__ == "__main__":
    sys.exit(main())
