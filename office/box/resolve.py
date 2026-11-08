"""声の手がかり（ナンバーの番号・陸運局・分類・かな・客の言葉・車種の言葉）から、客と車の候補を DB から引く（読むだけ。resolve_car.ps1）。

人は顧客番号・車両番号を覚えていない。声で言うのは、ナンバー（の一部）と、客・車の言葉になる（#55。2026-11-08 鹿内さん）。
ここでは、ナンバーの番号が同じ車を DB から引き、残りの手がかりで照らして、候補の list を返す。

決めるのは、次のすべてを満たすときだけ（推測で埋めない）:
- 客の言葉か車種の言葉が 1 つ以上ある（番号だけだと、1 桁の聞き違いで別の客の車に決まる）
- 与えた手がかりのすべてに合う候補が、ちょうど 1 つ
0 件・2 件以上なら決めない。呼ぶ側が、事務所の画面で人に選ばせる。

照らすのはこの PC の中だけ。客の名前・ナンバーを、例外の文・理由・記録に入れない（理由は「どの欄に、何番目の言葉が合ったか」だけ）。
"""

from __future__ import annotations

import json
import re
import subprocess
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

SCRIPT = Path(__file__).with_name("resolve_car.ps1")
TIMEOUT_S = 40
MAX_WORDS = 8
MAX_WORD_LEN = 30
MIN_WORD_LEN = 2  # 1 文字の言葉（「ア」など）は、ほとんどの客に合ってしまう

# 客の言葉を照らす欄（客のカナ・略称・名前、車検証の所有者・使用者）。車種の言葉を照らす欄
CUSTOMER_FIELDS = ("kok_namek", "kok_ryaku", "kok_namej1", "kok_namej2",
                   "car_syo_nm1", "car_syo_nm2", "car_syo_kana", "car_si_nm1", "car_si_nm2", "car_si_kana")
CAR_FIELDS = ("car_syasyu",)

# 長音・ハイフンの類（「サンバー」「ｻﾝﾊﾞｰ」「サンバ-」「サンバ」を同じに見る）と、空白・中黒
_DROP_RE = re.compile(r"[\sーｰ‐-―−〜～~\-・･.]")


class ResolveError(ValueError):
    """手がかりが悪い・DB を読めない・DB の答えが変。値は文に入れない。"""


def norm(s: object) -> str:
    """照らすための形にそろえる: NFKC（半角カナ→全角、全角英数→半角）、ひらがな→カタカナ、英字は大文字、長音・空白を除く。"""
    if not isinstance(s, str):
        return ""
    t = unicodedata.normalize("NFKC", s)
    t = "".join(chr(ord(c) + 0x60) if "ぁ" <= c <= "ゖ" else c for c in t)
    return _DROP_RE.sub("", t).upper()


def _hira(s: str) -> str:
    """ナンバーのかな（ひらがな 1 文字）の比べ方。カタカナで言われても合わせる。"""
    t = unicodedata.normalize("NFKC", s).strip()
    return "".join(chr(ord(c) - 0x60) if "ァ" <= c <= "ヶ" else c for c in t)


@dataclass(frozen=True)
class Hints:
    plate_no: int = field(repr=False)  # ナンバーの番号（1〜9999）
    rikuji: str | None = field(default=None, repr=False)  # 陸運局（例: 地名）
    bango: str | None = field(default=None, repr=False)  # 分類番号（例: 500）
    kana: str | None = field(default=None, repr=False)  # ナンバーのかな（ひらがな 1 文字）
    # 客の名前が入るので、repr（記録・例外）に出さない
    customer_words: tuple[str, ...] = field(default=(), repr=False)
    car_words: tuple[str, ...] = field(default=(), repr=False)


@dataclass(frozen=True)
class Candidate:
    customer_code: int
    car_code: int
    score: int
    reasons: tuple[str, ...]  # 値を入れない。例「客の言葉 1 が kok_namek に合う」
    complete: bool  # 与えた手がかりのすべてに合う


@dataclass(frozen=True)
class Resolution:
    candidates: tuple[Candidate, ...]  # 点の高い順
    decided: Candidate | None = None  # ちょうど 1 つに決まったときだけ

    @property
    def summary(self) -> str:
        """記録に書いてよい要約（件数と、決まったか）。"""
        return f"候補 {len(self.candidates)} 件・" + ("決まった" if self.decided else "決まらない")


def _words(v: object, what: str) -> tuple[str, ...]:
    if v is None:
        return ()
    if not isinstance(v, (list, tuple)) or len(v) > MAX_WORDS:
        raise ResolveError(f"{what} が {MAX_WORDS} 個までの list でない")
    out = []
    for i, w in enumerate(v, start=1):
        if not isinstance(w, str) or len(w) > MAX_WORD_LEN or len(norm(w)) < MIN_WORD_LEN:
            raise ResolveError(f"{what} {i} が、{MIN_WORD_LEN}〜{MAX_WORD_LEN} 文字の文字列でない")
        out.append(w)
    return tuple(out)


def make_hints(plate_no: object, rikuji: object = None, bango: object = None, kana: object = None,
               customer_words: object = None, car_words: object = None) -> Hints:
    """手がかりを確かめて Hints にする。悪ければ ResolveError（推測で直さない）。"""
    if not isinstance(plate_no, str) or not re.fullmatch(r"[0-9]{1,4}", plate_no) or int(plate_no) == 0:
        raise ResolveError("ナンバーの番号が 1〜4 桁の数字（0 以外）の文字列でない")
    for v, what in ((rikuji, "陸運局"), (bango, "分類"), (kana, "かな")):
        if v is not None and (not isinstance(v, str) or not v.strip() or len(v) > 10):
            raise ResolveError(f"{what} が、空でない 10 文字までの文字列でない")
    if bango is not None and not re.fullmatch(r"[0-9]{1,3}", unicodedata.normalize("NFKC", bango).strip()):
        raise ResolveError("分類が 1〜3 桁の数字でない")
    if kana is not None and not re.fullmatch(r"[ぁ-ゖ]", _hira(kana)):
        raise ResolveError("かながひらがな 1 文字でない")
    return Hints(plate_no=int(plate_no), rikuji=rikuji, bango=bango, kana=kana,
                 customer_words=_words(customer_words, "客の言葉"), car_words=_words(car_words, "車種の言葉"))


def _code(v: object) -> int:
    if not isinstance(v, int) or isinstance(v, bool) or v <= 0:
        raise ResolveError("DB の答えの顧客コード・車両コードが正の整数でない")
    return v


def _plate_part(given: str | None, have: object, same, label: str, reasons: list[str]) -> tuple[bool, int]:
    """(食い違わない, 点)。DB の欄が空なら、確かめられないので点を付けずに残す。"""
    if given is None:
        return True, 0
    if not isinstance(have, str) or not have.strip():
        reasons.append(f"{label}は DB に無く確かめられない")
        return True, 0
    if not same(given, have):
        return False, 0
    reasons.append(f"{label}が合う")
    return True, 1


def _match_words(words: tuple[str, ...], row: dict, fields: tuple[str, ...], label: str, reasons: list[str]) -> tuple[int, int]:
    """(合った数, 合わない数)。言葉が、どれかの欄の一部に入っていれば合う。"""
    hit = miss = 0
    vals = [(f, norm(row.get(f))) for f in fields]
    for i, w in enumerate(words, start=1):
        nw = norm(w)
        where = next((f for f, v in vals if v and nw in v), None)
        if where:
            hit += 1
            reasons.append(f"{label} {i} が {where} に合う")
        else:
            miss += 1
            reasons.append(f"{label} {i} はどの欄にも合わない")
    return hit, miss


def rank(rows: object, hints: Hints) -> Resolution:
    """DB の答え（resolve_car.ps1 の JSON を読んだもの）を手がかりで照らす。"""
    if not isinstance(rows, list) or not all(isinstance(r, dict) for r in rows):
        raise ResolveError("DB の答えが dict の list でない")
    cands = []
    seen = set()
    for r in rows:
        # 削除済みの車・客は、DB 側で除いたうえで、ここでも除く（偽の答え・欄の取り違えに備える）
        if r.get("car_del") != 0 or r.get("kok_del") != 0 or r.get("kok_kdel") != 0:
            continue
        if r.get("car_no") != hints.plate_no:
            continue
        kok, car = _code(r.get("car_kokcd")), _code(r.get("car_code"))
        if car in seen:
            raise ResolveError("DB の答えに同じ車両コードが 2 回ある")
        seen.add(car)
        reasons: list[str] = ["ナンバーの番号が合う"]
        score = 0
        ok = True
        for given, key, same, label in (
            (hints.rikuji, "car_rikuji", lambda a, b: norm(a) == norm(b), "陸運局"),
            (hints.bango, "car_bango", lambda a, b: norm(a) == norm(b), "分類"),
            (hints.kana, "car_kana", lambda a, b: _hira(a) == _hira(b), "かな"),
        ):
            fine, pt = _plate_part(given, r.get(key), same, label, reasons)
            ok, score = ok and fine, score + pt
        if not ok:
            continue  # ナンバーの一部が食い違う車は候補にしない
        h1, m1 = _match_words(hints.customer_words, r, CUSTOMER_FIELDS, "客の言葉", reasons)
        h2, m2 = _match_words(hints.car_words, r, CAR_FIELDS, "車種の言葉", reasons)
        score += 2 * (h1 + h2)
        cands.append(Candidate(customer_code=kok, car_code=car, score=score, reasons=tuple(reasons), complete=m1 + m2 == 0))
    cands.sort(key=lambda c: (-c.score, c.car_code))
    has_words = bool(hints.customer_words or hints.car_words)
    complete = [c for c in cands if c.complete]
    decided = complete[0] if has_words and len(complete) == 1 else None
    return Resolution(candidates=tuple(cands), decided=decided)


def parse(out: str) -> list:
    try:
        rows = json.loads(out)
    except ValueError:
        raise ResolveError("DB の答えを読めない") from None
    if isinstance(rows, dict):  # PowerShell 5.1 の ConvertTo-Json は、1 件だと list にしないことがある
        rows = [rows]
    return rows


def fetch(reader_file: str, plate_no: int) -> list:
    cmd = ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(SCRIPT),
           "-ReaderFile", reader_file, "-No", str(int(plate_no))]
    try:
        p = subprocess.run(cmd, capture_output=True, timeout=TIMEOUT_S, check=False)
    except (OSError, subprocess.TimeoutExpired) as ex:
        raise ResolveError(f"DB を読めない（{type(ex).__name__}）") from None
    if p.returncode != 0:
        raise ResolveError("DB を読めない（resolve_car.ps1 が失敗した）")
    return parse(p.stdout.decode("utf-8-sig", errors="replace"))


def resolve(reader_file: str, hints: Hints, fetch_rows=fetch) -> Resolution:
    """手がかりから候補を引いて照らす。fetch_rows は試験で偽の DB に差し替える。"""
    return rank(fetch_rows(reader_file, hints.plate_no), hints)


def decider(reader_file: str, fetch_rows=fetch):
    """message.check_request の resolve_vehicle に渡す関数。決まれば (顧客コード, 車両コード)、決まらなければ None。"""
    def decide(hints: Hints):
        d = resolve(reader_file, hints, fetch_rows).decided
        return None if d is None else (d.customer_code, d.car_code)
    return decide
