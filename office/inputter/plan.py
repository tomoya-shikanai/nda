"""承認済みの明細から、伝票の画面（M_NOU）の明細の表に入れる手順を作る。

手順は {"field", "action": "type"|"append"|"key", "value"} の list。append はマスタの名前の後ろに書き足す。作った手順は必ず guard.check_plan を通す。
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
# work_kind は作業区分。自由入力の行（項目CD 0）だけ作業区分の数を打ち、ほかの行は打たずに進む
SOURCES = ("code", "name", "qty", "unit_price", "amount", "work_kind", "none")
REQUIRED_SOURCES = ("code", "name", "qty", "unit_price")
# 作業の行（labor_codes の項目CD）は、担当の後に点数・技術料へ進む。技術料に 数量 × 単価 の金額を直に打つ（2026-11-06 に店で決めた）
LABOR_REQUIRED_SOURCES = ("code", "name", "amount")
FREE_ENTRY_CODE = 0
MAX_NAME_APPEND = 40
MAX_WORK_KIND = 999


class PlanError(ValueError):
    """手順を作れない（入力の不足・品目の表に無い品目・設定の誤り）。"""


def _is_int(v: object) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _is_num(v: object) -> bool:
    return isinstance(v, (int, float, Decimal)) and not isinstance(v, bool)


def _no_duplicate_keys(pairs: list[tuple[str, object]]) -> dict:
    # 同じ項目が 2 回ある JSON（"qty": null と "qty": 1 など）は、どちらが正か分からないので止める（Codex の指摘）
    out: dict = {}
    for k, v in pairs:
        if k in out:
            raise PlanError(f"JSON に同じ項目が 2 回ある: {k!r}")
        out[k] = v
    return out


def load_json(path: str | Path) -> object:
    # 小数は Decimal で読む。float で読むと 1.00000000000000001 が 1.0 になり、0.1 刻みでない数を見逃す（Codex の指摘）
    return json.loads(Path(path).read_text(encoding="utf-8"), parse_float=Decimal, object_pairs_hook=_no_duplicate_keys)


def load_items(data: object) -> dict[str, int]:
    items = data.get("items") if isinstance(data, dict) else None
    if not isinstance(items, dict) or not items:
        raise PlanError("品目の表に items（品目の名前 → 項目CD）が無い")
    for name, code in items.items():
        if not name or not _is_int(code) or code < 0:
            raise PlanError(f"品目の表の項目CD が 0 以上の整数でない: {name!r} → {code!r}")
    return items


def load_work_kinds(data: object) -> dict[str, int]:
    """自由入力の品目 → 作業区分の番号（free_work_kind）。無ければ空。"""
    kinds = data.get("free_work_kind", {}) if isinstance(data, dict) else {}
    if not isinstance(kinds, dict):
        raise PlanError("品目の表の free_work_kind が dict でない")
    for name, k in kinds.items():
        if not name or not _is_int(k) or not 0 < k <= MAX_WORK_KIND:
            raise PlanError(f"free_work_kind の作業区分が 1〜{MAX_WORK_KIND} の整数でない: {name!r} → {k!r}")
    return kinds


def _check_name_text(text: object, what: str) -> str:
    if not isinstance(text, str) or not text or not text.isprintable() or len(text) > MAX_NAME_APPEND:
        raise PlanError(f"{what}が、空でない {MAX_NAME_APPEND} 文字までの印字できる文字でない")
    if text != text.strip(" 　"):
        # 前後の空白は画面とDBで落ちることがあり、読み返しで見分けにくいので断る
        raise PlanError(f"{what}の前後に空白がある")
    if any(ord(c) > 0xFFFF for c in text):
        raise PlanError(f"{what}に送れない文字がある")
    return text


def _check_cols(cols: object, what: str, required: tuple[str, ...], banned: tuple[str, ...]) -> None:
    if not isinstance(cols, list) or not cols:
        raise PlanError(f"欄の設定に {what} が無い")
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
    for s in required:
        # 数量・単価（作業の行は金額）の欄が設定から抜けると、黙って入れずに済ませてしまうので止める
        if seen_sources.count(s) != 1:
            raise PlanError(f"欄の設定の {what} に source {s} の欄がちょうど 1 つ無い")
    for s in banned:
        if s in seen_sources:
            raise PlanError(f"欄の設定の {what} に source {s} の欄がある")


def load_columns(data: object) -> dict:
    if not isinstance(data, dict):
        raise PlanError("欄の設定が dict でない")
    _check_cols(data.get("columns"), "columns", REQUIRED_SOURCES, ("amount",))
    labor = data.get("labor_columns")
    codes = data.get("labor_codes", [])
    if labor is not None:
        _check_cols(labor, "labor_columns", LABOR_REQUIRED_SOURCES, ("qty", "unit_price"))
    if not isinstance(codes, list) or not all(_is_int(c) and c > 0 for c in codes) or len(set(codes)) != len(codes):
        raise PlanError("欄の設定の labor_codes が、正の整数の重ならない list でない")
    if codes and labor is None:
        raise PlanError("欄の設定に labor_codes があるのに labor_columns が無い")
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
    d = qty if isinstance(qty, Decimal) else Decimal(repr(qty))
    if not d.is_finite():
        raise PlanError(f"数量が 0.1 刻みでない: {qty!r}")
    # Decimal の掛け算も既定の精度（28 桁）で丸まるので使わない（Codex の指摘）。
    # 桁の並びと指数をそのまま見て、小数点以下の 0 でない桁が 1 桁までのときだけ通す。
    sign, digits, exp = d.as_tuple()
    digits = list(digits)
    while exp < 0 and len(digits) > 1 and digits[-1] == 0:
        digits.pop()
        exp += 1
    if sign or exp < -1 or len(digits) > 6:
        raise PlanError(f"数量が 0.1 刻みでない: {qty!r}")
    if exp > 4:
        # 1e999999999 のような数で、下の 10 ** (exp + 1) が巨大な計算にならないよう先に止める（Codex の指摘）
        raise PlanError(f"数量が 0.1〜{MAX_QTY} の範囲にない: {qty!r}")
    n = int("".join(map(str, digits)))
    tenths = n * (10 ** (exp + 1))
    if tenths <= 0 or tenths > MAX_QTY * 10:
        raise PlanError(f"数量が 0.1〜{MAX_QTY} の範囲にない: {qty!r}")
    return tenths


def _qty_text(qty: float) -> str:
    # DB は数量を 10 倍で持つ（0.1 刻み）。画面には元の数（4 なら 4）を打つ
    tenths = qty_tenths(qty)
    return str(tenths // 10) if tenths % 10 == 0 else f"{tenths // 10}.{tenths % 10}"


def _line_values(i: int, line: object, items: dict[str, int], kinds: dict[str, int]) -> dict:
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
    tenths = qty_tenths(qty) * int(price)
    # 金額は作業の行の技術料に打つときだけ使う。1 円単位にならなければ None（作業の行なら build_plan で止める）
    amount = tenths // 10 if tenths % 10 == 0 else None
    code = items[item]
    append = line.get("name_append")
    work_kind = None
    if code == FREE_ENTRY_CODE:
        # 自由入力の行は品目の名前そのものを打つ。作業区分は表（free_work_kind）から取り、推測しない
        _check_name_text(item, f"{where}: 自由入力の品目の名前")
        if item not in kinds:
            raise PlanError(f"{where}: 自由入力の品目の作業区分が free_work_kind に無い")
        work_kind = kinds[item]
        if append is not None:
            raise PlanError(f"{where}: 自由入力の行に名前の書き足し（name_append）は付けられない")
    elif append is not None:
        _check_name_text(append, f"{where}: 名前の書き足し")
    return {"code": code, "name": item, "qty": qty, "unit_price": int(price), "amount": amount,
            "name_append": append, "work_kind": work_kind}


def expected_lines(job: object, items: dict[str, int], kinds: dict[str, int] | None = None) -> list[dict]:
    """入れる明細を {code, name, qty, unit_price, amount, name_append, work_kind} で返す（読み返しの照合の期待値にも使う）。"""
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
    return [_line_values(i, line, items, kinds or {}) for i, line in enumerate(lines)]


def build_plan(job: object, items_data: object, columns_data: object | None = None) -> list[dict]:
    """明細の表に入れる手順を作り、許可リストを通してから返す。"""
    items = load_items(items_data)
    kinds = load_work_kinds(items_data)
    cfg = load_columns(load_json(COLUMNS_PATH) if columns_data is None else columns_data)
    advance = {"action": "key", "value": cfg["advance_key"]}
    steps: list[dict] = []
    labor_codes = set(cfg.get("labor_codes", []))
    for n, v in enumerate(expected_lines(job, items, kinds), start=1):
        free = v["code"] == FREE_ENTRY_CODE
        labor = v["code"] in labor_codes
        if labor and v["amount"] is None:
            raise PlanError(f"明細 {n}（{v['name']}）: 数量 × 単価 が 1 円単位にならないので、技術料に打てない")
        cols = cfg["labor_columns"] if labor else cfg["columns"]
        if free and not any(c["source"] == "work_kind" for c in cols):
            raise PlanError(f"明細 {n}（{v['name']}）: 欄の設定に作業区分（work_kind）の欄が無いので、自由入力の行を入れられない")
        for col in cols:
            field = f"明細{n}.{col['field']}"
            src = col["source"]
            action = "type"
            if src == "code":
                text = str(v["code"])  # 自由入力の行も 0 を打つ（DB の項目CD 0 と合わせる）
            elif src == "name":
                # 自由入力の行は名前を打つ。マスタの品目は名前がマスタから入り、name_append があれば後ろに書き足す
                if free:
                    text = v["name"]
                elif v["name_append"] is not None:
                    text, action = v["name_append"], "append"
                else:
                    text = None
            elif src == "work_kind":
                text = str(v["work_kind"]) if free else None
            elif src == "qty":
                text = _qty_text(v["qty"])
            elif src == "unit_price":
                text = str(v["unit_price"])
            elif src == "amount":
                text = str(v["amount"])
            else:
                text = None
            if text is not None:
                steps.append({"field": field, "action": action, "value": text})
            steps.append({"field": field, **advance})
        for key in cfg.get("row_end_keys", []):
            steps.append({"field": f"明細{n}.行の終わり", "action": "key", "value": key})
    return guard.check_plan(steps)
