"""声の手がかりから客と車を引く（box/resolve.py）の試験。DB は偽の答え（JSON）だけを使う。値はすべて架空。"""

import copy
import json
import unittest

from box import resolve
from box.message import Reject, check_request, load_config
from box.resolve import ResolveError, make_hints, rank
from test_box import request


def row(car, kok, no=7319, **over):
    r = {"car_code": car, "car_kokcd": kok, "car_del": 0, "kok_del": 0, "kok_kdel": 0, "car_no": no,
         "car_rikuji": "架空", "car_bango": "500", "car_kana": "さ", "car_syasyu": "ｶｸｳﾊﾞｰ",
         "kok_namek": "ｶｸｳ ﾀﾛｳ", "kok_ryaku": "架空　太郎", "kok_namej1": "架空　太郎", "kok_namej2": None,
         "car_syo_nm1": "架空　太郎", "car_syo_nm2": None, "car_syo_kana": "ｶｸｳ ﾀﾛｳ",
         "car_si_nm1": None, "car_si_nm2": None, "car_si_kana": None}
    r.update(over)
    return r


# 同じ番号の車が 3 台（別の客 2 人、同じ客の 2 台）と、別の番号の車
DB = [
    row(11, 101),
    row(12, 102, kok_namek="ﾀﾞﾐｰ ｶﾞｸｴﾝ", kok_ryaku="ダミー学園", kok_namej1="学校法人　ダミー学園",
        car_syo_nm1="学校法人　ダミー学園", car_syo_kana="ﾀﾞﾐｰ ｶﾞｸｴﾝ", car_syasyu="ﾀﾞﾐｰﾜｺﾞﾝ", car_kana="す"),
    row(13, 101, car_syasyu="ﾓｹｲｶｰ", car_bango="580"),
    row(14, 103, no=1234),
]


def run(rows=DB, **h):
    return rank(copy.deepcopy(rows), make_hints(h.pop("plate", "7319"), **h))


class TestNorm(unittest.TestCase):
    def test_kana_variants(self):
        # 全角・半角カナ、ひらがな、長音、空白（半角・全角）を同じに見る
        same = ["カクウバー", "ｶｸｳﾊﾞｰ", "かくうばー", "カクウバ", "カクウ　バー", "ｶｸｳ ﾊﾞ-", "カクウバ～"]
        self.assertEqual({resolve.norm(s) for s in same}, {"カクウバ"})
        self.assertEqual(resolve.norm("ＡＢＣ１２"), "ABC12")
        self.assertEqual(resolve.norm(None), "")


class TestRank(unittest.TestCase):
    def test_one_decided_by_customer_word(self):
        res = run(customer_words=["だみー"])
        self.assertIsNotNone(res.decided)
        self.assertEqual((res.decided.customer_code, res.decided.car_code), (102, 12))
        self.assertEqual(len(res.candidates), 3)  # 同じ番号の車は、選ぶ画面のためにすべて返す
        self.assertEqual(res.candidates[0], res.decided)
        self.assertEqual(res.summary, "候補 3 件・決まった")

    def test_same_number_same_customer_needs_car_word(self):
        # 客の言葉だけでは同じ客の 2 台を見分けられない → 決めない
        res = run(customer_words=["カクウ　タロウ"])
        self.assertIsNone(res.decided)
        self.assertEqual(sorted(c.car_code for c in res.candidates if c.complete), [11, 13])
        # 車種の言葉を足すと決まる（半角カナ・長音の揺れを越えて）
        res = run(customer_words=["ｶｸｳﾀﾛｳ"], car_words=["もけいかー"])
        self.assertEqual(res.decided.car_code, 13)

    def test_kanji_customer_word(self):
        self.assertEqual(run(customer_words=["ダミー学園"]).decided.car_code, 12)

    def test_plate_parts_filter(self):
        # 分類が食い違う車は候補から外れる。かなはカタカナで言われても合う
        res = run(bango="５８０")
        self.assertEqual([c.car_code for c in res.candidates], [13])
        self.assertIsNone(res.decided)  # 言葉が無ければ決めない（番号の聞き違いに備える）
        res = run(kana="ス", car_words=["ダミーワゴン"])
        self.assertEqual(res.decided.car_code, 12)
        self.assertIn("かなが合う", res.decided.reasons)

    def test_plate_part_missing_in_db_is_kept(self):
        rows = [row(11, 101, car_rikuji=""), row(12, 102, car_rikuji="別地")]
        res = run(rows, rikuji="架空", customer_words=["かくう"])
        self.assertEqual([c.car_code for c in res.candidates], [11])
        self.assertIn("陸運局は DB に無く確かめられない", res.candidates[0].reasons)

    def test_no_match_and_plate_only(self):
        self.assertIsNone(run(customer_words=["ソンザイシナイ"]).decided)
        self.assertEqual(run(plate="9999").candidates, ())
        # 番号だけで 1 台でも、言葉が無ければ決めない
        res = run(plate="1234")
        self.assertEqual(len(res.candidates), 1)
        self.assertIsNone(res.decided)

    def test_deleted_not_listed(self):
        rows = [row(11, 101, car_del=1), row(12, 102, kok_del=1), row(13, 103, kok_kdel=9), row(15, 105)]
        res = run(rows, customer_words=["かくう"])
        self.assertEqual([c.car_code for c in res.candidates], [15])
        self.assertEqual(res.decided.car_code, 15)
        self.assertEqual(run(rows[:3], customer_words=["かくう"]).candidates, ())

    def test_reasons_have_no_values(self):
        res = run(customer_words=["ダミー学園"], car_words=["ダミーワゴン"])
        text = json.dumps([c.reasons for c in res.candidates], ensure_ascii=False) + repr(res)
        for v in ("ダミー", "架空", "7319", "ｶｸｳ"):
            self.assertNotIn(v, text)

    def test_bad_db_answer_stops(self):
        h = make_hints("7319", customer_words=["かくう"])
        for bad in ({"a": 1}, [1], [row(11, 0)], [row(11, 101), row(11, 102)], [row(True, 101)]):
            with self.subTest(bad=bad), self.assertRaises(ResolveError):
                rank(bad, h)
        with self.assertRaises(ResolveError):
            resolve.parse("not json")
        self.assertEqual(resolve.parse(json.dumps(row(11, 101))), [row(11, 101)])  # 1 件だと dict で来る


class TestHints(unittest.TestCase):
    def test_bad_input_stops(self):
        bad = [
            dict(plate_no="0"), dict(plate_no="12345"), dict(plate_no=7319), dict(plate_no="53a5"), dict(plate_no=""),
            dict(plate_no="7319", bango="12ab"), dict(plate_no="7319", kana="さし"), dict(plate_no="7319", kana="a"),
            dict(plate_no="7319", rikuji=""), dict(plate_no="7319", customer_words="かくう"),
            dict(plate_no="7319", customer_words=["ア"]), dict(plate_no="7319", customer_words=["ー　ー"]),
            dict(plate_no="7319", car_words=[1]), dict(plate_no="7319", car_words=["あ" * 31]),
            dict(plate_no="7319", customer_words=["かくう"] * 9),
        ]
        for b in bad:
            with self.subTest(b=b), self.assertRaises(ResolveError):
                make_hints(**b)

    def test_repr_hides_values(self):
        h = make_hints("7319", rikuji="架空", customer_words=["ダミー"])
        self.assertNotIn("7319", repr(h))
        self.assertNotIn("ダミー", repr(h))


CFG = load_config({"allowed_customers": ["102"], "item_codes": {"架空の部品A": 101, "架空の部品B": 2345}})


def vreq(**vehicle):
    msg = request()
    del msg["customer"]
    msg["vehicle"] = vehicle or {"plateNo": "7319", "customerWords": ["ダミー学園"]}
    return msg


class TestMessageVehicle(unittest.TestCase):
    def decide(self, rows=DB):
        return resolve.decider("unused", lambda f, no: copy.deepcopy(rows))

    def test_vehicle_resolved(self):
        job = check_request(vreq(), CFG, self.decide())
        self.assertEqual((job["customer_code"], job["car_code"]), (102, 12))

    def test_vehicle_not_decided(self):
        with self.assertRaises(Reject) as cm:
            check_request(vreq(plateNo="7319", customerWords=["かくう"]), CFG, self.decide())
        self.assertEqual(cm.exception.reason, "customerNotFound")

    def test_vehicle_without_resolver_stops(self):
        with self.assertRaises(Reject) as cm:
            check_request(vreq(), CFG)
        self.assertEqual(cm.exception.reason, "customerNotFound")

    def test_vehicle_resolved_but_not_allowed(self):
        with self.assertRaises(Reject) as cm:
            check_request(vreq(plateNo="7319", carWords=["もけいかー"]), CFG, self.decide())
        self.assertEqual(cm.exception.reason, "customerNotAllowed")

    def test_db_failure_is_reject(self):
        def fail(f, no):
            raise ResolveError("DB を読めない")
        with self.assertRaises(Reject) as cm:
            check_request(vreq(), CFG, resolve.decider("unused", fail))
        self.assertEqual(cm.exception.reason, "other")

    def test_bad_vehicle_shapes(self):
        both = vreq()
        both["customer"] = {"customerNo": "102", "carNo": "12"}
        bad = [both, vreq(plateNo="7319", extra=1), vreq(customerWords=["ダミー"]), vreq(plateNo="0"),
               vreq(plateNo="7319", customerWords=["ア"])]
        called = []
        for m in bad:
            with self.subTest(m=m.get("vehicle")), self.assertRaises(Reject) as cm:
                check_request(m, CFG, lambda h: called.append(h) or (102, 12))
            self.assertEqual(cm.exception.reason, "invalid")
        self.assertEqual(called, [])  # 形が悪ければ DB を引かない

    def test_bad_resolver_answer(self):
        for got in ((102,), ("102", "12"), (0, 12), [102, 12]):
            with self.subTest(got=got), self.assertRaises(Reject):
                check_request(vreq(), CFG, lambda h, g=got: g)

    def test_customer_form_still_works(self):
        msg = request(customer={"customerNo": "102", "carNo": "12"})
        self.assertEqual(check_request(msg, CFG)["car_code"], 12)


if __name__ == "__main__":
    unittest.main()
