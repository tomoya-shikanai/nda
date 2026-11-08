"""明細から入れる手順を作る（inputter/plan.py）の試験。値段・番号はすべて架空。"""

import copy
import unittest

from inputter import guard
from inputter.plan import COLUMNS_PATH, PlanError, build_plan, expected_lines, load_json

ITEMS = {"items": {"架空の作業A": 101, "架空の作業B": 102, "架空の処分": 0}, "free_work_kind": {"架空の処分": 31}}
COLUMNS = {
    "confirmed": False,
    "advance_key": "Enter",
    "columns": [
        {"field": "項目CD", "source": "code"},
        {"field": "作業内容", "source": "name"},
        {"field": "作業区分", "source": "work_kind"},
        {"field": "数量", "source": "qty"},
        {"field": "単価", "source": "unit_price"},
    ],
    "row_end_keys": [],
}
JOB = {
    "job_id": "test-job-1",
    "customer_code": 9001,
    "car_code": 9002,
    "lines": [
        {"item": "架空の作業A", "qty": 4, "unit": "本", "unitPrice": 1000},
        {"item": "架空の処分", "qty": 2, "unit": None, "unitPrice": 300},
    ],
}
E = {"action": "key", "value": "Enter"}


def _job(**line0):
    j = copy.deepcopy(JOB)
    j["lines"][0].update(line0)
    return j


class BuildPlanTest(unittest.TestCase):
    def test_happy_path(self):
        self.assertEqual(
            build_plan(JOB, ITEMS, COLUMNS),
            [
                {"field": "明細1.項目CD", "action": "type", "value": "101"},
                {"field": "明細1.項目CD", **E},
                {"field": "明細1.作業内容", **E},  # マスタの品目は名前を打たない
                {"field": "明細1.作業区分", **E},
                {"field": "明細1.数量", "action": "type", "value": "4"},  # DB の 10 倍でなく画面の数
                {"field": "明細1.数量", **E},
                {"field": "明細1.単価", "action": "type", "value": "1000"},
                {"field": "明細1.単価", **E},
                {"field": "明細2.項目CD", "action": "type", "value": "0"},  # 自由入力の行も 0 を打つ
                {"field": "明細2.項目CD", **E},
                {"field": "明細2.作業内容", "action": "type", "value": "架空の処分"},
                {"field": "明細2.作業内容", **E},
                {"field": "明細2.作業区分", "action": "type", "value": "31"},  # free_work_kind から
                {"field": "明細2.作業区分", **E},
                {"field": "明細2.数量", "action": "type", "value": "2"},
                {"field": "明細2.数量", **E},
                {"field": "明細2.単価", "action": "type", "value": "300"},
                {"field": "明細2.単価", **E},
            ],
        )

    def test_free_entry_needs_work_kind(self):
        with self.assertRaisesRegex(PlanError, "free_work_kind"):
            build_plan(JOB, {"items": ITEMS["items"]}, COLUMNS)
        for bad in (0, -1, 1000, True, "31"):
            with self.subTest(bad=bad), self.assertRaises(PlanError):
                build_plan(JOB, {"items": ITEMS["items"], "free_work_kind": {"架空の処分": bad}}, COLUMNS)
        cols = copy.deepcopy(COLUMNS)
        cols["columns"][2]["source"] = "none"
        with self.assertRaisesRegex(PlanError, "work_kind"):
            build_plan(JOB, ITEMS, cols)

    def test_name_append_on_master_line(self):
        steps = build_plan(_job(name_append="･架空 W1 145/80R12"), ITEMS, COLUMNS)
        self.assertIn({"field": "明細1.作業内容", "action": "append", "value": "･架空 W1 145/80R12"}, steps)
        self.assertNotIn({"field": "明細1.作業区分", "action": "type", "value": "31"}, steps)
        guard.check_plan(steps)

    def test_bad_name_append_refused(self):
        for bad in ("", " 前に空白", "後ろに空白 ", "改\n行","x" * 41, 5):
            with self.subTest(bad=bad), self.assertRaises(PlanError):
                build_plan(_job(name_append=bad), ITEMS, COLUMNS)
        j = copy.deepcopy(JOB)
        j["lines"][1]["name_append"] = "･足す"
        with self.assertRaisesRegex(PlanError, "自由入力"):
            build_plan(j, ITEMS, COLUMNS)
        with self.assertRaises(guard.GuardError):
            build_plan(_job(name_append="･(括弧)"), ITEMS, COLUMNS)  # 特別なキーとして読まれる文字

    def test_row_end_keys(self):
        cols = copy.deepcopy(COLUMNS)
        cols["row_end_keys"] = ["Down"]
        steps = build_plan(JOB, ITEMS, cols)
        self.assertEqual(steps[-1], {"field": "明細2.行の終わり", "action": "key", "value": "Down"})

    def test_decimal_qty(self):
        self.assertIn({"field": "明細1.数量", "action": "type", "value": "1.5"}, build_plan(_job(qty=1.5), ITEMS, COLUMNS))
        with self.assertRaises(PlanError):
            build_plan(_job(qty=1.25), ITEMS, COLUMNS)

    def test_null_qty_or_price_fails(self):
        for k in ("qty", "unitPrice"):
            with self.subTest(k=k), self.assertRaisesRegex(PlanError, "null"):
                build_plan(_job(**{k: None}), ITEMS, COLUMNS)
        j = copy.deepcopy(JOB)
        del j["lines"][1]["qty"]
        with self.assertRaisesRegex(PlanError, "null"):
            build_plan(j, ITEMS, COLUMNS)

    def test_bad_numbers_fail(self):
        for line in ({"qty": 0}, {"qty": -1}, {"qty": True}, {"unitPrice": 10.5}, {"unitPrice": -1}, {"qty": "4"}):
            with self.subTest(line=line), self.assertRaises(PlanError):
                build_plan(_job(**line), ITEMS, COLUMNS)

    def test_unknown_item_fails(self):
        with self.assertRaisesRegex(PlanError, "品目の表に無い"):
            build_plan(_job(item="表に無い作業"), ITEMS, COLUMNS)

    def test_bad_job_header_fails(self):
        for k, v in (("job_id", ""), ("customer_code", None), ("car_code", "9002"), ("lines", [])):
            j = copy.deepcopy(JOB)
            j[k] = v
            with self.subTest(k=k), self.assertRaises(PlanError):
                build_plan(j, ITEMS, COLUMNS)

    def test_columns_missing_qty_fails(self):
        cols = copy.deepcopy(COLUMNS)
        cols["columns"] = [c for c in cols["columns"] if c["source"] != "qty"]
        with self.assertRaisesRegex(PlanError, "qty"):
            build_plan(JOB, ITEMS, cols)

    def test_bad_item_code_fails(self):
        for code in ("101", -1, True):
            with self.subTest(code=code), self.assertRaises(PlanError):
                build_plan(JOB, {"items": {"架空の作業A": code, "架空の処分": 0}}, COLUMNS)

    def test_guard_runs_inside_build_plan(self):
        # 品目の名前に禁止の語があれば、手順を作った後の許可リストで止まる
        j = _job(item="架空の印刷代")
        j["lines"] = j["lines"][:1]
        with self.assertRaises(guard.GuardError):
            build_plan(j, {"items": {"架空の印刷代": 0}, "free_work_kind": {"架空の印刷代": 1}}, COLUMNS)
        for k, v in (("row_end_keys", ["F8"]), ("advance_key", "Escape")):
            cols = copy.deepcopy(COLUMNS)
            cols[k] = v
            with self.subTest(k=k), self.assertRaises(guard.GuardError):
                build_plan(JOB, ITEMS, cols)

    def test_expected_lines(self):
        self.assertEqual(
            expected_lines(JOB, ITEMS["items"], ITEMS["free_work_kind"]),
            [
                {"code": 101, "name": "架空の作業A", "qty": 4, "unit_price": 1000, "amount": 4000,
                 "name_append": None, "work_kind": None},
                {"code": 0, "name": "架空の処分", "qty": 2, "unit_price": 300, "amount": 600,
                 "name_append": None, "work_kind": 31},
            ],
        )

    def test_labor_line_types_amount_into_gijutsuryo(self):
        cols = copy.deepcopy(COLUMNS)
        cols["labor_codes"] = [101]
        cols["labor_columns"] = [
            {"field": "項目CD", "source": "code"},
            {"field": "作業内容", "source": "name"},
            {"field": "点数", "source": "none"},
            {"field": "技術料", "source": "amount"},
        ]
        row1 = [s for s in build_plan(JOB, ITEMS, cols) if s["field"].startswith("明細1.")]
        self.assertEqual(row1, [
            {"field": "明細1.項目CD", "action": "type", "value": "101"},
            {"field": "明細1.項目CD", **E},
            {"field": "明細1.作業内容", **E},
            {"field": "明細1.点数", **E},
            {"field": "明細1.技術料", "action": "type", "value": "4000"},  # 4 本 × 1000 円
            {"field": "明細1.技術料", **E},
        ])
        # 2 行目（作業でない項目CD）は部品の行の欄のまま
        self.assertIn({"field": "明細2.単価", "action": "type", "value": "300"}, build_plan(JOB, ITEMS, cols))
        # 金額が 1 円単位にならない作業の行は手順を作らない
        with self.assertRaisesRegex(PlanError, "1 円単位"):
            build_plan(_job(qty=1.5, unitPrice=101), ITEMS, cols)
        # 部品の行は数量と単価を別々に打つので、1 円単位にならなくても手順を作る（Codex の指摘）
        self.assertIn({"field": "明細1.単価", "action": "type", "value": "101"}, build_plan(_job(qty=1.5, unitPrice=101), ITEMS, COLUMNS))

    def test_bad_labor_columns_fail(self):
        base = copy.deepcopy(COLUMNS)
        base["labor_codes"] = [101]
        base["labor_columns"] = [{"field": "項目CD", "source": "code"}, {"field": "作業内容", "source": "name"},
                                 {"field": "技術料", "source": "amount"}]
        bad = []
        c = copy.deepcopy(base); c["labor_columns"].append({"field": "数量", "source": "qty"}); bad.append(c)
        c = copy.deepcopy(base); c["labor_columns"] = c["labor_columns"][:2]; bad.append(c)
        c = copy.deepcopy(base); del c["labor_columns"]; bad.append(c)
        c = copy.deepcopy(base); c["labor_codes"] = [101, 101]; bad.append(c)
        c = copy.deepcopy(base); c["labor_codes"] = ["101"]; bad.append(c)
        c = copy.deepcopy(base); c["columns"].append({"field": "技術料", "source": "amount"}); bad.append(c)
        for i, cols in enumerate(bad):
            with self.subTest(i=i), self.assertRaises(PlanError):
                build_plan(JOB, ITEMS, cols)

    def test_shipped_config_and_example_items(self):
        self.assertIs(load_json(COLUMNS_PATH)["confirmed"], False)  # 画面で確かめるまで未確認のまま
        items = load_json(COLUMNS_PATH.with_name("items.example.json"))
        j = {
            "job_id": "t",
            "customer_code": 1,
            "car_code": 1,
            "lines": [
                {"item": "タイヤ・ゴムバルブ（TR413）", "qty": 4, "unit": "個", "unitPrice": 1},
                {"item": "廃タイヤ", "qty": 4, "unit": "本", "unitPrice": 1},
            ],
        }
        steps = build_plan(j, items)
        self.assertIn({"field": "明細1.項目CD", "action": "type", "value": "296"}, steps)
        self.assertIn({"field": "明細2.作業内容", "action": "type", "value": "廃タイヤ"}, steps)
        self.assertIn({"field": "明細2.作業区分", "action": "type", "value": "31"}, steps)


if __name__ == "__main__":
    unittest.main()


class QtyPrecisionTest(unittest.TestCase):
    """Codex の指摘: 浮動小数の丸めで、承認した数と違う数を打たない。"""

    def test_tiny_qty_is_rejected_not_zero(self):
        with self.assertRaises(PlanError):
            build_plan(_job(qty=1e-12), ITEMS, COLUMNS)

    def test_almost_integer_is_rejected(self):
        with self.assertRaises(PlanError):
            build_plan(_job(qty=1.00000000001), ITEMS, COLUMNS)

    def test_huge_qty_is_rejected(self):
        with self.assertRaises(PlanError):
            build_plan(_job(qty=1000000000000000.1), ITEMS, COLUMNS)

    def test_nan_and_inf_are_rejected(self):
        for q in (float("nan"), float("inf")):
            with self.assertRaises(PlanError):
                build_plan(_job(qty=q), ITEMS, COLUMNS)

    def test_expected_lines_rejects_quarter(self):
        with self.assertRaises(PlanError):
            expected_lines(_job(qty=1.25), ITEMS["items"], ITEMS["free_work_kind"])

    def test_tenths_still_ok(self):
        self.assertIn({"field": "明細1.数量", "action": "type", "value": "0.1"}, build_plan(_job(qty=0.1), ITEMS, COLUMNS))


class JsonDecimalTest(unittest.TestCase):
    """Codex の指摘: JSON を float で読むと、0.1 刻みでない数が丸められて通る。"""

    def test_long_decimal_in_json_is_rejected(self):
        import json as _json
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "job.json"
            text = _json.dumps(_job(qty=4)).replace('"qty": 4', '"qty": 1.00000000000000001')
            self.assertIn("1.00000000000000001", text)
            p.write_text(text, encoding="utf-8")
            with self.assertRaises(PlanError):
                build_plan(load_json(p), ITEMS, COLUMNS)

    def test_decimal_tenths_from_json_ok(self):
        import tempfile
        from pathlib import Path
        import json as _json

        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "job.json"
            p.write_text(_json.dumps(_job(qty=1.5)), encoding="utf-8")
            self.assertIn({"field": "明細1.数量", "action": "type", "value": "1.5"}, build_plan(load_json(p), ITEMS, COLUMNS))


class QtyExactRound3Test(unittest.TestCase):
    """Codex の 3 回目の指摘: Decimal の掛け算の丸めと、JSON の同じ項目の 2 回目。"""

    def test_thirty_digit_qty_is_rejected(self):
        from decimal import Decimal
        with self.assertRaises(PlanError):
            build_plan(_job(qty=Decimal("1.00000000000000000000000000001")), ITEMS, COLUMNS)

    def test_tenths_values(self):
        from decimal import Decimal
        from inputter.plan import qty_tenths
        for q, t in ((4, 40), (Decimal("1.5"), 15), (Decimal("1.50"), 15), (Decimal("4.0"), 40), (0.1, 1), (9999, 99990), (Decimal("1E+1"), 100)):
            self.assertEqual(qty_tenths(q), t, q)
        for q in (Decimal("1.25"), Decimal("0.05"), 10000, Decimal("-1"), 0):
            with self.assertRaises(PlanError):
                qty_tenths(q)

    def test_duplicate_key_json_is_rejected(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "job.json"
            p.write_text('{"job_id":"t","customer_code":1,"car_code":1,"lines":[{"item":"架空の作業A","qty":null,"qty":1,"unitPrice":1}]}', encoding="utf-8")
            with self.assertRaises(PlanError):
                load_json(p)
