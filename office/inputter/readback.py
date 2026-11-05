"""保存の後に DB から読んだ明細と、入れるはずだった明細を照らす（DB を読むところは別）。

どちらも {code, name, qty, unit_price} の list。DB の数量は 10 倍（4 なら 40）。
食い違いを 1 件ずつ返す。空なら一致。
"""

from __future__ import annotations

from .plan import PlanError, qty_tenths


def _norm_name(v: object) -> object:
    # DB の固定長の文字の列は後ろが空白で埋まることがあるので、後ろの空白（半角・全角）だけ落とす。
    # 前の空白・タブ・改行は落とさない（違いを隠してしまう。Codex の指摘）。
    return v.rstrip(" 　") if isinstance(v, str) else v


def _expected_tenths(qty: object) -> object:
    # 期待の数量は、手順を作るときと同じ決まりで 10 倍の整数にする。
    # 0.1 刻みでない数（1.25 など）を丸めて「一致」にしない（Codex の指摘）。
    if qty is None:
        return None
    try:
        return qty_tenths(qty)
    except PlanError:
        return ("不正な数量", qty)


def compare(expected: list[dict], actual_db: list[dict]) -> list[dict]:
    mismatches: list[dict] = []
    if len(expected) != len(actual_db):
        mismatches.append({"row": None, "field": "行の数", "expected": len(expected), "actual": len(actual_db)})
    for i, (e, a) in enumerate(zip(expected, actual_db), start=1):
        pairs = (
            ("code", e.get("code"), a.get("code")),
            ("name", _norm_name(e.get("name")), _norm_name(a.get("name"))),
            # 期待値は画面の数（4）、DB は 10 倍（40）。整数で比べて小数の誤差を避ける
            ("qty", _expected_tenths(e.get("qty")), a.get("qty")),
            ("unit_price", e.get("unit_price"), a.get("unit_price")),
        )
        for field, ev, av in pairs:
            if ev != av or isinstance(ev, tuple):
                if field == "qty":
                    ev = e.get("qty")
                    av = None if av is None else av / 10
                mismatches.append({"row": i, "field": field, "expected": ev, "actual": av})
    return mismatches
