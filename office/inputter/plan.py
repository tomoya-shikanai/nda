"""承認済みの明細から、伝票の画面（M_NOU）の明細の表に入れる手順を作る。

手順は {"field", "action": "type"|"key", "value"} の list。作った手順は必ず guard.check_plan を通す。
推測で埋めない: 数量・単価が null の行、品目の表に無い品目があれば、手順を作らずに止める。
欄の順は columns.json（未確認）で決める。
"""

from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path

from . import guard

COLUMNS_PATH = Path(__file__).with_name("columns.json")
# 列に入れるもの。none はその欄に何も打たず、次の欄へ進むだけ
SOURCES = ("code", "name", "qty", "unit_price", "none")
REQUIRED_SOURCES = ("code", "name", "qty", "unit_price")
FREE_ENTRY_CODE = 0


class PlanError(ValueError):
    """手順を作れない（入力の不足・品目の表に無い品目・設定の誤り）。"""


def _is_int(v: object) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _is_num(v: object) -> bool:
    return isinstance(v, (int, float, Decimal)) and not isinstance(v, bool)


def load_json(path: str | Path) -> object:
    # 小数は Decimal で読む。float で読むと 1.00000000000000001 が 1.0 になり、0.1 刻みでない数を見逃す（Codex の指摘）
    return json.loads(Path(path).read_text(encoding="utf-8"), parse_float=Decimal)


def load_items(data: object) -> dict[str, int]:
    items = data.get("items") if isinstance(data, dict) else None
    if not isinstance(items, dict) or not items:
        raise PlanError("品目の表に items（品目の名前 → 項目CD）が無い")
    for name, code in items.items():
        if not name or not _is_int(code) or code < 0:
            raise PlanError(f"品目の表の項目CD が 0 以上の整数でない: {name!r} → {code!r}")
    return items


def load_columns(data: object) -> dict:
    if not isinstance(data, dict):
        raise PlanError("欄の設定が dict でない")
    cols = data.get("columns")
    if not isinstance(cols, list) or not cols:
        raise PlanError("欄の設定に columns が無い")
    seen_fields, seen_sources = set(), []
    for c in cols:
        if not isinstance(c, dict) or not isinstance(c.get("field"), str) or not c["field"]:
            raise PlanError(f"欄の設定の 1 つに field が無い: {c!r}")
        if c.get("source") not in SOURCES:
            raise PlanError(f"欄 {c['field']} の source が {SOURCES} のどれでもない: {c.get('source')!r}")
        if c["field"] in seen_fields:
            raise PlanError(f"欄 {c['field']} が 2 回ある")
        seen_fields.add(c["field"])
        seen_sources.append(c["source"])
    for s in REQUIRED_SOURCES:
        # 数量・単価の欄が設定から抜けると、黙って入れずに済ませてしまうので止める
        if seen_sources.count(s) != 1:
            raise PlanError(f"欄の設定に source {s} の欄がちょうど 1 つ無い")
    if not isinstance(data.get("advance_key"), str):
        raise PlanError("欄の設定に advance_key（次の欄へ進むキー）が無い")
    if not isinstance(data.get("row_end_keys", []), list):
        raise PlanError("欄の設定の row_end_keys が list でない")
    return data


MAX_QTY = 9999


def qty_tenths(qty: object) -> int:
    """数量を 10 倍の整数にする（DB の持ち方）。0.1 刻みでぴったり表せないもの・範囲外は止める。

    浮動小数の掛け算と許容誤差は使わない（1e-12 を 0 に、大きな数を別の数に丸めてしまう。Codex の指摘）。
    repr で書いた 10 進の値を Decimal でそのまま扱う。
    """
    if not _is_num(qty):
        raise PlanError(f"数量が数でない: {qty!r}")
    d = (qty if isinstance(qty, Decimal) else Decimal(repr(qty))) * 10
    if not d.is_finite() or d != d.to_integral_value():
        raise PlanError(f"数量が 0.1 刻みでない: {qty!r}")
    tenths = int(d)
    if tenths <= 0 or tenths > MAX_QTY * 10:
        raise PlanError(f"数量が 0.1〜{MAX_QTY} の範囲にない: {qty!r}")
    return tenths


def _qty_text(qty: float) -> str:
    # DB は数量を 10 倍で持つ（0.1 刻み）。画面には元の数（4 なら 4）を打つ
    tenths = qty_tenths(qty)
    return str(tenths // 10) if tenths % 10 == 0 else f"{tenths // 10}.{tenths % 10}"


def _line_values(i: int, line: object, items: dict[str, int]) -> dict:
    where = f"明細 {i + 1}"
    if not isinstance(line, dict):
        raise PlanError(f"{where}: dict でない")
    item = line.get("item")
    if not isinstance(item, str) or not item:
        raise PlanError(f"{where}: 品目の名前が無い")
    where = f"明細 {i + 1}（{item}）"
    qty, price = line.get("qty"), line.get("unitPrice")
    if qty is None or price is None:
        raise PlanError(f"{where}: 数量か単価が null。推測で埋めないので手順を作らない")
    if not _is_num(qty) or qty <= 0:
        raise PlanError(f"{where}: 数量が正の数でない: {qty!r}")
    try:
        qty_tenths(qty)
    except PlanError as e:
        raise PlanError(f"{where}: {e}") from None
    if not _is_num(price) or price < 0 or price != int(price):
        raise PlanError(f"{where}: 単価が 0 以上の整数（円）でない: {price!r}")
    if item not in items:
        raise PlanError(f"{where}: 品目の表に無い。項目CD を推測しないので手順を作らない")
    return {"code": items[item], "name": item, "qty": qty, "unit_price": int(price)}


def expected_lines(job: object, items: dict[str, int]) -> list[dict]:
    """入れる明細を {code, name, qty, unit_price} で返す（読み返しの照合の期待値にも使う）。"""
    if not isinstance(job, dict):
        raise PlanError("伝票の JSON が dict でない")
    if not isinstance(job.get("job_id"), str) or not job["job_id"]:
        raise PlanError("job_id が無い")
    for k in ("customer_code", "car_code"):
        if not _is_int(job.get(k)) or job[k] <= 0:
            raise PlanError(f"{k} が正の整数でない: {job.get(k)!r}")
    lines = job.get("lines")
    if not isinstance(lines, list) or not lines:
        raise PlanError("明細（lines）が無い")
    return [_line_values(i, line, items) for i, line in enumerate(lines)]


def build_plan(job: object, items_data: object, columns_data: object | None = None) -> list[dict]:
    """明細の表に入れる手順を作り、許可リストを通してから返す。"""
    items = load_items(items_data)
    cfg = load_columns(load_json(COLUMNS_PATH) if columns_data is None else columns_data)
    advance = {"action": "key", "value": cfg["advance_key"]}
    steps: list[dict] = []
    for n, v in enumerate(expected_lines(job, items), start=1):
        free = v["code"] == FREE_ENTRY_CODE
        for col in cfg["columns"]:
            field = f"明細{n}.{col['field']}"
            src = col["source"]
            if src == "code":
                text = None if free else str(v["code"])  # 自由入力の行は項目CD を打たない（未確認）
            elif src == "name":
                text = v["name"] if free else None  # マスタの品目は名前がマスタから入る（未確認）
            elif src == "qty":
                text = _qty_text(v["qty"])
            elif src == "unit_price":
                text = str(v["unit_price"])
            else:
                text = None
            if text is not None:
                steps.append({"field": field, "action": "type", "value": text})
            steps.append({"field": field, **advance})
        for key in cfg.get("row_end_keys", []):
            steps.append({"field": f"明細{n}.行の終わり", "action": "key", "value": key})
    return guard.check_plan(steps)
