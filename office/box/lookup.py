"""請求の顧客番号・車両番号から、その車のナンバーと客の名前を DB から読む（読むだけ。lookup_car.ps1）。

人は顧客番号を覚えていない（ナンバーか客の名前で探す。2026-11-08 鹿内さん）。事務所の画面には、
ナンバーと名前を出して伝票を開いてもらい、ナンバーの番号（4 桁）を打ってもらって照らす。
番号だけでは別の客の同じ番号の車を通してしまう（Codex の指摘）ので、送る間は伝票の窓の題名に客の名前（KOK_NAMEJ1）が
入っていることも確かめる（inputter/send.py の customer_name）。
ナンバー・名前は、この PC の画面にだけ出す。記録・工場への返事には書かない。
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path

from inputter.send import name_usable

SCRIPT = Path(__file__).with_name("lookup_car.ps1")
TIMEOUT_S = 40


class LookupError_(RuntimeError):
    """車を 1 台に決められない・DB を読めない。値は文に入れない。"""


@dataclass(frozen=True)
class CarInfo:
    plate: str  # 例: 陸運局 分類 かな 番号
    no: int  # ナンバーの番号（4 桁まで）
    name: str  # 客の名前
    title_name: str = ""  # 伝票の窓の題名に出る客の名前（KOK_NAMEJ1）。送る間、題名と照らす
    bango: str = ""  # ナンバーの分類（例 500）
    kana: str = ""  # ナンバーのかな
    list_rows: int = 0  # ナンバーの番号で探したときに一覧に出るはずの台数


def parse(out: str) -> CarInfo:
    try:
        rows = json.loads(out)
    except ValueError:
        raise LookupError_("DB の答えを読めない") from None
    if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict):
        raise LookupError_("請求の顧客番号・車両番号に合う車が、ちょうど 1 台でない")
    r = rows[0]
    no = r.get("no")
    if not isinstance(no, int) or isinstance(no, bool) or not 0 < no <= 9999:
        raise LookupError_("車のナンバーの番号が 1〜9999 でない")
    parts = [str(r.get(k) or "").strip() for k in ("rikuji", "bango", "kana")]
    plate = " ".join(p for p in parts + [str(no)] if p)
    if r.get("same_no") != 1:
        # 客の名前（題名に出る分）とナンバーの番号が同じ車が、ほかにもある（同じ客の別の車・同姓同名の別の客の車）。
        # 番号と題名では見分けられないので入れない（Codex の指摘 2 回）
        raise LookupError_("名前とナンバーの番号が同じ車がほかにもある（番号と窓の題名では確かめられない）")
    raw = r.get("title_name")
    # 名前は削らずにそのまま使う。DB の固定長の後ろの半角空白だけは落とす。
    # 前後にほかの空白・見えない文字（タブ・NBSP など）が残る名前は、題名との照らし方と重複の数え方がずれうるので使わない（Codex の指摘 2 回）
    title_name = raw.rstrip(" ") if isinstance(raw, str) else ""
    if not name_usable(title_name):
        raise LookupError_("客の名前（窓の題名と照らす分）が無いか短いか、前後に空白・見えない文字がある")
    rows = r.get("list_rows", 0)
    return CarInfo(plate=plate, no=no, name=str(r.get("name") or "").strip(), title_name=title_name,
                   bango=parts[1], kana=parts[2], list_rows=rows if isinstance(rows, int) and not isinstance(rows, bool) else 0)


def lookup(reader_file: str, customer_code: int, car_code: int) -> CarInfo:
    cmd = ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(SCRIPT),
           "-ReaderFile", reader_file, "-Kok", str(int(customer_code)), "-Car", str(int(car_code))]
    try:
        p = subprocess.run(cmd, capture_output=True, timeout=TIMEOUT_S, check=False)
    except (OSError, subprocess.TimeoutExpired) as ex:
        raise LookupError_(f"DB を読めない（{type(ex).__name__}）") from None
    if p.returncode != 0:
        raise LookupError_("DB を読めない（lookup_car.ps1 が失敗した）")
    return parse(p.stdout.decode("utf-8-sig", errors="replace"))
