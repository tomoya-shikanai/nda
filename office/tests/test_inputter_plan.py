"""明細から入れる手順を作る（inputter/plan.py）の試験。値段・番号はすべて架空。"""

import copy
import unittest

from inputter import guard
from inputter.plan import COLUMNS_PATH, PlanError, build_plan, expected_lines, load_json

ITEMS = {"items": {"架空の作業A": 101, "架空の作業B": 102, "架空の処分": 0}}
COLUMNS = {
    "confirmed": False,
    "advance_key": "Enter",
    "columns": [
        {"field": "項目CD", "source": "code"},
        {"field": "作業内容", "source": "name"},
        {"field": "作業区分", "source": "none"},
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
                {"field": "明細2.項目CD", **E},
                {"field": "明細2.作業内容", "action": "type", "value": "架空の処分"},
                {"field": "明細2.作業内容", **E},
                {"field": "明細2.作業区分", **E},
                {"field": "明細2.数量", "action": "type", "value": "2"},
                {"field": "明細2.数量", **E},
                {"field": "明細2.単価", "action": "type", "value": "300"},
                {"field": "明細2.単価", **E},
            ],
        )

    def test_free_entry_line_types_name_not_code(self):
        row2 = [s for s in build_plan(JOB, ITEMS, COLUMNS) if s["field"].startswith("明細2.")]
        self.assertFalse([s for s in row2 if s["field"] == "明細2.項目CD" and s["action"] == "type"])
        self.assertIn({"field": "明細2.作業内容", "action": "type", "value": "架空の処分"}, row2)

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
            build_plan(j, {"items": {"架空の印刷代": 0}}, COLUMNS)
        for k, v in (("row_end_keys", ["F8"]), ("advance_key", "Escape")):
            cols = copy.deepcopy(COLUMNS)
            cols[k] = v
            with self.subTest(k=k), self.assertRaises(guard.GuardError):
                build_plan(JOB, ITEMS, cols)

    def test_expected_lines(self):
        self.assertEqual(
            expected_lines(JOB, ITEMS["items"]),
            [
                {"code": 101, "name": "架空の作業A", "qty": 4, "unit_price": 1000},
                {"code": 0, "name": "架空の処分", "qty": 2, "unit_price": 300},
            ],
        )

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
            expected_lines(_job(qty=1.25), ITEMS["items"])

    def test_tenths_still_ok(self):
        self.assertIn({"field": "明細1.数量", "action": "type", "value": "0.1"}, build_plan(_job(qty=0.1), ITEMS, COLUMNS))
