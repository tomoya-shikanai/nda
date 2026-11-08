"""声の指示（estimate.instruction）を、全部自動で伝票に入れる（box run --auto）。

流れ: 客と車（#55 の resolve、check_instruction の中）→ 明細（estimator: 目録＋Claude＋確かめ）→ 窓を開く（opener）
→ 明細を入れる（inputter.send）→ 保存の手前で止まる（保存は人）。人の確かめは置かない（2026-11-08 鹿内さんの決定）。
人がキーボード・マウスを触る・ダイアログ・知らない窓・確かめが合わないときは、何も押さずに止まる。
出すのは項目CD・名前・数量・単価・印だけ。客の名前・ナンバー・番号は出さない。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from estimator import catalog, interpret
from inputter import send as sendmod
from inputter.plan import COLUMNS_PATH, build_plan, load_json
from opener.open import OPENPATH, Target

from . import lookup
from .inbox import Abort

CACHE = Path(r"C:\nda\box\cache\catalog.json")


@dataclass
class Prepared:
    kp: object
    columns: dict
    groups: list
    target: Target
    summary: list[str]
    lines: int


def opener_confirmed() -> bool:
    data = json.loads(OPENPATH.read_text(encoding="utf-8"))
    return isinstance(data, dict) and data.get("confirmed") is True


def prepare(job: dict, cfg: dict, ask=interpret.ask_claude, look=lookup.lookup, load_catalog=None,
            need_confirmed: bool = True) -> Prepared:
    """作業の文から明細と送る手順を作る。何も送らない。作れなければ例外。"""
    reader = cfg.get("db_reader_file")
    if not reader:
        raise RuntimeError("db_reader_file が無い")
    c = load_catalog() if load_catalog else catalog.load(reader, CACHE)
    res = interpret.finish(ask(job["work"], c), job["work"], c)
    if not res.lines:
        raise RuntimeError("入れる行が無い")
    ijob, items, labor = interpret.to_job(res, job["job_id"], job["customer_code"], job["car_code"])
    columns = dict(load_json(COLUMNS_PATH), labor_codes=labor)
    kp = sendmod.load_keypath(load_json(sendmod.KEYPATH_PATH))
    if need_confirmed and not (columns.get("confirmed") is True and kp.confirmed):
        # 送るのに使う、この読み込んだ設定そのものの確認済みを見る（ファイルを別に読み直さない。Codex の指摘）
        raise RuntimeError("keypath.json か columns.json が確認済みでない")
    steps = build_plan(ijob, items, columns)
    groups = sendmod.prepare(steps, kp, columns)
    info = look(reader, job["customer_code"], job["car_code"])
    target = Target(vehicle_no=info.no, customer_name=info.title_name, kind=job["slip_kind"],
                    plate_bango=info.bango, plate_kana=info.kana, list_rows=info.list_rows)
    return Prepared(kp=kp, columns=columns, groups=groups, target=target, summary=interpret.summary(res),
                    lines=len(res.lines))


def enter(p: Prepared, log: Callable[[str], None], stop_at_list: bool = False, desk_factory=None, open_run=None,
          send_run=None) -> int:
    """窓を開いて客を選び、明細を入れて止まる。止まれば Abort。"""
    if desk_factory is None:
        from opener.winopen import WinOpenDesktop as desk_factory
    if open_run is None:
        from opener.open import run as open_run
    send_run = send_run or sendmod.run
    if not opener_confirmed():
        # 窓を開く直前にも、openpath.json の確認済みを読み直す（Codex の指摘）
        raise Abort("other", "opener/openpath.json が確認済みでないので、窓を開かない")
    desk = desk_factory()
    try:
        w = open_run(desk, p.target, log, stop_at_list=stop_at_list)
        if w is None:
            raise Abort("other", "初回の確かめ: 一覧を読むところで止めた（何も選んでいない）")
        send_run(desk, p.kp, p.groups, log, p.target.customer_name)
    except sendmod.Stop as ex:
        log(f"止めた（これ以上は何も送らない）: {ex}")
        raise Abort("other", "途中で止まった。画面は人が確かめて閉じる") from None
    finally:
        desk.close()
    return p.lines
