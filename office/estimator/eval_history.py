"""過去の納品書 20 枚で、作業の文 → 項目CD の当たり率を測る（読むだけ。業務ソフトには何も送らない）。

1. DB から最近の納品書 20 枚の明細を読む（客・車・伝票番号の値は使わない。eval_history.sql）。
2. 明細（マスタの名前・数量・金額）から、整備士が声で言いそうな「作業の文」を Claude に作らせる。
   このとき項目CD は渡さない。作った文は、伝票ごとに C:\\nda\\box\\cache\\eval\\ に残す（Git に入れない）。
3. その文を interpret（Claude ＋ 確かめ）に通し、入った項目CD・数量・金額が元の伝票と合うかを数える。
使い方: python -m estimator.eval_history [--since 20260601]
"""

from __future__ import annotations

import argparse
import json
import subprocess
import unicodedata
from collections import Counter
from pathlib import Path

from . import catalog, interpret
from .__main__ import CACHE, READER

HERE = Path(__file__).parent
OUT = Path(r"C:\nda\box\cache\eval")

SAY_SYSTEM = """あなたは自動車整備工場の整備士です。下の伝票の明細を、作業を終えたあとに事務の係へ声で伝えるときの言い方に直してください。
- 品名はマスタの名前を言い換え、ふだんの話し言葉にする（例「ﾀｲﾔ･組み替え」→「タイヤ組替」）。項目の番号は言わない。
- 数量（本・個・L など）と金額（合計か単価のどちらか）は必ず言う。
- 1 つの文章で、句点で区切る。前置きや説明は書かず、言う文だけを書く。"""


def read_slips(since: int) -> dict[int, list[dict]]:
    cmd = ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(HERE / "catalog.ps1"),
           "-ReaderFile", READER, "-SqlFile", str(HERE / "eval_history.sql"), "-Since", str(since)]
    p = subprocess.run(cmd, capture_output=True, timeout=300, check=True)
    rows = json.loads(p.stdout.decode("utf-8-sig"))[0]
    slips: dict[int, list[dict]] = {}
    for r in rows:
        slips.setdefault(int(r["slip"]), []).append(r)
    return slips


def say(lines: list[dict], c: catalog.Catalog, client) -> str:
    desc = []
    for r in lines:
        it = c.items.get(int(r["code"]))
        name = unicodedata.normalize("NFKC", it.name if it else "不明")
        qty = (r["su"] or 0) / 10
        amount = (r["bkin"] or 0) + (r["skin"] or 0)
        desc.append(f"- {name} 数量 {qty:g} 金額 {amount} 円")
    resp = client.messages.create(model=interpret.MODEL, max_tokens=4000, output_config={"effort": "low"},
                                  system=SAY_SYSTEM, messages=[{"role": "user", "content": "\n".join(desc)}])
    return next(b.text for b in resp.content if b.type == "text").strip()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", type=int, default=20260601)
    args = ap.parse_args()
    c = catalog.load(READER, CACHE)
    client = interpret._client()
    OUT.mkdir(parents=True, exist_ok=True)
    total = hit = exact = 0
    for n, lines in sorted(read_slips(args.since).items()):
        work = say(lines, c, client)
        res = interpret.finish(interpret.ask_claude(work, c, client), work, c)
        want = Counter(int(r["code"]) for r in lines)
        got = Counter(ln.code for ln in res.lines)
        h = sum((want & got).values())
        amounts_ok = sorted(int(r["bkin"] + r["skin"]) for r in lines) == sorted(int(ln.qty * ln.unit_price) for ln in res.lines)
        total += sum(want.values())
        hit += h
        exact += int(want == got and amounts_ok)
        (OUT / f"slip-{n:02d}.json").write_text(json.dumps(
            {"work": work, "want": sorted(want.elements()), "got": sorted(got.elements()), "amounts_ok": amounts_ok,
             "summary": interpret.summary(res)}, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"伝票 {n:2d}: 項目CD {h}/{sum(want.values())} 合致・金額 {'合う' if amounts_ok else '違う'}")
    print(f"合計: 項目CD {hit}/{total}（{hit / total:.0%}）・伝票ごと完全一致 {exact}/20")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
