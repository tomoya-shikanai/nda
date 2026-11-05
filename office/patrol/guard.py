"""読むだけの巡回の守り。Windows に依存しない純粋な判定だけを置く（Mac でも試験できる）。

巡回が押してよいのは、次の 2 種類だけ。
1. 確認のダイアログの「いいえ・キャンセル・閉じる」（はい・OK だけのダイアログは押さずに止める）。
2. メニューの項目のうち、名前が読むだけの画面を指すもの（許可の語を含み、禁止の語を含まない）。
窓を閉じるのはボタンでなく WM_CLOSE で行う。キーは送らない。
"""

from __future__ import annotations

import re
import unicodedata

# ダイアログで押してよいボタン。前にあるものほど優先する（いちばん何もしない側）
DIALOG_SAFE = ("いいえ", "キャンセル", "閉じる")

# メニューの項目: 許可の語を 1 つ以上含み、禁止の語を 1 つも含まないものだけを開く
MENU_ALLOW = ("検索", "一覧", "車歴", "照会", "参照", "履歴", "表示")
MENU_DENY = (
    "伝票", "納品", "請求", "見積", "指示", "入力", "登録", "新規", "追加", "修正", "変更", "削除", "更新",
    "保存", "確定", "発行", "印刷", "出力", "書出", "取込", "取り込", "転送", "送信", "受信", "設定", "月次",
    "締", "売上", "入金", "支払", "仕入", "在庫", "棚卸", "顧客", "車両", "バックアップ", "復元", "初期化",
    "終了", "移動", "統合", "一括", "自動", "連携", "メンテ", "管理", "ダウンロード", "アップ", "予約", "作成",
)


def norm(name: str) -> str:
    """ボタン・項目の名前をそろえる: NFKC、アクセラレータ（&、末尾の (Y) など）と空白を除く。"""
    s = unicodedata.normalize("NFKC", name or "")
    s = s.replace("&", "")
    s = re.sub(r"\([A-Za-z0-9]\)\s*$", "", s.strip())
    s = re.sub(r"\s+", "", s)
    return s


def dialog_choice(buttons: list[str] | tuple[str, ...]) -> str | None:
    """押してよいボタンの元の名前を返す。押してよいものが無ければ None（止める）。
    名前がそろえた形でぴったり一致するものだけ。部分一致では選ばない。"""
    named = [(norm(b), b) for b in buttons]
    for want in DIALOG_SAFE:
        for n, orig in named:
            if n == want:
                return orig
    return None


DIALOG_KNOWN = ("はい", "いいえ", "OK", "キャンセル", "閉じる")


def safe_label(name: str) -> str:
    """記録に残してよい名前だけを残す。ダイアログの決まったボタンと、許可か禁止の語を含む短い名前（機能の名前）。
    それ以外（客の名前などが入り得る）は *** にする。"""
    n = norm(name)
    if n in DIALOG_KNOWN:
        return n
    if n and len(n) <= 20 and not re.search(r"\d", n) and any(w in n for w in MENU_ALLOW + MENU_DENY):
        return n
    return "***"


def menu_allowed(name: str) -> bool:
    n = norm(name)
    if not n or len(n) > 20:
        return False
    if any(d in n for d in MENU_DENY):
        return False
    return any(a in n for a in MENU_ALLOW)


class Budget:
    """全体の時間と、人の入力（キーボード・マウス）の検出で止める。
    last_input は GetLastInputInfo の値（ミリ秒の刻み）。巡回はキーもマウスも使わないので、
    始めた後に値が変われば人が触ったとみなす。"""

    def __init__(self, start: float, total_sec: float, last_input: int | None) -> None:
        self.deadline = start + total_sec
        self.baseline = last_input

    def stop_reason(self, now: float, last_input: int | None) -> str | None:
        if now >= self.deadline:
            return "時間切れ"
        if self.baseline is None or last_input is None:
            return "人の入力を確かめられない"
        if last_input != self.baseline:
            return "人がキーボードかマウスを触った"
        return None
