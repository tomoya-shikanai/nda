"""保存の後の読み返しの照合（inputter/readback.py）の試験。値はすべて架空。"""

import unittest

from inputter.readback import compare

EXPECTED = [
    {"code": 101, "name": "架空の作業A", "qty": 4, "unit_price": 1000},
    {"code": 0, "name": "架空の処分", "qty": 1.5, "unit_price": 300},
]
DB = [
    {"code": 101, "name": "架空の作業A", "qty": 40, "unit_price": 1000},
    {"code": 0, "name": "架空の処分  ", "qty": 15, "unit_price": 300},
]


def _db(i, **kw):
    rows = [dict(r) for r in DB]
    rows[i].update(kw)
    return rows


class ReadbackTest(unittest.TestCase):
    def test_match_with_x10_qty(self):
        self.assertEqual(compare(EXPECTED, DB), [])

    def test_qty_not_x10_is_mismatch(self):
        self.assertEqual(compare(EXPECTED, _db(0, qty=4)), [{"row": 1, "field": "qty", "expected": 4, "actual": 0.4}])

    def test_qty_mismatch(self):
        self.assertEqual(compare(EXPECTED, _db(1, qty=20)), [{"row": 2, "field": "qty", "expected": 1.5, "actual": 2.0}])

    def test_price_mismatch(self):
        self.assertEqual(
            compare(EXPECTED, _db(0, unit_price=10000)),
            [{"row": 1, "field": "unit_price", "expected": 1000, "actual": 10000}],
        )

    def test_code_mismatch(self):
        self.assertEqual(compare(EXPECTED, _db(0, code=102)), [{"row": 1, "field": "code", "expected": 101, "actual": 102}])

    def test_name_mismatch(self):
        self.assertEqual(
            compare(EXPECTED, _db(1, name="架空の処分料")),
            [{"row": 2, "field": "name", "expected": "架空の処分", "actual": "架空の処分料"}],
        )

    def test_missing_values_are_mismatches(self):
        self.assertEqual(len(compare(EXPECTED, _db(0, qty=None, unit_price=None))), 2)

    def test_row_count_mismatch(self):
        self.assertEqual(compare(EXPECTED, DB[:1]), [{"row": None, "field": "行の数", "expected": 2, "actual": 1}])
        self.assertEqual(compare(EXPECTED, DB + [DB[0]])[0]["field"], "行の数")


if __name__ == "__main__":
    unittest.main()


class ReadbackStrictTest(unittest.TestCase):
    """Codex の指摘: 丸めや空白の除き方で、違いを一致にしない。"""

    def test_quarter_qty_is_not_equal_to_rounded_db(self):
        r = compare([{"code": 101, "name": "A", "qty": 1.25, "unit_price": 1}], [{"code": 101, "name": "A", "qty": 12, "unit_price": 1}])
        self.assertEqual([m["field"] for m in r], ["qty"])

    def test_leading_space_tab_newline_are_differences(self):
        for name in ("\tA\n", " A", "A\n"):
            r = compare([{"code": 101, "name": "A", "qty": 1, "unit_price": 1}], [{"code": 101, "name": name, "qty": 10, "unit_price": 1}])
            self.assertEqual([m["field"] for m in r], ["name"], name)

    def test_trailing_padding_is_ignored(self):
        for name in ("A  ", "A　"):
            self.assertEqual(compare([{"code": 101, "name": "A", "qty": 1, "unit_price": 1}], [{"code": 101, "name": name, "qty": 10, "unit_price": 1}]), [])
