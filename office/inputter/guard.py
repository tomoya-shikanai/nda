"""送る前の許可リスト。手順は 1 つでもここを通らなければ、何も送らない。

許すのは次の 2 つだけ:
- action "type": 印字できる文字だけの文字列（制御文字・改行・タブは不可）
- action "key": Enter・Tab・Down・Up・Left・Right のどれか

それ以外（F1〜F12、Alt・Ctrl・Win との組み合わせ、Esc、Delete、クリック、ツールバーのボタン）は
すべて断る。F8 は伝票の画面で使われていたが役目が分からないので断る。
欄の名前か値に 保存・印保存・確定・発行・印刷・削除 を含むものも断る。
"""

from __future__ import annotations

ALLOWED_KEYS = frozenset({"Enter", "Tab", "Down", "Up", "Left", "Right"})
ALLOWED_ACTIONS = frozenset({"type", "key"})
STEP_KEYS = frozenset({"field", "action", "value"})
FORBIDDEN_WORDS = ("保存", "印保存", "確定", "発行", "印刷", "削除")
# キーを送る道具（type_keys の類）が修飾キー・特別なキーとして読む文字。
# 打つ文字に混ざると、文字でなく Alt・Ctrl・F キーとして送られる恐れがあるので断る。
SEND_META_CHARS = frozenset("{}^%+~()")


class GuardError(ValueError):
    """許可リストに無い手順があった。violations に 1 件ずつの理由を持つ。"""

    def __init__(self, violations: list[str]):
        self.violations = violations
        super().__init__("許可リストに無い手順があるので、何も送らない:\n" + "\n".join(violations))


def _step_problems(step: object) -> list[str]:
    if not isinstance(step, dict):
        return ["手順が dict でない"]
    problems: list[str] = []
    extra = set(step) - STEP_KEYS
    if extra:
        # 座標（x・y）・ボタン名などの余計な項目は、送る側が読むかもしれないので断る
        problems.append(f"知らない項目がある: {sorted(extra)}")
    field, action, value = step.get("field"), step.get("action"), step.get("value")
    if not isinstance(field, str) or not field or not field.isprintable():
        problems.append("欄の名前が空か、印字できない文字を含む")
    if not isinstance(value, str):
        problems.append("値が文字列でない")
        value = ""
    for text in (field if isinstance(field, str) else "", value):
        for w in FORBIDDEN_WORDS:
            if w in text:
                problems.append(f"「{w}」を含む")
    if action == "type":
        if not value:
            problems.append("打つ文字が空")
        elif not value.isprintable():
            problems.append("打つ文字に制御文字・改行・印字できない文字がある")
        bad = sorted(set(value) & SEND_META_CHARS)
        if bad:
            problems.append(f"打つ文字に特別なキーとして読まれる文字がある: {''.join(bad)}")
    elif action == "key":
        if value not in ALLOWED_KEYS:
            problems.append(f"許可していないキー: {value!r}")
    else:
        problems.append(f"許可していない動作: {action!r}")
    return problems


def check_plan(steps: object) -> list[dict]:
    """手順の全体を確かめる。1 つでも違反があれば GuardError。通れば手順をそのまま返す。"""
    if not isinstance(steps, list) or not steps:
        raise GuardError(["手順が空か、list でない"])
    violations = []
    for i, step in enumerate(steps):
        for p in _step_problems(step):
            name = step.get("field") if isinstance(step, dict) else None
            violations.append(f"手順 {i + 1}（{name}）: {p}")
    if violations:
        raise GuardError(violations)
    return steps
