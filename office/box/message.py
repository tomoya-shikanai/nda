"""工場から届いた「承認済みの請求」（invoice.request、docs/design/pi-office.md §3）を確かめ、入力の形に変える。

工場のファイルを信じない。次のどれか 1 つでも外れたら、画面に触らずに止める（推測で埋めない）:
v が 1、型が合う、全行に数量・単位・単価・金額がある、amount = qty × unitPrice、total = Σ amount、
item が item_codes にある、customerNo が allowed_customers にある。

型は zod（lib/office/schema.ts）が正だが、工場側はまだ無いので、ここで同じ形を手で確かめる。
工場側ができたら、書き出した JSON Schema と照らす試験を足す。
"""

from __future__ import annotations

import json
import math
import re
import uuid
from datetime import datetime
from decimal import Decimal
from pathlib import Path

from inputter.plan import (
    FREE_ENTRY_CODE,
    MAX_NAME_APPEND,
    MAX_WORK_KIND,
    PlanError,
    _check_name_text,
    _no_duplicate_keys,
    qty_tenths,
)

SESSION_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
NUM_RE = re.compile(r"^[0-9]{1,9}$")
UNIT_PRICE_FROM = ("ledger", "spoken", "answer")
MAX_LINES = 50

# invoice.result の reason（pi-office.md §3）
REASONS = ("busy", "appNotRunning", "unknownItem", "customerNotAllowed", "customerNotFound",
           "duplicate", "invalid", "readbackMismatch", "other")


class Reject(ValueError):
    """入れない。reason は invoice.result の reason。文には値（品目・客の番号）を入れない。"""

    def __init__(self, reason: str, why: str) -> None:
        assert reason in REASONS
        super().__init__(why)
        self.reason = reason


def _int(v: object) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _num(v: object) -> bool:
    return isinstance(v, (int, Decimal)) and not isinstance(v, bool)


def _str(v: object) -> bool:
    return isinstance(v, str) and v != ""


def _uuid(v: object) -> bool:
    if not isinstance(v, str):
        return False
    try:
        return str(uuid.UUID(v)) == v.lower()
    except ValueError:
        return False


def _datetime(v: object) -> bool:
    if not isinstance(v, str) or re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$", v) is None:
        return False
    try:
        datetime.fromisoformat(v.replace("Z", "+00:00"))  # 2026-99-99 のような、形だけ合う日時を止める（Codex の指摘）
    except ValueError:
        return False
    return True


def _quoted(v: object) -> bool:
    return (isinstance(v, dict) and set(v) == {"recordingId", "startSec", "endSec", "quote"}
            and isinstance(v["recordingId"], str) and _sec(v["startSec"]) and _sec(v["endSec"]) and isinstance(v["quote"], str))


def _sec(v: object) -> bool:
    # 秒は金額でないので float も受ける（ファイルから読むと Decimal、手で組むと float）
    if isinstance(v, float):
        return math.isfinite(v) and v >= 0
    return _num(v) and Decimal(v).is_finite() and v >= 0


def _bad(why: str) -> Reject:
    return Reject("invalid", why)


def _no_constant(name: str) -> object:
    raise ValueError("NaN・Infinity は受けない")


def read_message(path: Path, max_bytes: int) -> object:
    """受け箱のファイルを読む。読めないもの（大きすぎる・JSON でない・重複キー・NaN・深すぎる入れ子）は Reject。"""
    # 大きさは読んだ量で見る（stat の後に差し替えられても上限を超えて読まない。Codex 2 回目）
    with open(path, "rb") as f:
        raw = f.read(max_bytes + 1)
    if len(raw) > max_bytes:
        raise _bad("ファイルが大きすぎる")
    try:
        text = raw.decode("utf-8")
        return json.loads(text, parse_float=Decimal, parse_constant=_no_constant, object_pairs_hook=_no_duplicate_keys)
    except (PlanError, ValueError, UnicodeDecodeError, RecursionError):
        # RecursionError: [ を 1 万個並べたファイルで見回りが落ちないように（Codex の指摘）
        raise _bad("JSON として読めない") from None


ENVELOPE_KEYS = {"v", "id", "sessionId", "sentAt", "kind"}
REQUEST_KEYS = ENVELOPE_KEYS | {"attempt", "customer", "approvedAt", "approval", "lines", "total", "totalSpoken"}
# 客の決め方は 2 通り（#55）。どちらか一方だけを持つ:
#   "customer": {"customerNo", "carNo"}（番号。今の形）
#   "vehicle": {"plateNo", 任意で "rikuji"・"bango"・"kana"・"customerWords"・"carWords"}（声の手がかり。box/resolve.py で引く）
REQUEST_KEYS_VEHICLE = REQUEST_KEYS - {"customer"} | {"vehicle"}
VEHICLE_KEYS = {"plateNo"}
VEHICLE_OPTIONAL_KEYS = {"rikuji", "bango", "kana", "customerWords", "carWords"}
LINE_KEYS = {"item", "qty", "unit", "unitPrice", "amount", "unitPriceFrom", "provenance"}
LINE_OPTIONAL_KEYS = {"nameAppend"}  # マスタの名前の後ろに書き足す文字（タイヤの銘柄・サイズなど）


def envelope(msg: object) -> tuple[str, str, str]:
    """封筒だけを確かめ、(kind, id, sessionId) を返す。ファイル名・記録の名前に使うので、形を厳しく見る。"""
    if not isinstance(msg, dict):
        raise _bad("JSON が dict でない")
    if msg.get("v") != 1 or not _int(msg.get("v")):
        raise _bad("v が 1 でない")
    if not _uuid(msg.get("id")):
        raise _bad("id が uuid でない")
    if not isinstance(msg.get("sessionId"), str) or not SESSION_RE.match(msg["sessionId"]):
        raise _bad("sessionId の形が違う")
    if not _datetime(msg.get("sentAt")):
        raise _bad("sentAt が日時でない")
    if not isinstance(msg.get("kind"), str):
        raise _bad("kind が無い")
    return msg["kind"], msg["id"].lower(), msg["sessionId"]


def check_vehicle(v: object):
    """請求の vehicle（声の手がかり）を確かめ、box/resolve.py の Hints にする。外れたら Reject（invalid）。"""
    from .resolve import ResolveError, make_hints

    if not isinstance(v, dict) or not VEHICLE_KEYS <= set(v) <= VEHICLE_KEYS | VEHICLE_OPTIONAL_KEYS:
        raise _bad("vehicle の形が違う")
    try:
        return make_hints(v["plateNo"], v.get("rikuji"), v.get("bango"), v.get("kana"),
                          v.get("customerWords"), v.get("carWords"))
    except ResolveError as ex:
        raise _bad(f"vehicle: {ex}") from None


def check_request(msg: object, cfg: dict, resolve_vehicle=None) -> dict:
    """invoice.request を確かめ、入力（inputter）の job を返す。外れたら Reject。

    vehicle（声の手がかり）の請求は、resolve_vehicle（Hints → (顧客コード, 車両コード)、決まらなければ None）を
    渡したときだけ通す。渡さなければ customerNotFound で止める（解決の道が無いまま番号を推測しない）。
    """
    kind, mid, sid = envelope(msg)
    if kind != "invoice.request":
        raise _bad("kind が invoice.request でない")
    if set(msg) not in (REQUEST_KEYS, REQUEST_KEYS_VEHICLE):
        raise _bad("項目が多いか足りない")
    if not _int(msg["attempt"]) or msg["attempt"] < 1:
        raise _bad("attempt が 1 以上の整数でない")
    if not _datetime(msg["approvedAt"]) or not _quoted(msg["approval"]):
        raise _bad("承認の日時か出所が無い")
    hints = None
    if "vehicle" in msg:
        hints = check_vehicle(msg["vehicle"])
        cust = None
    else:
        cust = msg["customer"]
        if not isinstance(cust, dict) or set(cust) != {"customerNo", "carNo"}:
            raise _bad("customer の形が違う")
        for k in ("customerNo", "carNo"):
            if not isinstance(cust[k], str) or not NUM_RE.match(cust[k]) or int(cust[k]) <= 0:
                raise _bad(f"{k} が正の数字でない")
    lines = msg["lines"]
    if not isinstance(lines, list) or not 1 <= len(lines) <= MAX_LINES:
        raise _bad(f"lines が 1〜{MAX_LINES} 行でない")
    total = 0
    out_lines = []
    for i, line in enumerate(lines, start=1):
        where = f"明細 {i}"
        if not isinstance(line, dict) or not LINE_KEYS <= set(line) <= LINE_KEYS | LINE_OPTIONAL_KEYS:
            raise _bad(f"{where}: 項目が多いか足りない")
        if not _str(line["item"]) or not _str(line["unit"]):
            raise _bad(f"{where}: 品目か単位が空")
        qty, price, amount = line["qty"], line["unitPrice"], line["amount"]
        if qty is None or price is None or amount is None:
            raise _bad(f"{where}: 数量・単価・金額のどれかが null")
        if not _num(qty) or qty <= 0:
            raise _bad(f"{where}: 数量が正の数でない")
        try:
            qty_tenths(qty)
        except PlanError:
            raise _bad(f"{where}: 数量が 0.1 刻みでないか範囲の外") from None
        if not _int(price) or price < 0 or not _int(amount) or amount < 0:
            raise _bad(f"{where}: 単価か金額が 0 以上の整数でない")
        if Decimal(qty) * price != amount:
            raise _bad(f"{where}: 金額が数量×単価と合わない")
        if line["unitPriceFrom"] not in UNIT_PRICE_FROM or not _quoted(line["provenance"]):
            raise _bad(f"{where}: 単価の出所か発話の出所が無い")
        total += amount
        out = {"item": line["item"], "qty": qty, "unit": line["unit"], "unitPrice": price}
        if "nameAppend" in line:
            try:
                out["name_append"] = _check_name_text(line["nameAppend"], "名前の書き足し")
            except PlanError:
                raise _bad(f"{where}: nameAppend が、空でない {MAX_NAME_APPEND} 文字までの印字できる文字でない") from None
        out_lines.append(out)
    if not _int(msg["total"]) or msg["total"] != total:
        raise _bad("total が金額の合計と合わない")
    if msg["totalSpoken"] is not None and not _int(msg["totalSpoken"]):
        raise _bad("totalSpoken が整数でも null でもない")

    if hints is not None:
        # 形をすべて確かめてから DB を引く。決まった番号も、番号の請求と同じく allowed_customers で止める
        if resolve_vehicle is None:
            raise Reject("customerNotFound", "vehicle の請求を解決する道が無い（番号を推測しない）")
        from .resolve import ResolveError

        try:
            got = resolve_vehicle(hints)
        except ResolveError as ex:
            raise Reject("other", f"客と車を引けない（{ex}）") from None
        if got is None:
            raise Reject("customerNotFound", "手がかりに合う客と車が、ちょうど 1 つに決まらない")
        if not (isinstance(got, tuple) and len(got) == 2 and all(_int(x) and x > 0 for x in got)):
            raise _bad("解決の答えが (顧客コード, 車両コード) でない")
        cust = {"customerNo": str(got[0]), "carNo": str(got[1])}
    allowed = cfg["allowed_customers"]
    if cust["customerNo"] not in allowed:
        raise Reject("customerNotAllowed", "練習用の客の番号（allowed_customers）に無い")
    codes = cfg["item_codes"]
    kinds = cfg.get("free_work_kind", {})
    for i, line in enumerate(out_lines, start=1):
        if line["item"] not in codes:
            raise Reject("unknownItem", f"明細 {i}: 品目が item_codes に無い")
        if codes[line["item"]] == FREE_ENTRY_CODE:
            # 自由入力の行は、作業区分の決まった品目（free_work_kind）だけ。名前の書き足しは付けられない
            if line["item"] not in kinds:
                raise Reject("unknownItem", f"明細 {i}: 自由入力の品目の作業区分が free_work_kind に無い")
            if "name_append" in line:
                raise _bad(f"明細 {i}: 自由入力の行に nameAppend は付けられない")
    return {
        "job_id": sid,
        "customer_code": int(cust["customerNo"]),
        "car_code": int(cust["carNo"]),
        "lines": out_lines,
    }


INSTRUCTION_KEYS = ENVELOPE_KEYS | {"attempt", "approvedAt", "approval", "vehicle", "slipKind", "work"}
SLIP_KINDS = ("estimate", "invoice")
MAX_WORK_CHARS = 2000


def check_instruction(msg: object, cfg: dict, resolve_vehicle=None) -> dict:
    """estimate.instruction（声の指示: ナンバーの手がかり・伝票の種類・作業の文）を確かめ、job を返す。外れたら Reject。
    明細は、この後 estimator が作業の文から決める。客と車は resolve_vehicle（#55）でちょうど 1 つに決まるときだけ。
    決まった客も allowed_customers（練習用の客）でなければ止める。"""
    kind, mid, sid = envelope(msg)
    if kind != "estimate.instruction":
        raise _bad("kind が estimate.instruction でない")
    if set(msg) != INSTRUCTION_KEYS:
        raise _bad("項目が多いか足りない")
    if not _int(msg["attempt"]) or msg["attempt"] < 1:
        raise _bad("attempt が 1 以上の整数でない")
    if not _datetime(msg["approvedAt"]) or not _quoted(msg["approval"]):
        raise _bad("承認の日時か出所が無い")
    if msg["slipKind"] not in SLIP_KINDS:
        raise _bad("slipKind が estimate・invoice のどちらでもない")
    work = msg["work"]
    if not isinstance(work, str) or not work.strip() or len(work) > MAX_WORK_CHARS or not work.isprintable():
        raise _bad(f"work が、空でない {MAX_WORK_CHARS} 文字までの印字できる文字でない")
    hints = check_vehicle(msg["vehicle"])
    if resolve_vehicle is None:
        raise Reject("customerNotFound", "vehicle を解決する道が無い（番号を推測しない）")
    from .resolve import ResolveError

    try:
        got = resolve_vehicle(hints)
    except ResolveError as ex:
        raise Reject("other", f"客と車を引けない（{ex}）") from None
    if got is None:
        raise Reject("customerNotFound", "手がかりに合う客と車が、ちょうど 1 つに決まらない")
    if not (isinstance(got, tuple) and len(got) == 2 and all(_int(x) and x > 0 for x in got)):
        raise _bad("解決の答えが (顧客コード, 車両コード) でない")
    if str(got[0]) not in cfg["allowed_customers"]:
        raise Reject("customerNotAllowed", "練習用の客の番号（allowed_customers）に無い")
    return {"job_id": sid, "customer_code": got[0], "car_code": got[1], "slip_kind": msg["slipKind"], "work": work,
            "instruction": True}


def load_config(data: object) -> dict:
    """box\\config.json。pi_url と secret は無くてよい（無ければ工場に返さず、done に残すだけ）。"""
    if not isinstance(data, dict):
        raise ValueError("config.json が dict でない")
    allowed = data.get("allowed_customers")
    if not isinstance(allowed, list) or not allowed or not all(isinstance(a, str) and NUM_RE.match(a) for a in allowed):
        raise ValueError("allowed_customers が数字の文字列の list でない（練習用の客の番号を書く）")
    codes = data.get("item_codes")
    if not isinstance(codes, dict) or not codes or not all(_str(k) and _int(v) and v >= 0 for k, v in codes.items()):
        raise ValueError("item_codes が「品目の正式名 → 0 以上の項目CD」でない")
    kinds = data.get("free_work_kind", {})
    if not isinstance(kinds, dict) or not all(
        _str(k) and codes.get(k) == FREE_ENTRY_CODE and _int(v) and 0 < v <= MAX_WORK_KIND for k, v in kinds.items()
    ):
        raise ValueError(f"free_work_kind が「item_codes で 0 の品目 → 1〜{MAX_WORK_KIND} の作業区分」でない")
    reader = data.get("db_reader_file")
    if reader is not None and (not isinstance(reader, str) or not reader):
        raise ValueError("db_reader_file は、DB を読むだけの接続の文字列を書いたファイルの場所")
    pi_url, secret = data.get("pi_url"), data.get("secret")
    if (pi_url is None) != (secret is None):
        raise ValueError("pi_url と secret は両方書くか、両方書かない")
    if pi_url is not None and (not isinstance(pi_url, str) or not re.match(r"^https?://[^/\s]+/api/office/reply$", pi_url)):
        raise ValueError("pi_url は http://<工場>/api/office/reply の形")
    if secret is not None and (not isinstance(secret, str) or len(secret) < 16):
        raise ValueError("secret は 16 文字以上")
    return {"allowed_customers": allowed, "item_codes": codes, "free_work_kind": kinds, "db_reader_file": reader, "pi_url": pi_url, "secret": secret}
