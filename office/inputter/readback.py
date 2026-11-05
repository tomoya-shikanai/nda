"""保存の後に DB から読んだ明細と、入れるはずだった明細を照らす（DB を読むところは別）。

どちらも {code, name, qty, unit_price} の list。DB の数量は 10 倍（4 なら 40）。
食い違いを 1 件ずつ返す。空なら一致。
"""

from __future__ import annotations


def _norm_name(v: object) -> object:
    # DB の固定長の文字の列は後ろが空白で埋まることがあるので、前後の空白だけ落とす
    return v.strip() if isinstance(v, str) else v


def compare(expected: list[dict], actual_db: list[dict]) -> list[dict]:
    mismatches: list[dict] = []
    if len(expected) != len(actual_db):
        mismatches.append({"row": None, "field": "行の数", "expected": len(expected), "actual": len(actual_db)})
    for i, (e, a) in enumerate(zip(expected, actual_db), start=1):
        pairs = (
            ("code", e.get("code"), a.get("code")),
            ("name", _norm_name(e.get("name")), _norm_name(a.get("name"))),
            # 期待値は画面の数（4）、DB は 10 倍（40）。整数で比べて小数の誤差を避ける
            ("qty", None if e.get("qty") is None else round(e["qty"] * 10), a.get("qty")),
            ("unit_price", e.get("unit_price"), a.get("unit_price")),
        )
        for field, ev, av in pairs:
            if ev != av:
                if field == "qty":
                    ev = e.get("qty")
                    av = None if av is None else av / 10
                mismatches.append({"row": i, "field": field, "expected": ev, "actual": av})
    return mismatches
