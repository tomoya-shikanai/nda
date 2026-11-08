"""項目の目録。DB（読むだけ）の伝票の履歴とマスタから、項目CD ごとの使われ方を集める。

客の情報（顧客・車・伝票番号）は集めない。作った目録は C:\\nda\\box\\cache\\catalog.json に置く（Git に入れない）。
- items: 項目CD → マスタの名前・既定の作業区分・使われた回数・技術料の行か・直近の数量と単価（マスタにある項目CD だけ）
- free: 項目CD 0（自由入力）の決まった形の名前（廃ﾀｲﾔ･12ｲﾝﾁ など）→ 作業区分・直近の数量と単価
- pairs: 同じ伝票に一緒に出る項目CD の組と回数
"""

from __future__ import annotations

import json
import re
import subprocess
import time
from dataclasses import dataclass
from datetime import date
from pathlib import Path

HERE = Path(__file__).parent
PS1 = HERE / "catalog.ps1"
SQL = HERE / "catalog.sql"
YEARS = 3
TIMEOUT_S = 300
LABOR_SHARE = 0.8  # 技術料に入った行がこの割合以上なら、作業の行（技術料に金額を打つ）とみる
# 自由入力（項目CD 0）の名前は、自由に書けて客の名前が入りうるので、決まった形のものだけを目録に入れる（Codex の指摘）
FREE_NAME_PATTERNS = (re.compile(r"廃ﾀｲﾔ･(?:\d{2}|[０-９]{2})ｲﾝﾁ"), re.compile(r"廃タイヤ･(?:\d{2}|[０-９]{2})インチ"))


class CatalogError(RuntimeError):
    pass


@dataclass
class Item:
    code: int
    name: str  # マスタの名前（無ければよく使われた名前）
    kbn1: int | None  # マスタの既定の作業区分
    n: int  # 使われた回数
    labor: bool  # 技術料の行か
    last_qty_tenths: int = 0  # 直近の数量（10 倍）
    last_unit_price: int | None = None  # 直近の 1 個あたりの値段（技術料の行は 技術料 ÷ 数量）
    master_price: int | None = None


@dataclass
class Free:
    name: str
    n: int
    work_kind: int
    last_qty_tenths: int
    last_unit_price: int | None


@dataclass
class Catalog:
    items: dict[int, Item]
    free: dict[str, Free]
    pairs: list[tuple[int, int, int]]
    built: str

    def labor_codes(self) -> list[int]:
        return sorted(c for c, it in self.items.items() if it.labor)


def _last(su: int | None, tan: int | None, skin: int | None, bkin: int | None) -> tuple[int, int | None]:
    """直近の行から (数量の 10 倍, 1 個あたりの値段) を出す。
    技術料の行（部品金額 0）は 技術料 ÷ 数量。数量が 0 の技術料の行は 1 個として技術料をそのまま値段にする。
    部品の行は単価（無ければ 部品金額 ÷ 数量）。"""
    su, tan, skin, bkin = int(su or 0), int(tan or 0), int(skin or 0), int(bkin or 0)
    if bkin == 0 and skin > 0:
        if su == 0:
            return 10, skin
        return su, (skin * 10 // su if (skin * 10) % su == 0 else None)
    if tan > 0:
        return su, tan
    if bkin > 0 and su > 0 and (bkin * 10) % su == 0:
        return su, bkin * 10 // su
    return su, None


def build(tables: list[list[dict]], built: str = "") -> Catalog:
    usage, _unused, master, free_rows, pairs = (tables + [[]] * 5)[:5]
    m = {int(r["code"]): r for r in master}
    items: dict[int, Item] = {}
    for r in usage:
        code, n = int(r["code"]), int(r["n"])
        mr = m.get(code)
        if not mr or not str(mr.get("nm") or "").strip():
            # マスタに無い（削除した）項目CD は使わない。名前を明細の履歴から取ると、客の名前が入りうる（Codex の指摘）
            continue
        nm = str(mr["nm"]).rstrip()
        items[code] = Item(
            code=code, name=nm, kbn1=int(mr["kbn1"]) if mr and mr.get("kbn1") is not None else None, n=n,
            # 金額の入った行のうち、技術料だけに入った行の割合で決める（0 円の行は数えない）
            labor=int(r["n_labor"]) > 0 and int(r["n_labor"]) >= LABOR_SHARE * (int(r["n_labor"]) + int(r["n_part"])),
            last_qty_tenths=_last(r["last_su"], r["last_tan"], r["last_skin"], r["last_bkin"])[0],
            last_unit_price=_last(r["last_su"], r["last_tan"], r["last_skin"], r["last_bkin"])[1],
            master_price=int(mr["uri_tan"]) if mr and mr.get("uri_tan") else None,
        )
    free = {}
    for r in free_rows:
        nm = str(r["nm"]).rstrip()
        if not any(pat.fullmatch(nm) for pat in FREE_NAME_PATTERNS) or r.get("last_sag") in (None, 0):
            continue
        q, p = _last(r["last_su"], r["last_tan"], r["last_skin"], r["last_bkin"])
        free[nm] = Free(name=nm, n=int(r["n"]), work_kind=int(r["last_sag"]), last_qty_tenths=q, last_unit_price=p)
    return Catalog(items=items, free=free, pairs=[(int(p["a"]), int(p["b"]), int(p["n"])) for p in pairs], built=built)


def read_db(reader_file: str, since: int | None = None) -> list[list[dict]]:
    if since is None:
        t = date.today()
        since = (t.year - YEARS) * 10000 + t.month * 100 + t.day
    cmd = ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(PS1),
           "-ReaderFile", reader_file, "-SqlFile", str(SQL), "-Since", str(int(since))]
    try:
        p = subprocess.run(cmd, capture_output=True, timeout=TIMEOUT_S, check=False)
    except (OSError, subprocess.TimeoutExpired) as ex:
        raise CatalogError(f"DB を読めない（{type(ex).__name__}）") from None
    if p.returncode != 0:
        raise CatalogError("DB を読めない（catalog.ps1 が失敗した）")
    try:
        data = json.loads(p.stdout.decode("utf-8-sig"))
    except ValueError:
        raise CatalogError("DB の答えを読めない") from None
    if not isinstance(data, list) or len(data) != 5:
        raise CatalogError("DB の答えの表の数が違う")
    return data


def to_json(c: Catalog) -> dict:
    return {
        "built": c.built,
        "items": [vars(i) for i in sorted(c.items.values(), key=lambda i: -i.n)],
        "free": [vars(f) for f in sorted(c.free.values(), key=lambda f: -f.n)],
        "pairs": c.pairs,
    }


def from_json(d: dict) -> Catalog:
    items = {int(i["code"]): Item(**i) for i in d["items"]}
    free = {f["name"]: Free(**f) for f in d["free"]}
    return Catalog(items=items, free=free, pairs=[tuple(p) for p in d["pairs"]], built=d.get("built", ""))


def load(reader_file: str, cache: Path, max_age_s: float = 24 * 3600) -> Catalog:
    """キャッシュが新しければそれを読み、古ければ DB から作り直す。"""
    if cache.exists() and time.time() - cache.stat().st_mtime < max_age_s:
        return from_json(json.loads(cache.read_text(encoding="utf-8")))
    c = build(read_db(reader_file), built=time.strftime("%Y-%m-%d %H:%M"))
    cache.parent.mkdir(parents=True, exist_ok=True)
    tmp = cache.with_suffix(".tmp")
    tmp.write_text(json.dumps(to_json(c), ensure_ascii=False), encoding="utf-8")
    tmp.replace(cache)
    return c
