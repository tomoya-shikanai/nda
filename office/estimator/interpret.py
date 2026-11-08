"""指示の「作業の文」から、伝票の明細（項目CD・数量・単価・名前の書き足し）を決める。

1. Claude（claude-opus-5-5、構造化出力）に、作業の文と項目の目録を渡し、行ごとに項目CD と数を選ばせる。
   客の名前・ナンバーは渡さない（作業の文だけ）。
2. 返ってきた行を、コードで確かめる（finish）。
   - 項目CD は目録にあるものだけ。自由入力（0）は目録の自由入力の名前にあるものだけ。
   - 数量・単価が作業の文に出てくる数なら「発話」。無ければ目録の直近の値を入れて「履歴」の印を付ける（2026-11-08 鹿内さんの決定）。
   - どちらでも決まらない行は入れずに、入れなかった行として返す。
"""

from __future__ import annotations

import json
import os
import re
import unicodedata
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path

from inputter.plan import PlanError, _check_name_text, qty_tenths

from .catalog import Catalog

MODEL = "claude-opus-5-5"
KEY_FILE = Path(r"C:\Users\PRS\nda-private\anthropic-key.txt")

SYSTEM = """あなたは自動車整備工場の事務の係です。整備士が声で言った「作業の文」を、業務ソフト RacroS III の見積の明細に直します。

明細の 1 行は、下の「項目の目録」の項目CD を 1 つ選び、数量と単価を付けたものです。
- 項目CD は必ず目録の中から選ぶ。目録に無い作業は lines に入れず、unmatched に入れる。
- 目録で項目CD 0 の「自由入力の名前」に当たる作業（例: 廃タイヤの処分）は、code を 0 にし、free_name に目録の名前をそのまま書く（インチ数などは作業の文に合わせて目録の名前から選ぶ）。
- 数量・単価・金額は、作業の文に出てきた数だけを書く。言っていない数は null にする（推測で埋めない。後でプログラムが履歴から入れる）。
  ただし、タイヤ 4 本の交換で「組替・バランス・バルブ」と言った場合のように、同じ本数で行う作業の数量は、文の本数をそのまま使ってよい。
- 「技術料」の印がある項目は、工賃の行です。「4 本で 2000 円」のように合計を言ったら amount に書く。
- タイヤ・部品の銘柄やサイズ（例「ブリヂストン W300 145/80R12 80/78N LT」）は、その部品の行の name_append に、
  目録の名前の後ろに付ける形で書く（半角カナ・半角英数、先頭は「･」。例「･ﾌﾞﾘﾁﾞｽﾄﾝ W300 145/80R12 80/78N LT」、40 文字まで）。
- quote には、その行の根拠になる作業の文の一部をそのまま書く。
- 同じ作業を 2 行にしない。言い直し（「4 本、いや 2 本」）は最後の数を使い、quote に言い直しを含める。
"""

SCHEMA = {
    "type": "object",
    "properties": {
        "lines": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "code": {"type": "integer"},
                    "free_name": {"anyOf": [{"type": "string"}, {"type": "null"}]},
                    "quote": {"type": "string"},
                    "qty": {"anyOf": [{"type": "number"}, {"type": "null"}]},
                    "unit_price": {"anyOf": [{"type": "integer"}, {"type": "null"}]},
                    "amount": {"anyOf": [{"type": "integer"}, {"type": "null"}]},
                    "name_append": {"anyOf": [{"type": "string"}, {"type": "null"}]},
                },
                "required": ["code", "free_name", "quote", "qty", "unit_price", "amount", "name_append"],
                "additionalProperties": False,
            },
        },
        "unmatched": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"quote": {"type": "string"}, "reason": {"type": "string"}},
                "required": ["quote", "reason"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["lines", "unmatched"],
    "additionalProperties": False,
}


def catalog_text(c: Catalog, limit: int = 450) -> str:
    """目録を、Claude に見せる文にする（客の情報は入っていない）。回数の多い順。"""
    out = ["# 項目の目録（項目CD | マスタの名前 | 種類 | 既定の作業区分 | 直近の数量×単価 | 回数）"]
    # 明細の名前の履歴（自由に書ける欄）は、客の名前が入りうるので送らない。項目の名前はマスタの名前だけ（Codex の指摘）
    for it in sorted(c.items.values(), key=lambda i: -i.n)[:limit]:
        kind = "技術料" if it.labor else "部品"
        q = f"{it.last_qty_tenths / 10:g}×{it.last_unit_price}" if it.last_unit_price else "-"
        out.append(f"{it.code} | {it.name.strip()} | {kind} | {it.kbn1} | {q} | {it.n}")
    out.append("")
    out.append("# 自由入力の名前（項目CD 0 で使う。名前 | 作業区分 | 直近の数量×単価 | 回数）")
    for f in sorted(c.free.values(), key=lambda f: -f.n):
        q = f"{f.last_qty_tenths / 10:g}×{f.last_unit_price}" if f.last_unit_price else "-"
        out.append(f"{f.name} | {f.work_kind} | {q} | {f.n}")
    return "\n".join(out)


def _client():
    import anthropic

    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key and KEY_FILE.exists():
        key = KEY_FILE.read_text(encoding="utf-8").strip()
    return anthropic.Anthropic(api_key=key) if key else anthropic.Anthropic()


def ask_claude(work: str, c: Catalog, client=None) -> dict:
    client = client or _client()
    resp = client.messages.create(
        model=MODEL,
        max_tokens=16000,
        output_config={"effort": "high", "format": {"type": "json_schema", "schema": SCHEMA}},
        system=[{"type": "text", "text": SYSTEM}, {"type": "text", "text": catalog_text(c), "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": f"作業の文:\n{work}"}],
    )
    if resp.stop_reason != "end_turn":
        raise RuntimeError(f"Claude の答えが最後まで来ない（{resp.stop_reason}）")
    text = next(b.text for b in resp.content if b.type == "text")
    return json.loads(text)


# ---- 確かめ ----


def _norm(text: str) -> str:
    return unicodedata.normalize("NFKC", text).replace(",", "").replace(" ", "").replace("　", "")


def spoken_numbers(text: str) -> set[Decimal]:
    """作業の文に出てくる数（全角数字・桁区切りのカンマを直す）。"""
    return {Decimal(m) for m in re.findall(r"\d+(?:\.\d+)?", _norm(text))}


UNITS = r"(?:本|個|台|枚|L|ℓ|リットル|セット|ヶ所|か所|箇所|回|缶|袋)"  # 数え方（数量にも「/本」の単価の印にも使う）
# 数え方のすぐ後ろに英字が続くもの（100mm・4LT など）は数量でない（Codex の指摘）
_COUNT = re.compile(r"(?<![\d./／])(\d+(?:\.\d+)?)" + UNITS + r"(?![A-Za-z])")
# 漢数字・「万」などを含む数量・金額は読まない（「1 万 2000 円」の 2000 円だけを拾わない。Codex の指摘）
_KANJI_NUM = re.compile(r"[〇一二三四五六七八九十百千万億]+(?:" + UNITS[3:-1] + r"|円)|\d[万千百億]|[万千百億]\d|(?<!\d)\.\d")  # 「.5L」のように小数点で始まる数も読まない
_YEN = re.compile(r"(?<![\d.])(\d+)円")  # 小数の円（1000.50 円）の末尾だけを拾わない
# 「あたり」の言い方（送り仮名の違いも）。単価の印・数量から外す言い方・「2 本あたり」の検出で同じものを使う（Codex の指摘）
PER = r"(?:あたり|当たり|当り|アタリ|につき|ごと|毎)"
PER_WORD = r"(?:あたり|当たり|当り|アタリ|につき)"  # 数が前に無くても単価の印になる言い方（「ごと」「毎」は「ホイールごと」「毎回」があるので含めない）
_YEN_TAIL = re.compile(r"(?:$|[、。/／]|ずつ|づつ|の単価|で(?![\dはも])|を|と|です|でした|になる|になります|" + "(?:あたり|当たり|当り|アタリ|につき)" + r"|[/／](?:1(?:\.0+)?)?(?:本|個|台|枚|L|ℓ|リットル|セット|ヶ所|か所|箇所|回|缶|袋))")
_PER_UNIT = re.compile(r"(?:^|[^\d.])1(?:\.0+)?" + UNITS + PER + r"?$|単価|" + PER_WORD + r"|ずつ|づつ|@|一本|一個")
# 作業の文のどこかに負の数・値引きがあれば、その指示は自動で入れない（文脈の数量にも使わない。Codex の指摘）
_NEGATIVE = re.compile(r"[-−‐]\s*\d|マイナス|値引|割引")
# 「イヤ」は前がカタカナでないとき（「タイヤ」の一部でない）だけ。「いえ」は「言えば」などに含まれるので入れない
_CORRECTION = re.compile(r"(?:いや|(?<![ァ-ヶー])イヤ|じゃなく|ではなく|ちがう|違う|違った|訂正|やっぱ|間違|まちが|すまん|ごめん)")
_TOTAL = re.compile(r"(?:で|合計|全部|計|込み|込)$")


_ONLY_ATTR = re.compile(r"(?:\d+(?:\.\d+)?(?:本|個|台|枚|L|リットル|セット|缶|袋)?(?:あたり|当たり|当り|アタリ|につき|ごと|毎)?\d*円?|単価|合計|全部|ずつ|で|は|も|を|が|の|に)+")


def clauses(work: str) -> list[str]:
    """作業の文を節に分ける。「。」「、」で区切り、言い直しで始まる区切りと、数・円だけの区切り（「1 本 5000 円」）は前の節につなげる。"""
    out: list[str] = []
    for sent in _norm(work).split("。"):
        for seg in sent.split("、"):
            if not seg:
                continue
            # 言い直しと、数・円だけの区切り（「1 本 500 円」）は、「。」をまたいでも前の節につなぐ
            # （「4 本で 2000 円。いや 2 本で…」。品名の無い区切りは前の作業の数。Codex の指摘）
            if out and out[-1] and (_CORRECTION.match(seg) or _ONLY_ATTR.fullmatch(seg)):
                out[-1] = out[-1].rstrip("。") + "、" + seg
            else:
                out.append(seg)
        if out:
            out[-1] += "。"
    return [c.rstrip("。") for c in out]


def find_clause(work: str, quote: str) -> str | None:
    """根拠（quote）が重なる節をつないで返す。根拠が作業の文に無い・2 か所以上にある・数字の途中で切れているなら None。
    根拠が 2 つの節にまたがるとき（「W300、145/80R12 … を 4 本」）は、その節をつないだものを返す。"""
    q = re.sub(r"[、。]+", "、", _norm(quote)).strip("、")  # 節の区切りは「、」にそろえて探す
    cs = clauses(work)
    joined = "、".join(cs)  # 節の区切りを「、」にそろえた作業の文
    if not q:
        return None
    spans = []
    i = joined.find(q)
    while i >= 0:
        before = joined[i - 1] if i > 0 else ""
        after = joined[i + len(q)] if i + len(q) < len(joined) else ""
        if not (before.isdigit() and q[0].isdigit()) and not (after.isdigit() and q[-1].isdigit()):
            spans.append((i, i + len(q)))
        i = joined.find(q, i + 1)
    if len(spans) != 1:
        return None
    start, end = spans[0]
    out, pos = [], 0
    for c in cs:
        if pos < end and start < pos + len(c):
            out.append(c)
        pos += len(c) + 1
    # 2 つ以上の節にまたがり、数（本・円）のある節が 2 つ以上なら、別の作業の数を取り違えうるので使わない（Codex の指摘）
    if sum(1 for c in out if quote_counts(c) or quote_yen(c)) > 1:
        return None
    return "、".join(out) if out else None


def quote_counts(quote: str) -> list[Decimal]:
    """根拠の文の中の「数＋本・個など」の数を、言った順に。言い直しは最後の数が正。"""
    q = _norm(quote)
    # 「1 本 5000 円」「1 本あたり」の「1 本」は値段の言い方なので、数量に数えない
    return [Decimal(m.group(1)) for m in _COUNT.finditer(q)
            if not (Decimal(m.group(1)) == 1 and re.match(PER + r"?(?:単価|の値段)?\d+円|" + PER, q[m.end():]))]


def quote_yen(quote: str) -> list[tuple[Decimal, str]]:
    """根拠の文の中の「数＋円」を、(数, 種類) で。種類は per_unit（1 本 5000 円）・total（4 本で 2000 円）・unknown。"""
    q = _norm(quote)
    out = []
    prev = 0
    for m in _YEN.finditer(q):
        # 金額の前は、1 つ前の金額の後ろ（節の頭）から全部を見る（決まった文字数で切ると「1.0000 本」を見落とす。Codex の指摘）
        before = q[prev:m.start()]
        # 言い直しの言葉より前（撤回した分）の手がかりは見ない（Codex の指摘）
        cut = [c.end() for c in _CORRECTION.finditer(before)]
        if cut:
            before = before[cut[-1]:]
        prev = m.end()
        after = q[m.end():]  # 後ろも節の終わりまで見る（決まった文字数で切ると「/1.000000 本」を見落とす。Codex の指摘）
        # 単価の言い方は、金額の前（1 本 5000 円・単価）にも後ろ（5000 円ずつ・5000 円/本）にもある（Codex の指摘）
        # 「/」は「/本」のように数え方が続くときだけ単価の印（区切りの「/」と分ける）。前と後ろで食い違えば conflict（入れない）
        per = bool(_PER_UNIT.search(before) or re.match(r"(?:ずつ|づつ|の単価|" + PER_WORD + r"|[/／](?:1(?:\.0+)?)?" + UNITS + r"(?:" + PER + r"|(?![一-龯ぁ-んァ-ヶA-Za-z])))", after))
        total = bool(_TOTAL.search(before))
        kind = "conflict" if per and total else ("per_unit" if per else ("total" if total else "unknown"))
        # 金額のすぐ後ろは、決まった言い方だけを通す。それ以外（「2000 円引き」「円のところ」など）は読めないとする（Codex の指摘 30 回）
        if not _YEN_TAIL.match(after):
            kind = "unreadable"
        out.append((Decimal(m.group(1)), kind))
    return out


@dataclass
class Line:
    code: int
    name: str  # マスタの名前か自由入力の名前
    qty: Decimal
    unit_price: int
    name_append: str | None
    labor: bool
    qty_from: str  # 発話 / 履歴
    price_from: str  # 発話 / 履歴
    quote: str
    work_kind: int | None = None


@dataclass
class Result:
    lines: list[Line] = field(default_factory=list)
    skipped: list[tuple[str, str]] = field(default_factory=list)  # (根拠の文, 理由)


def _dec(v) -> Decimal | None:
    if v is None or isinstance(v, bool):
        return None
    try:
        return Decimal(str(v))
    except Exception:
        return None


def finish(raw: dict, work: str, c: Catalog) -> Result:
    res = Result()
    seen: set = set()
    for u in raw.get("unmatched", []):
        res.skipped.append((str(u.get("quote", "")), str(u.get("reason", "目録に無い"))))
    for r in raw.get("lines", []):
        quote = str(r.get("quote", ""))
        code = r.get("code")
        if not isinstance(code, int) or isinstance(code, bool):
            res.skipped.append((quote, "項目CD が整数でない"))
            continue
        if code == 0:
            f = c.free.get(str(r.get("free_name") or ""))
            if f is None:
                res.skipped.append((quote, "自由入力の名前が目録に無い"))
                continue
            # 自由入力の行は、技術料に入る作業（廃タイヤ: 作業区分 31）でも、人は数量と単価を打ち、
            # 業務ソフトが作業区分から技術料に回していた（11/7 の記録と DB）。なので部品の行の道（数量・単価）で入れる
            name, labor, work_kind = f.name, False, f.work_kind
            hist_qty, hist_price = f.last_qty_tenths, f.last_unit_price
            append = None
        else:
            it = c.items.get(code)
            if it is None:
                res.skipped.append((quote, "項目CD が目録に無い"))
                continue
            name, labor, work_kind = it.name, it.labor, None
            hist_qty, hist_price = it.last_qty_tenths, it.last_unit_price
            append = r.get("name_append")
            if append is not None:
                try:
                    _check_name_text(append, "名前の書き足し")
                except PlanError:
                    res.skipped.append((quote, "名前の書き足しが 40 文字までの印字できる文字でない"))
                    continue
        # 根拠の文は、作業の文にそのまま含まれていなければ使わない（数の出どころを確かめられない）
        # 数は、Claude が選んだ根拠の範囲でなく、作業の文をプログラムで区切った「節」の全体から読む（Codex の指摘 5 回）。
        # 根拠は、ちょうど 1 つの節の中に、数字の途中で切れずに入っていなければ使わない
        clause = find_clause(work, quote)
        if clause is None:
            res.skipped.append((quote, "根拠の文が、作業の文の 1 つの節に入っていない"))
            continue
        quote = clause
        # 1 つの節に数量・金額が 2 つ以上あり、言い直しの言葉が無ければ、別の作業の数が混ざっている（Codex の指摘）
        # 言い直しがあるときは、言い直しの言葉で区切った各部分に、数量・金額がそれぞれ 1 つずつまでのときだけ通す
        # （「組替 4 本 2000 円とバランス 4 本 800 円、いやバランス 2 本 600 円」は、最初の部分に 2 つずつあるので通さない）
        parts = _CORRECTION.split(clause)
        if any(len(quote_counts(pt)) > 1 or len(quote_yen(pt)) > 1 for pt in parts):  # 同じ値でも、出た回数で数える（Codex の指摘）
            res.skipped.append((quote, "1 つの節に数量か金額が 2 つ以上ある"))
            continue
        # 言い直しがあれば、言い直しの前に出た種類の数（数量・金額）は、最後の言い直しの後にも言われていること。
        # 取り消したのに代わりが無い数（「2000 円、いや無料で 2 本」の金額）は使わない（Codex の指摘 2 回）
        parts = _CORRECTION.split(clause)
        if len(parts) > 1:
            earlier, last = "".join(parts[:-1]), parts[-1]
            if (quote_yen(earlier) and not quote_yen(last)) or (quote_counts(earlier) and not quote_counts(last)):
                res.skipped.append((quote, "言い直したのに、言い直しの後に数が無い"))
                continue
        if _KANJI_NUM.search(_norm(work)):  # 作業の文の全体で見る（文脈の数量にも入り込ませない。Codex の指摘）
            res.skipped.append((quote, "漢数字や「万」を含む数は自動で読まない"))
            continue
        # 「2 本あたり 10000 円」のように 1 以外の数を基準にした値段は、単価に直さず入れない（Codex の指摘）
        bundles = re.finditer(r"(?<![\d.])(\d+(?:\.\d+)?)" + UNITS + PER, clause)
        slashed = re.finditer(r"[/／](\d+(?:\.\d+)?)" + UNITS, clause)  # 「10000 円/2 本」
        if any(Decimal(m.group(1)) != 1 for m in bundles) or any(Decimal(m.group(1)) != 1 for m in slashed):  # 節の中のすべてを見る（言い直しの後の分も。Codex の指摘）
            res.skipped.append((quote, "1 以外の数あたりの値段は自動で入れない"))
            continue
        # 負の数・値引きは扱わない（「-2000 円」を 2000 円と読まない。作業の文の全体で見る）。小数の円も入れない。長音「ー」と「引取」は含めない
        if _NEGATIVE.search(_norm(work)) or re.search(r"\d\.\d+円", clause):
            res.skipped.append((quote, "負の数か値引きは自動で入れない"))
            continue
        # 同じ項目CD（自由入力は名前）を同じ節から 2 回入れない（Codex の指摘）
        key = (code, str(r.get("free_name") or "") if code == 0 else "", clause)
        if key in seen:
            res.skipped.append((quote, "同じ作業が 2 回ある"))
            continue
        seen.add(key)
        # 数量: 根拠の文の「数＋本・個など」の最後の数（言い直しは最後が正）。Claude の数がそれと違えば使わない。
        # 根拠の文に無ければ、作業の文の「数＋本」がただ 1 つの値のとき（例: 4 本の交換で、バランスも）だけそれを使う。
        # どちらも無ければ履歴の数量にして印を付ける（Codex の指摘 2 回）
        qty = _dec(r.get("qty"))
        counts = quote_counts(quote)
        # 文脈の数量は、各節の最後の数（言い直しの後の数）だけから決める（撤回した数を候補に入れない。Codex の指摘）
        # 文脈の数量は、作業の文に言い直しが無く、数量がすべて同じ値のときだけ（例: 4 本の交換で、バランスも）。
        # 言い直しがあれば文脈では決めず履歴にする（どの数が生きているかを節をまたいで決めない。Codex の指摘 3 回）
        all_counts = set() if _CORRECTION.search(_norm(work)) else set(quote_counts(work))
        if counts:
            if qty != counts[-1]:
                res.skipped.append((quote, "数量が、根拠の文の最後の数と合わない"))
                continue
            qty_from = "発話"
        elif qty is not None and all_counts == {qty}:
            qty_from = "文脈"
        else:
            qty, qty_from = (Decimal(hist_qty) / 10 if hist_qty else None), "履歴"
        if qty is None or qty <= 0:
            res.skipped.append((quote, "数量が言われておらず、履歴にも無い"))
            continue
        try:
            qty_tenths(qty)
        except PlanError:
            res.skipped.append((quote, "数量が 0.1 刻みでない"))
            continue
        # 値段: 根拠の文の「数＋円」を、形で単価（1 本 5000 円・単価）と合計（4 本で 2000 円）に分ける。
        # 形で分からない数は、Claude が単価・合計のどちらと言ったかに合わせる。どちらでもない数は使わない。
        # 言い直しは最後の数が正。円の数が無ければ履歴の単価にして印を付ける
        price, amount = r.get("unit_price"), r.get("amount")
        yen = quote_yen(quote)
        price_from = "発話"
        if yen:
            v, kind = yen[-1]
            if kind == "unreadable":
                res.skipped.append((quote, "金額の後ろの言い方を読めない"))
                continue
            if kind == "conflict":
                res.skipped.append((quote, "言われた金額が単価か合計か、言い方が食い違う"))
                continue
            if kind == "unknown":
                # 言い方で決まらないときは、Claude が単価・合計のどちらに書いたかに合わせ、「解釈」の印を付ける
                kind = "total" if isinstance(amount, int) and Decimal(amount) == v else (
                    "per_unit" if isinstance(price, int) and Decimal(price) == v else "unknown")
                price_from = "解釈"
            if kind == "per_unit":
                price = int(v)
            elif kind == "total":
                each = v / qty
                if each != each.to_integral_value():
                    res.skipped.append((quote, "言われた合計が数量で割り切れない"))
                    continue
                price = int(each)
            else:
                res.skipped.append((quote, "言われた金額が単価か合計か分からない"))
                continue
        else:
            price, price_from = hist_price, "履歴"
        if price is None:
            res.skipped.append((quote, "単価が言われておらず、履歴にも無い"))
            continue
        if labor and (qty * price) != (qty * price).to_integral_value():
            res.skipped.append((quote, "技術料が 1 円単位にならない"))
            continue
        res.lines.append(Line(code=code, name=name, qty=qty, unit_price=int(price), name_append=append, labor=labor,
                              qty_from=qty_from, price_from=price_from, quote=quote, work_kind=work_kind))
    return res


def to_job(res: Result, job_id: str, customer_code: int, car_code: int) -> tuple[dict, dict, list[int]]:
    """inputter.plan.build_plan に渡す job と品目の表、作業の行の項目CD の list を作る。"""
    items: dict[str, int] = {}
    kinds: dict[str, int] = {}
    lines = []
    for ln in res.lines:
        key = ln.name if ln.code == 0 else f"{ln.code}:{ln.name}"
        items[key] = ln.code
        if ln.code == 0:
            kinds[key] = ln.work_kind
        line = {"item": key, "qty": ln.qty, "unit": None, "unitPrice": ln.unit_price}
        if ln.name_append:
            line["name_append"] = ln.name_append
        lines.append(line)
    job = {"job_id": job_id, "customer_code": customer_code, "car_code": car_code, "lines": lines}
    labor = sorted({ln.code for ln in res.lines if ln.labor and ln.code != 0})
    return job, {"items": items, "free_work_kind": kinds}, labor


def summary(res: Result) -> list[str]:
    out = []
    for i, ln in enumerate(res.lines, start=1):
        marks = [m for m, f in (("数量は履歴から", ln.qty_from == "履歴"), ("単価は履歴から", ln.price_from == "履歴"),
                                ("単価か合計かは Claude の解釈", ln.price_from == "解釈")) if f]
        kind = "技術料" if ln.labor else ("自由入力" if ln.code == 0 else "部品")
        nm = ln.name.strip() + (ln.name_append or "")
        out.append(f"{i}. {ln.code} {nm}（{kind}） {ln.qty:g} × {ln.unit_price} = {int(ln.qty * ln.unit_price)}"
                   + (f"  ※{'・'.join(marks)}" if marks else ""))
    for q, why in res.skipped:
        out.append(f"入れなかった: 「{q}」… {why}")
    return out
