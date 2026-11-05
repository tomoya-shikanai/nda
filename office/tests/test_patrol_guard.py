"""巡回の守りの試験。Windows に依存しない。
実行（office フォルダで）: python -m unittest discover -s tests
"""

import unittest

from patrol.guard import Budget, dialog_choice, menu_allowed, norm


class DialogTest(unittest.TestCase):
    def test_いいえを選ぶ(self):
        self.assertEqual(dialog_choice(["はい(Y)", "いいえ(N)"]), "いいえ(N)")

    def test_キャンセルより_いいえを先に選ぶ(self):
        self.assertEqual(dialog_choice(["はい(Y)", "キャンセル", "いいえ(&N)"]), "いいえ(&N)")

    def test_はいとOKだけなら押さない(self):
        self.assertIsNone(dialog_choice(["はい(Y)"]))
        self.assertIsNone(dialog_choice(["OK"]))
        self.assertIsNone(dialog_choice([]))

    def test_部分一致では選ばない(self):
        self.assertIsNone(dialog_choice(["いいえで保存"]))
        self.assertIsNone(dialog_choice(["閉じて削除"]))

    def test_全角と空白をそろえる(self):
        self.assertEqual(dialog_choice(["キャンセル "]), "キャンセル ")
        self.assertEqual(norm("いいえ（Ｎ）"), "いいえ")


class MenuTest(unittest.TestCase):
    def test_読むだけの画面を許す(self):
        for n in ["車歴検索", "顧客一覧表示", "部品照会"]:
            with self.subTest(n=n):
                self.assertEqual(menu_allowed(n), "顧客" not in n)

    def test_書く画面は許さない(self):
        for n in ["整備伝票入力", "請求書発行", "見積検索", "一覧印刷", "データ出力", "履歴削除", "検索設定", "月次更新", "終了", "車両検索"]:
            with self.subTest(n=n):
                self.assertFalse(menu_allowed(n))

    def test_許可の語が無ければ許さない(self):
        self.assertFalse(menu_allowed("メンテナンス"))
        self.assertFalse(menu_allowed(""))
        self.assertFalse(menu_allowed("ヘルプ"))

    def test_長すぎる名前は許さない(self):
        self.assertFalse(menu_allowed("検索" * 11))


class BudgetTest(unittest.TestCase):
    def test_人が触ったら止める(self):
        b = Budget(start=0, total_sec=100, last_input=500)
        self.assertIsNone(b.stop_reason(10, 500))
        self.assertIsNotNone(b.stop_reason(10, 501))

    def test_時間切れで止める(self):
        self.assertIsNotNone(Budget(0, 100, 500).stop_reason(100, 500))

    def test_入力を確かめられなければ止める(self):
        self.assertIsNotNone(Budget(0, 100, None).stop_reason(1, None))
        self.assertIsNotNone(Budget(0, 100, 5).stop_reason(1, None))


if __name__ == "__main__":
    unittest.main()
