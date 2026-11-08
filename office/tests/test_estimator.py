"""estimator（目録・解釈の確かめ）の試験。DB と Claude は使わず、架空の目録と、Claude の答えの形だけで確かめる。"""

import unittest
from decimal import Decimal

from estimator.catalog import build, from_json, to_json
from estimator.interpret import SCHEMA, ask_claude, catalog_text, finish, spoken_numbers, summary, to_job
from inputter.plan import build_plan

TABLES = [
    [  # 使われ方
        {"code": 278, "n": 98, "n_labor": 60, "n_part": 0, "last_su": 40, "last_tan": 0, "last_skin": 2000, "last_bkin": 0, "last_sag": 1},
        {"code": 520001, "n": 26, "n_labor": 0, "n_part": 20, "last_su": 40, "last_tan": 7260, "last_skin": 0, "last_bkin": 29040, "last_sag": 5},
        {"code": 279, "n": 14, "n_labor": 10, "n_part": 0, "last_su": 40, "last_tan": 500, "last_skin": 2000, "last_bkin": 0, "last_sag": 2},
        {"code": 296, "n": 76, "n_labor": 0, "n_part": 70, "last_su": 40, "last_tan": 100, "last_skin": 0, "last_bkin": 400, "last_sag": 5},
    ],
    [  # よく使われた名前
        {"code": 520001, "nm": "ｽﾀｯﾄﾚｽﾀｲﾔ･ﾌﾞﾘｻﾞｯｸVL10 145/80R12 80/78N LT", "c": 3},
    ],
    [  # マスタ
        {"code": 278, "nm": "ﾀｲﾔ･組み替え", "kbn1": 1, "uri_tan": 0},
        {"code": 520001, "nm": "ﾀｲﾔ", "kbn1": 5, "uri_tan": 0},
        {"code": 279, "nm": "ﾎｲｰﾙ･ﾊﾞﾗﾝｽ", "kbn1": 2, "uri_tan": 0},
        {"code": 296, "nm": "ﾀｲﾔ･ｺﾞﾑﾊﾞﾙﾌﾞ･TR413 CLX", "kbn1": 5, "uri_tan": 100},
    ],
    [  # 自由入力
        {"nm": "廃ﾀｲﾔ･12ｲﾝﾁ", "n": 6, "last_sag": 31, "last_su": 40, "last_tan": 300, "last_skin": 1200, "last_bkin": 0},
    ],
    [{"a": 278, "b": 279, "n": 50}],
]
WORK = ("タイヤ交換。ブリヂストンのW300、145/80R12 80/78N LT を4本、1本5000円。"
        "組替は4本で2000円、バランスも4本で2000円、廃タイヤ12インチ4本で1200円、ゴムバルブ4個で400円")
RAW = {
    "lines": [
        {"code": 278, "free_name": None, "quote": "組替は4本で2000円", "qty": 4, "unit_price": None, "amount": 2000, "name_append": None},
        {"code": 520001, "free_name": None, "quote": "145/80R12 80/78N LT を4本、1本5000円", "qty": 4, "unit_price": 5000, "amount": None,
         "name_append": "･ﾌﾞﾘﾁﾞｽﾄﾝ W300 145/80R12 80/78N LT"},
        {"code": 279, "free_name": None, "quote": "バランスも4本で2000円", "qty": 4, "unit_price": None, "amount": 2000, "name_append": None},
        {"code": 0, "free_name": "廃ﾀｲﾔ･12ｲﾝﾁ", "quote": "廃タイヤ12インチ4本で1200円", "qty": 4, "unit_price": None, "amount": 1200, "name_append": None},
        {"code": 296, "free_name": None, "quote": "ゴムバルブ4個で400円", "qty": 4, "unit_price": None, "amount": 400, "name_append": None},
    ],
    "unmatched": [],
}
COLUMNS = {
    "confirmed": False, "advance_key": "Enter",
    "columns": [{"field": "項目CD", "source": "code"}, {"field": "作業内容", "source": "name"},
                {"field": "作業区分", "source": "work_kind"}, {"field": "担当", "source": "none"},
                {"field": "数量", "source": "qty"}, {"field": "単価", "source": "unit_price"}],
    "labor_columns": [{"field": "項目CD", "source": "code"}, {"field": "作業内容", "source": "name"},
                      {"field": "作業区分", "source": "work_kind"}, {"field": "担当", "source": "none"},
                      {"field": "点数", "source": "none"}, {"field": "技術料", "source": "amount"}],
    "labor_codes": [], "row_end_keys": [],
}


class CatalogTest(unittest.TestCase):
    def test_build(self):
        c = build(TABLES)
        self.assertTrue(c.items[278].labor)
        self.assertFalse(c.items[520001].labor)
        self.assertEqual(c.items[278].last_unit_price, 500)  # 技術料 2000 ÷ 4 本
        self.assertEqual(c.items[520001].name, "ﾀｲﾔ")
        self.assertEqual(c.free["廃ﾀｲﾔ･12ｲﾝﾁ"].work_kind, 31)
        self.assertEqual(c.labor_codes(), [278, 279])
        self.assertEqual(to_json(from_json(to_json(c))), to_json(c))

    def test_catalog_text_has_no_customer_fields(self):
        t = catalog_text(build(TABLES))
        self.assertIn("520001 | ﾀｲﾔ | 部品", t)
        self.assertIn("廃ﾀｲﾔ･12ｲﾝﾁ | 31", t)


class FinishTest(unittest.TestCase):
    def setUp(self):
        self.c = build(TABLES)

    def test_sambar(self):
        res = finish(RAW, WORK, self.c)
        self.assertEqual(res.skipped, [])
        got = [(l.code, l.qty, l.unit_price, l.labor, l.price_from) for l in res.lines]
        self.assertEqual(got, [
            (278, 4, 500, True, "発話"), (520001, 4, 5000, False, "発話"), (279, 4, 500, True, "発話"),
            (0, 4, 300, False, "発話"), (296, 4, 100, False, "発話"),
        ])
        self.assertEqual(sum(l.qty * l.unit_price for l in res.lines), 25600)
        job, items, labor = to_job(res, "t", 9001, 9002)
        self.assertEqual(labor, [278, 279])
        cols = dict(COLUMNS, labor_codes=labor)
        steps = build_plan(job, items, cols)
        self.assertIn({"field": "明細1.技術料", "action": "type", "value": "2000"}, steps)
        self.assertIn({"field": "明細2.作業内容", "action": "append", "value": "･ﾌﾞﾘﾁﾞｽﾄﾝ W300 145/80R12 80/78N LT"}, steps)
        self.assertIn({"field": "明細4.作業区分", "action": "type", "value": "31"}, steps)
        self.assertIn({"field": "明細4.作業内容", "action": "type", "value": "廃ﾀｲﾔ･12ｲﾝﾁ"}, steps)

    def test_history_price_is_marked(self):
        raw = {"lines": [dict(RAW["lines"][2], amount=None, quote="バランスもやっといて")], "unmatched": []}
        res = finish(raw, "タイヤ4本交換、バランスもやっといて", self.c)
        self.assertEqual((res.lines[0].unit_price, res.lines[0].price_from), (500, "履歴"))
        self.assertIn("単価は履歴から", summary(res)[0])

    def test_numbers_not_in_text_are_not_trusted(self):
        # Claude が言っていない単価を書いても、発話の数でなければ履歴の値にして印を付ける
        raw = {"lines": [dict(RAW["lines"][1], quote="タイヤ交換", unit_price=9999)], "unmatched": []}
        res = finish(raw, "タイヤ交換", self.c)
        self.assertEqual((res.lines[0].unit_price, res.lines[0].price_from), (7260, "履歴"))

    def test_qty_not_in_text_falls_back_to_history(self):
        raw = {"lines": [dict(RAW["lines"][1], qty=9999, unit_price=None, quote="タイヤ交換")], "unmatched": []}
        res = finish(raw, "タイヤ交換", self.c)
        self.assertEqual((res.lines[0].qty, res.lines[0].qty_from), (4, "履歴"))
        self.assertIn("数量は履歴から", summary(res)[0])

    def test_total_written_as_unit_price_uses_total(self):
        raw = {"lines": [dict(RAW["lines"][0], unit_price=2000, amount=2000)], "unmatched": []}
        res = finish(raw, "組替は4本で2000円", self.c)
        self.assertEqual(res.lines[0].unit_price, 500)
        # 「4 本で 2000 円」は形で合計と分かるので、Claude が単価・合計のどちらに書いても 500 円にする（Codex の指摘）
        for p_, a_ in ((2000, None), (300, 2000), (None, None)):
            raw = {"lines": [dict(RAW["lines"][0], unit_price=p_, amount=a_)], "unmatched": []}
            res = finish(raw, "組替は4本で2000円", self.c)
            self.assertEqual(res.lines[0].unit_price, 500, (p_, a_))

    def test_correction_uses_last_count(self):
        work = "組替は4本、いや2本。1本500円"
        raw = {"lines": [dict(RAW["lines"][0], quote=work, qty=4, unit_price=500, amount=None)], "unmatched": []}
        self.assertEqual(finish(raw, work, self.c).lines, [])  # 撤回した 4 は使わない
        raw = {"lines": [dict(RAW["lines"][0], quote=work, qty=2, unit_price=500, amount=None)], "unmatched": []}
        ln = finish(raw, work, self.c).lines[0]
        self.assertEqual((ln.qty, ln.unit_price), (2, 500))

    def test_quote_cut_before_correction_is_extended(self):
        # 根拠を言い直しの手前で切っても、言い直しまで読む（Codex の指摘）
        work = "組替は4本、いや2本。1本500円"
        raw = {"lines": [dict(RAW["lines"][0], quote="組替は4本", qty=4, unit_price=None, amount=None)], "unmatched": []}
        self.assertEqual(finish(raw, work, self.c).lines, [])
        work = "組替は4本で2000円、いや2本で1000円。"
        raw = {"lines": [dict(RAW["lines"][0], quote="組替は4本で2000円、", qty=4, amount=2000, unit_price=None)], "unmatched": []}
        self.assertEqual(finish(raw, work, self.c).lines, [])
        raw = {"lines": [dict(RAW["lines"][0], quote="組替は4本で2000円、", qty=2, amount=1000, unit_price=None)], "unmatched": []}
        ln = finish(raw, work, self.c).lines[0]
        self.assertEqual((ln.qty, ln.unit_price), (2, 500))
        # 言い直しでない「、」の後（次の作業）は読まない
        work = "組替は4本で2000円、バランスも4本で2000円"
        raw = {"lines": [dict(RAW["lines"][0], quote="組替は4本で2000円")], "unmatched": []}
        self.assertEqual(finish(raw, work, self.c).lines[0].unit_price, 500)

    def test_personal_names_are_not_in_catalog(self):
        t = [TABLES[0], TABLES[1], TABLES[2],
             TABLES[3] + [{"nm": "山田様持込タイヤ処分", "n": 9, "last_sag": 31, "last_su": 40, "last_tan": 300, "last_skin": 1200, "last_bkin": 0}],
             TABLES[4]]
        c = build(t)
        self.assertNotIn("山田様持込タイヤ処分", c.free)
        self.assertNotIn("ｽﾀｯﾄﾚｽﾀｲﾔ", catalog_text(c))  # 明細の名前の履歴は送らない
        t2 = [TABLES[0] + [{"code": 123, "n": 3, "n_labor": 0, "n_part": 3, "last_su": 10, "last_tan": 100, "last_skin": 0,
                            "last_bkin": 100, "last_sag": 5}], TABLES[1] + [{"code": 123, "nm": "山田様持込タイヤ", "c": 3}],
              TABLES[2], TABLES[3], TABLES[4]]
        c2 = build(t2)
        self.assertNotIn(123, c2.items)  # マスタに無い項目CD は使わない
        self.assertNotIn("山田", catalog_text(c2))

    def test_partial_or_mid_number_quotes_use_whole_clause(self):
        # 根拠を「組替は4本」で切っても、節の全体（言い直しまで）で読む（Codex の指摘 5 回目）
        work = "組替は4本で2000円、いや2本で1000円。"
        raw = {"lines": [dict(RAW["lines"][0], quote="組替は4本", qty=4, unit_price=None, amount=None)], "unmatched": []}
        self.assertEqual(finish(raw, work, self.c).lines, [])
        # 数字の途中から始まる根拠は使わない
        raw = {"lines": [dict(RAW["lines"][0], quote="2本で6000円", qty=2, unit_price=None, amount=6000)], "unmatched": []}
        self.assertEqual(finish(raw, "組替は12本で6000円", self.c).lines, [])

    def test_quote_spanning_two_jobs_or_sentence_correction(self):
        work = "組替は4本で2000円、バランスは2本で600円"
        raw = {"lines": [dict(RAW["lines"][0], quote=work, qty=2, amount=600, unit_price=None)], "unmatched": []}
        self.assertEqual(finish(raw, work, self.c).lines, [])  # 2 つの作業にまたがる根拠は使わない
        work = "組替は4本で2000円。いや2本で1000円。"
        raw = {"lines": [dict(RAW["lines"][0], quote="組替は4本で2000円", qty=4, amount=2000, unit_price=None)], "unmatched": []}
        self.assertEqual(finish(raw, work, self.c).lines, [])  # 「。」をまたぐ言い直しも読む

    def test_two_jobs_in_one_clause_negative_and_duplicates(self):
        work = "組替は4本で2000円とバランスは2本で600円"
        raw = {"lines": [dict(RAW["lines"][0], quote=work, qty=2, amount=600, unit_price=None)], "unmatched": []}
        self.assertEqual(finish(raw, work, self.c).lines, [])
        work = "組替は4本で-2000円"
        raw = {"lines": [dict(RAW["lines"][0], quote=work, qty=4, amount=2000, unit_price=None)], "unmatched": []}
        self.assertEqual(finish(raw, work, self.c).lines, [])
        work = "組替は4本で2000円"
        line = dict(RAW["lines"][0], quote=work, qty=4, amount=2000, unit_price=None)
        res = finish({"lines": [line, dict(line)], "unmatched": []}, work, self.c)
        self.assertEqual(len(res.lines), 1)
        self.assertIn("同じ作業が 2 回ある", res.skipped[0][1])

    def test_round8_cases(self):
        w = "タイヤ2本5000円ずつ"
        raw = {"lines": [dict(RAW["lines"][1], quote=w, qty=2, unit_price=5000, amount=None, name_append=None)], "unmatched": []}
        ln = finish(raw, w, self.c).lines[0]
        self.assertEqual((ln.qty, ln.unit_price, ln.qty_from), (2, 5000, "発話"))
        raw = {"lines": [dict(RAW["lines"][1], quote=w, qty=2, unit_price=None, amount=5000, name_append=None)], "unmatched": []}
        ln = finish(raw, w, self.c).lines[0]
        self.assertEqual(ln.unit_price, 5000)  # 「ずつ」は単価
        w = "組替は4本で2000円/バランスは別途"
        raw = {"lines": [dict(RAW["lines"][0], quote=w, qty=4, amount=2000, unit_price=None)], "unmatched": []}
        self.assertEqual(finish(raw, w, self.c).lines[0].unit_price, 500)  # 区切りの「/」は単価の印でない
        w = "組替は4本で500円ずつ"
        raw = {"lines": [dict(RAW["lines"][0], quote=w, qty=4, amount=None, unit_price=500)], "unmatched": []}
        self.assertEqual(finish(raw, w, self.c).lines, [])  # 「で」（合計）と「ずつ」（単価）が食い違う
        w = "組替4本2000円/リットル"
        raw = {"lines": [dict(RAW["lines"][0], quote=w, qty=4, amount=2000, unit_price=None)], "unmatched": []}
        self.assertEqual(finish(raw, w, self.c).lines[0].unit_price, 2000)  # 「/リットル」は単価
        w = "組替は4本で1万2000円"
        raw = {"lines": [dict(RAW["lines"][0], quote=w, qty=4, amount=2000, unit_price=None)], "unmatched": []}
        self.assertEqual(finish(raw, w, self.c).lines, [])  # 「万」の数は読まない
        w = "タイヤ1万2000本交換、バランスも"
        raw = {"lines": [dict(RAW["lines"][2], quote="バランスも", qty=2000, amount=None, unit_price=None)], "unmatched": []}
        self.assertEqual(finish(raw, w, self.c).lines, [])  # 別の節の「万」も文脈の数量にしない
        w = "ホース100mm交換、バランスも"
        raw = {"lines": [dict(RAW["lines"][2], quote="バランスも", qty=100, amount=None, unit_price=None)], "unmatched": []}
        ln = finish(raw, w, self.c).lines[0]
        self.assertEqual((ln.qty, ln.qty_from), (4, "履歴"))  # 100mm は数量でない
        w = "バランス.5本"
        raw = {"lines": [dict(RAW["lines"][2], quote=w, qty=5, amount=None, unit_price=None)], "unmatched": []}
        self.assertEqual(finish(raw, w, self.c).lines, [])  # 小数点で始まる数は読まない
        w = "タイヤ4本、いや2本。バランスも"
        raw = {"lines": [dict(RAW["lines"][2], quote="バランスも", qty=2, amount=None, unit_price=None)], "unmatched": []}
        ln = finish(raw, w, self.c).lines[0]
        self.assertEqual((ln.qty, ln.qty_from), (4, "履歴"))  # 言い直しがあれば文脈では決めない
        w = "タイヤ4本とバルブ2個交換、バランスも"
        raw = {"lines": [dict(RAW["lines"][2], quote="バランスも", qty=2, amount=None, unit_price=None)], "unmatched": []}
        ln = finish(raw, w, self.c).lines[0]
        self.assertEqual((ln.qty, ln.qty_from), (4, "履歴"))  # 4 と 2 があるので文脈では決めない
        w = "タイヤ2本あたり10000円"
        raw = {"lines": [dict(RAW["lines"][1], quote=w, qty=2, unit_price=10000, amount=None, name_append=None)], "unmatched": []}
        self.assertEqual(finish(raw, w, self.c).lines, [])  # 2 本あたりの値段は入れない
        for w in ("タイヤ2本当り10000円", "タイヤ2本ごと10000円", "タイヤ10000円/2本"):
            raw = {"lines": [dict(RAW["lines"][1], quote=w, qty=2, unit_price=10000, amount=None, name_append=None)], "unmatched": []}
            self.assertEqual(finish(raw, w, self.c).lines, [], w)
        w = "組替4本500円/1本"
        raw = {"lines": [dict(RAW["lines"][0], quote=w, qty=4, amount=None, unit_price=500)], "unmatched": []}
        self.assertEqual(finish(raw, w, self.c).lines[0].unit_price, 500)  # 「/1 本」は単価
        w = "タイヤ4本5000円/本あたり"
        raw = {"lines": [dict(RAW["lines"][1], quote=w, qty=4, amount=5000, unit_price=None, name_append=None)], "unmatched": []}
        self.assertEqual(finish(raw, w, self.c).lines[0].unit_price, 5000)  # 「/本あたり」は単価
        for w in ("組替は4本で2000円引き", "組替は4本で2000円値引き", "組替は4本で2000円のところ",
                  "組替は4本で2000円ではなく無料", "組替は4本で2000円、いや無料", "組替は4本で2000円、いや無料で2本", "組替は4本で2000円、イヤ無料で2本"):
            raw = {"lines": [dict(RAW["lines"][0], quote=w, qty=4, amount=2000, unit_price=None)], "unmatched": []}
            self.assertEqual(finish(raw, w, self.c).lines, [], w)
        w = "組替4本2000円/本日はこれだけ"
        raw = {"lines": [dict(RAW["lines"][0], quote=w, qty=4, amount=2000, unit_price=None)], "unmatched": []}
        self.assertEqual(finish(raw, w, self.c).lines[0].unit_price, 500)  # 「/本日」は単価の印でない
        w = "組替4本500円ずつ、いや4本で2000円"
        raw = {"lines": [dict(RAW["lines"][0], quote=w, qty=4, amount=2000, unit_price=None)], "unmatched": []}
        self.assertEqual(finish(raw, w, self.c).lines[0].unit_price, 500)  # 言い直しの後の「4 本で 2000 円」
        w = "組替4本2000円/1.000000本"
        raw = {"lines": [dict(RAW["lines"][0], quote=w, qty=4, amount=2000, unit_price=None)], "unmatched": []}
        self.assertEqual(finish(raw, w, self.c).lines[0].unit_price, 2000)
        w = "ホイールごと組替は4本で2000円"
        raw = {"lines": [dict(RAW["lines"][0], quote=w, qty=4, amount=2000, unit_price=None)], "unmatched": []}
        self.assertEqual(finish(raw, w, self.c).lines[0].unit_price, 500)  # 「ホイールごと」は単価の印でない
        w = "タイヤ1本あたり5000円、いや2本あたり10000円"
        raw = {"lines": [dict(RAW["lines"][1], quote=w, qty=2, unit_price=10000, amount=None, name_append=None)], "unmatched": []}
        self.assertEqual(finish(raw, w, self.c).lines, [])
        w = "タイヤ1本あたり単価5000円"
        raw = {"lines": [dict(RAW["lines"][1], quote=w, qty=1, unit_price=5000, amount=None, name_append=None)], "unmatched": []}
        ln = finish(raw, w, self.c).lines[0]
        self.assertEqual((ln.qty, ln.qty_from, ln.unit_price), (4, "履歴", 5000))  # 「1 本あたり」は数量でない
        for w, a_ in (("タイヤ1.0本あたり単価5000円", None), ("タイヤ1本につき5000円", 5000), ("タイヤ1.0本5000円", 5000), ("タイヤ1.0000本5000円", 5000)):
            raw = {"lines": [dict(RAW["lines"][1], quote=w, qty=1, unit_price=None if a_ else 5000, amount=a_, name_append=None)], "unmatched": []}
            ln = finish(raw, w, self.c).lines[0]
            self.assertEqual((ln.qty, ln.unit_price), (4, 5000), w)
        w = "組替4本2000円"
        raw = {"lines": [dict(RAW["lines"][0], quote=w, qty=4, amount=2000, unit_price=None)], "unmatched": []}
        res = finish(raw, w, self.c)
        self.assertEqual((res.lines[0].unit_price, res.lines[0].price_from), (500, "解釈"))
        self.assertIn("Claude の解釈", summary(res)[0])
        w = "組替は4本で2000円とバランスは4本で800円、いやバランスは2本で600円"
        raw = {"lines": [dict(RAW["lines"][0], quote=w, qty=2, amount=600, unit_price=None)], "unmatched": []}
        self.assertEqual(finish(raw, w, self.c).lines, [])
        w = "組替は4本で2000円とバランスは4本で2000円、いやバランスは2本で1000円"
        raw = {"lines": [dict(RAW["lines"][0], quote=w, qty=2, amount=1000, unit_price=None)], "unmatched": []}
        self.assertEqual(finish(raw, w, self.c).lines, [])
        w = "タイヤ-4本交換、バランスも"
        raw = {"lines": [dict(RAW["lines"][2], quote="バランスも", qty=4, amount=None, unit_price=None)], "unmatched": []}
        self.assertEqual(finish(raw, w, self.c).lines, [])
        w = "組替は2本で1000.50円"
        raw = {"lines": [dict(RAW["lines"][0], quote=w, qty=2, amount=50, unit_price=None)], "unmatched": []}
        self.assertEqual(finish(raw, w, self.c).lines, [])

    def test_free_names_only_fixed_forms(self):
        t = [TABLES[0], TABLES[1], TABLES[2],
             TABLES[3] + [{"nm": "山田太郎タイヤ保管", "n": 9, "last_sag": 31, "last_su": 40, "last_tan": 300, "last_skin": 1200, "last_bkin": 0}],
             TABLES[4]]
        self.assertEqual(list(build(t).free), ["廃ﾀｲﾔ･12ｲﾝﾁ"])

    def test_quote_must_be_in_work(self):
        raw = {"lines": [dict(RAW["lines"][0], quote="組替は4本で9999円")], "unmatched": []}
        self.assertEqual(finish(raw, "組替は4本で2000円", self.c).lines, [])

    def test_labor_history_price_is_per_unit(self):
        c = build([[{"code": 278, "n": 5, "n_labor": 5, "n_part": 0, "last_su": 40, "last_tan": 2000, "last_skin": 2000,
                     "last_bkin": 0, "last_sag": 1}], [], [{"code": 278, "nm": "ﾀｲﾔ･組み替え", "kbn1": 1, "uri_tan": 0}], [], []])
        self.assertEqual((c.items[278].last_qty_tenths, c.items[278].last_unit_price), (40, 500))
        c = build([[{"code": 277, "n": 5, "n_labor": 5, "n_part": 0, "last_su": 0, "last_tan": 0, "last_skin": 8800,
                     "last_bkin": 0, "last_sag": 1}], [], [{"code": 277, "nm": "ﾀｲﾔ･履き替え", "kbn1": 1, "uri_tan": 0}], [], []])
        self.assertEqual((c.items[277].last_qty_tenths, c.items[277].last_unit_price), (10, 8800))

    def test_unknown_codes_and_free_names_are_skipped(self):
        raw = {"lines": [dict(RAW["lines"][0], code=123456), dict(RAW["lines"][3], free_name="廃ﾀｲﾔ･99ｲﾝﾁ"),
                         dict(RAW["lines"][1], name_append="x" * 41), dict(RAW["lines"][0], code=True)],
               "unmatched": [{"quote": "洗車", "reason": "目録に無い"}]}
        res = finish(raw, WORK, self.c)
        self.assertEqual(res.lines, [])
        self.assertEqual(len(res.skipped), 5)

    def test_spoken_numbers(self):
        self.assertEqual(spoken_numbers("４本で２，０００円 1.5L"), {Decimal(4), Decimal(2000), Decimal("1.5")})


class AskTest(unittest.TestCase):
    def test_request_shape_and_parse(self):
        class Fake:
            def __init__(self):
                self.kw = None
                self.messages = self

            def create(self, **kw):
                self.kw = kw

                class B:
                    type = "text"
                    text = __import__("json").dumps(RAW)

                class R:
                    stop_reason = "end_turn"
                    content = [B()]
                return R()

        f = Fake()
        out = ask_claude(WORK, build(TABLES), client=f)
        self.assertEqual(out, RAW)
        self.assertEqual(f.kw["model"], "claude-opus-5-5")
        self.assertEqual(f.kw["output_config"]["format"]["schema"], SCHEMA)
        self.assertEqual(f.kw["messages"], [{"role": "user", "content": f"作業の文:\n{WORK}"}])


if __name__ == "__main__":
    unittest.main()
