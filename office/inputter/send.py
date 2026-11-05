"""手順（plan.py）を、伝票の画面（M_NOU）の明細の欄に 1 歩ずつ送る部分の判定。Windows に依存しない。

窓・部品を読む・キーを送るところは Desktop（winsend.WinDesktop、試験では偽の部品）に任せ、
ここは「送ってよいか」「送った結果が合うか」だけを決める。

- 送る前に、手順の全体を keypath.json と照らす（prepare）。欄の順・キー・打つ文字が 1 つでも外れれば何も送らない。
- 各歩の前に、前面の窓が M_NOU の同じ窓で、フォーカスのある部品のクラス・位置・幅が keypath と合うかを確かめる。
  Enter の回数で欄を数えない。合わなければ何も送らずに止める。
- 打ったら、その欄の Name を読み返し、送った値と合うかを確かめる（数は plan.py と同じ決まりで比べる）。
- 送るキーは 数字・小数点・Enter・Tab・BackSpace と、自由入力の欄の文字だけ（自由入力は今は未確認なので打たない）。
  F キー・Ctrl・Alt・Esc・Delete・クリックは送らない。ツールバー（保存・印保存・印刷・削除・修正）は押さない。
- 人がキーボード・マウスを触った、修飾キーが押されている、ダイアログ（#32770）や止める小窓が出たら、何も押さずに止める。
- 明細を入れ終えたら止まって知らせる。保存は人が押す。
- 送る値・Name・窓の題名（客の名前が入る）は出力に出さない（*** と文字数だけ）。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Callable, Protocol

from .plan import PlanError, qty_tenths

KEYPATH_PATH = Path(__file__).with_name("keypath.json")

# 送ってよいキー（文字のほか）。これ以外の名前は、Windows の部分でも送れない
SEND_KEYS = frozenset({"Enter", "Tab", "BackSpace"})
DIALOG_CLASS = "#32770"
DIGITS = frozenset("0123456789")

FOCUS_TIMEOUT_S = 3.0  # Enter の後、フォーカスが次の欄に来るまで待つ長さ
READBACK_TIMEOUT_S = 2.0
POLL_S = 0.05
SETTLE_S = 0.15  # 送った後、画面が受け取るまで待つ長さ
# Enter の後、次の欄にフォーカスが来てから、この長さ続けて同じ欄にあるのを見てから送る。
# 遅れて出る小窓（部品の選択など）に、確かめた直後の文字や Enter が入るのを減らす（Codex の指摘。0 にはできない）
STABLE_S = 0.5
OWN_INPUT_MARGIN_MS = 100  # 送った自分の入力の時刻として見なす幅（これより後の入力は人の入力）
START_TIMEOUT_S = 60.0
START_QUIET_MS = 2000  # 始める前に、人の入力が無いことを確かめる長さ


class SendError(ValueError):
    """手順か keypath が、送ってよい形でない（何も送っていない）。"""


class Stop(RuntimeError):
    """送っている途中で、確かめが合わなかったので止めた。それ以上は何も送らない。"""


@dataclass(frozen=True)
class WindowInfo:
    hwnd: int
    pid: int
    exe: str
    class_name: str
    title: str
    rect: tuple[int, int, int, int]  # left, top, right, bottom（画面の画素）


@dataclass(frozen=True)
class FocusInfo:
    pid: int
    class_name: str
    rect: tuple[int, int, int, int]
    name: str


@dataclass(frozen=True)
class TopWindow:
    hwnd: int
    class_name: str
    title: str


class Desktop(Protocol):
    """Windows の部分（winsend.WinDesktop）と、試験の偽の部品が同じ形で持つもの。"""

    def foreground(self) -> WindowInfo | None: ...
    def focused(self) -> FocusInfo | None: ...
    def visible_windows(self) -> list[TopWindow]: ...  # どの process のものも含めた、見えている最上位の窓
    def last_input_tick(self) -> int: ...  # GetLastInputInfo（ミリ秒、32 ビットで一周する）
    def tick_now(self) -> int: ...  # GetTickCount
    def cursor_pos(self) -> tuple[int, int]: ...
    def keys_held(self) -> bool: ...  # Shift・Ctrl・Alt・Win・マウスのボタンが押されている、かな固定が入っている
    def human_input_seen(self) -> bool: ...  # 送った自分の入力（injected）でないキー・マウスの入力を、一度でも見た
    def reset_human_input(self) -> None: ...
    def send_key(self, name: str) -> None: ...
    def send_char(self, ch: str) -> None: ...
    def sleep(self, seconds: float) -> None: ...


@dataclass(frozen=True)
class Target:
    """フォーカスがあるべき部品。x・y は窓の左上からの画素。"""

    field: str  # 明細1.項目CD
    class_name: str
    x: int
    y: int
    width: int | None
    source: str | None
    allow_text: bool  # 文字（数字の他）を打ってよい自由入力の欄か
    require_nonempty: bool  # 打たずに進む前に、Name が空でないこと（マスタの名前が入っている）を確かめる

    @property
    def numeric(self) -> bool:
        return self.class_name == "NumEdit"


@dataclass(frozen=True)
class Group:
    """1 つの欄でする手順: 打つ文字（無ければ None）と、次の欄へ進むキー。"""

    target: Target
    text: str | None
    key: str


def mask(text: str | None) -> str:
    return "***(0 文字)" if not text else f"***({len(text)} 文字)"


# ---- keypath の読み取り ----


def _int(v: object, what: str, lo: int = 0, hi: int = 10000) -> int:
    if not isinstance(v, int) or isinstance(v, bool) or not lo <= v <= hi:
        raise SendError(f"keypath の {what} が {lo}〜{hi} の整数でない: {v!r}")
    return v


@dataclass(frozen=True)
class Keypath:
    confirmed: bool
    exe: str
    window_class: str
    title_contains: str
    tolerance: int
    advance_key: str
    first_row_y: int
    row_height: int
    visible_rows: int
    path: tuple[dict, ...]  # 1 行の欄の順（項目CD → … → 単価）
    stop_titles: tuple[str, ...]


def load_keypath(data: object) -> Keypath:
    if not isinstance(data, dict):
        raise SendError("keypath が dict でない")
    try:
        screen, rows = data["screen"], data["rows"]
        path = list(rows["fields"]) + list(rows["branch_after_担当"]["part"]["fields"])
        row_end = rows["row_end"]["steps"]
    except (KeyError, TypeError) as e:
        raise SendError(f"keypath に要る項目が無い: {e}") from None
    for k in ("exe", "window_class", "title_contains"):
        if not isinstance(screen.get(k), str) or not screen[k]:
            raise SendError(f"keypath の screen.{k} が無い")
    advance = data.get("advance_key")
    if advance not in SEND_KEYS:
        raise SendError(f"keypath の advance_key が送ってよいキーでない: {advance!r}")
    if row_end != []:
        # 行の終わりに足すキーは今は無い（単価の Enter で次の行へ移る）。足すなら、ここと試験を直してから
        raise SendError("keypath の rows.row_end.steps が空でない。行の終わりのキーは送らない")
    names = []
    for f in path:
        if not isinstance(f, dict) or not isinstance(f.get("field"), str) or not f["field"]:
            raise SendError(f"keypath の欄に field が無い: {f!r}")
        if f.get("class") not in ("NumEdit", "TextEdit"):
            raise SendError(f"keypath の欄 {f['field']} のクラスが NumEdit・TextEdit でない: {f.get('class')!r}")
        _int(f.get("x"), f"{f['field']}.x")
        if f.get("width") is not None:
            _int(f.get("width"), f"{f['field']}.width", 1)
        names.append(f["field"])
    if len(set(names)) != len(names):
        raise SendError("keypath の 1 行の欄に、同じ名前が 2 回ある")
    stop = data.get("stop_on_windows", [])
    if not isinstance(stop, list) or not all(isinstance(s, str) and s for s in stop):
        raise SendError("keypath の stop_on_windows が文字の list でない")
    return Keypath(
        confirmed=data.get("confirmed") is True,
        exe=screen["exe"],
        window_class=screen["window_class"],
        title_contains=screen["title_contains"],
        tolerance=_int(screen.get("position_tolerance_px"), "screen.position_tolerance_px", 0, 10),
        advance_key=advance,
        first_row_y=_int(rows.get("first_row_y"), "rows.first_row_y"),
        row_height=_int(rows.get("row_height"), "rows.row_height", 1),
        visible_rows=_int(rows.get("visible_rows"), "rows.visible_rows", 1, 100),
        path=tuple(path),
        stop_titles=tuple(stop),
    )


def _target(kp: Keypath, row: int, f: dict) -> Target:
    free = f.get("free_entry")
    # 自由入力の欄で文字を打つのは、keypath で未が解け、allow_text が true のときだけ
    allow_text = (
        f.get("source") == "name"
        and isinstance(free, dict)
        and free.get("unknown") is not True
        and free.get("allow_text") is True
    )
    return Target(
        field=f"明細{row}.{f['field']}",
        class_name=f["class"],
        x=f["x"],
        y=kp.first_row_y + (row - 1) * kp.row_height,
        width=f.get("width"),
        source=f.get("source"),
        allow_text=allow_text,
        require_nonempty=f.get("source") == "name",
    )


def next_row_target(kp: Keypath, rows: int) -> Target | None:
    """入れ終えた後にフォーカスが来るはずの、次の行の最初の欄。見えている行の外なら None。"""
    if rows >= kp.visible_rows:
        return None
    return _target(kp, rows + 1, kp.path[0])


# ---- 手順の照らし合わせ（送る前に全体を） ----

_INT_TEXT = re.compile(r"[0-9]+")
_QTY_TEXT = re.compile(r"[0-9]+(\.[0-9])?")


def _check_text(t: Target, text: str) -> str | None:
    if t.numeric:
        pattern = _QTY_TEXT if t.source == "qty" else _INT_TEXT
        if t.source not in ("code", "qty", "unit_price"):
            return "この欄には打たない（keypath で何も打たずに進む欄）"
        if not pattern.fullmatch(text):
            return "数の欄に、数字（数量は小数点 1 つまで）でない文字を打とうとしている"
        return None
    if not t.allow_text:
        return "自由入力の欄の入れ方が未確認（keypath の free_entry）なので、文字を打たない"
    if not text.isprintable() or any(ord(c) > 0xFFFF for c in text):
        return "打つ文字に、印字できない文字がある"
    return None


def prepare(steps: object, kp: Keypath) -> list[Group]:
    """plan.py の手順を、欄ごとの Group に分け、keypath の順・キー・打てる文字と照らす。1 つでも外れれば SendError。"""
    if not isinstance(steps, list) or not steps:
        raise SendError("手順が空か、list でない")
    groups: list[tuple[str, list[dict]]] = []
    for i, s in enumerate(steps):
        if not isinstance(s, dict) or set(s) != {"field", "action", "value"}:
            raise SendError(f"手順 {i + 1} の形が {{field, action, value}} でない")
        if not all(isinstance(s[k], str) for k in s):
            raise SendError(f"手順 {i + 1} に文字列でない項目がある")
        if groups and groups[-1][0] == s["field"]:
            groups[-1][1].append(s)
        else:
            groups.append((s["field"], [s]))
    n_fields = len(kp.path)
    if len(groups) % n_fields:
        raise SendError(f"手順の欄の数（{len(groups)}）が、1 行の欄の数（{n_fields}）の倍数でない")
    rows = len(groups) // n_fields
    if rows > kp.visible_rows:
        raise SendError(f"明細が {rows} 行ある。{kp.visible_rows} 行を超える明細の位置は未確認なので送らない")
    out: list[Group] = []
    for gi, (field, gsteps) in enumerate(groups):
        t = _target(kp, gi // n_fields + 1, kp.path[gi % n_fields])
        if field != t.field:
            raise SendError(f"手順の欄 {field} が、keypath の順の {t.field} と合わない")
        acts = [s["action"] for s in gsteps]
        if acts not in (["key"], ["type", "key"]):
            raise SendError(f"{field}: 手順が「打つ → キー」か「キー」でない: {acts}")
        key = gsteps[-1]["value"]
        if key != kp.advance_key:
            raise SendError(f"{field}: 進むキーが keypath の {kp.advance_key} でない: {key!r}")
        text = gsteps[0]["value"] if acts[0] == "type" else None
        if text is not None:
            problem = _check_text(t, text)
            if problem:
                raise SendError(f"{field}: {problem}")
        elif t.numeric and t.source in ("code", "qty", "unit_price"):
            # 項目CD が空のまま進む（自由入力の行）・数量や単価を打たずに進むのは、道筋が未確認なので送らない
            raise SendError(f"{field}: keypath では打つ欄なのに、何も打たずに進もうとしている")
        out.append(Group(target=t, text=text, key=key))
    return out


def dry_run_lines(groups: list[Group], kp: Keypath) -> list[str]:
    lines = []
    for g in groups:
        t = g.target
        w = f" 幅 {t.width}" if t.width is not None else ""
        what = f"打つ {mask(g.text)} → {g.key}" if g.text is not None else f"{g.key}"
        if g.text is None and t.require_nonempty:
            what += "（Name が空でないことを確かめてから）"
        lines.append(f"{t.field:<14} {t.class_name} ({t.x}, {t.y}) ±{kp.tolerance}{w}  {what}")
    nxt = next_row_target(kp, len(groups) // len(kp.path))
    if nxt is not None:
        lines.append(f"{'（入れ終えた後）':<14} {nxt.class_name} ({nxt.x}, {nxt.y}) にフォーカスが来るのを確かめて止まる")
    return lines


# ---- 読み返しの照合 ----

_NUM_PLAIN = re.compile(r"[0-9]+(\.[0-9]+)?")
_NUM_COMMA = re.compile(r"[0-9]{1,3}(,[0-9]{3})+(\.[0-9]+)?")


def parse_number(text: str) -> Decimal | None:
    """NumEdit の Name の数。桁区切りのカンマ（3 桁ごと）・小数点を許す。それ以外の形は None。"""
    s = text.strip(" ")
    if _NUM_COMMA.fullmatch(s):
        s = s.replace(",", "")
    elif not _NUM_PLAIN.fullmatch(s):
        return None
    try:
        return Decimal(s)
    except InvalidOperation:
        return None


def readback_matches(t: Target, sent: str, name: str) -> bool:
    if not t.numeric:
        return name == sent
    a, b = parse_number(name), parse_number(sent)
    if a is None or b is None:
        return False
    if t.source == "qty":
        try:
            return qty_tenths(a) == qty_tenths(b)
        except PlanError:
            return False
    return a == b and a == a.to_integral_value()


def prefix_matches(t: Target, prefix: str, name: str) -> bool:
    """打っている途中の Name が、ここまで打った文字と合うか。数の欄は桁区切りのカンマを除いて比べる。"""
    if not t.numeric:
        return name == prefix
    n = name.strip(" ")
    if _NUM_COMMA.fullmatch(n.rstrip(".")):
        n = n.replace(",", "")
    # 小数点を打った直後は、欄が「1.」と出すか「1」と出すか分からないので、どちらも認める
    return n == prefix or (prefix.endswith(".") and n == prefix[:-1])


# ---- 送る ----


def _tick_after(a: int, b: int) -> int:
    """32 ビットで一周するミリ秒の時刻で、a が b より何ミリ秒後か（前なら負）。"""
    d = (a - b) & 0xFFFFFFFF
    return d - 0x100000000 if d >= 0x80000000 else d


class Sender:
    def __init__(self, desk: Desktop, kp: Keypath, groups: list[Group], log: Callable[[str], None]):
        self.desk, self.kp, self.groups, self.log = desk, kp, groups, log
        self.hwnd: int | None = None
        self.pid: int | None = None
        self.tick = 0
        self.cursor = (0, 0)

    # -- 確かめ --

    def _window_ok(self, w: WindowInfo | None) -> str | None:
        if w is None:
            return "前面の窓が読めない"
        if w.class_name == DIALOG_CLASS:
            return "前面にダイアログ（#32770）が出ている"
        if w.exe.lower() != self.kp.exe.lower():
            return f"前面の窓が {self.kp.exe} でない"
        if w.class_name != self.kp.window_class or self.kp.title_contains not in w.title:
            return "前面の窓が伝票の画面でない（クラスか題名が違う）"
        if self.hwnd is not None and (w.hwnd != self.hwnd or w.pid != self.pid):
            return "前面の窓が、始めたときの伝票の画面と違う"
        return None

    def _check_window(self) -> WindowInfo:
        w = self.desk.foreground()
        problem = self._window_ok(w)
        if problem:
            raise Stop(problem)
        # ダイアログは、伝票の画面の process のものに限らず止める（常駐の RS1_DATA などの警告もあり得る。Codex の指摘）
        for top in self.desk.visible_windows():
            if top.class_name == DIALOG_CLASS:
                raise Stop("ダイアログ（#32770）が出ている")
            if top.hwnd != w.hwnd and any(s in top.title for s in self.kp.stop_titles):
                raise Stop("止める小窓（部品の選択・コード表など）が出ている")
        return w

    def _focus_problem(self, w: WindowInfo, f: FocusInfo | None, t: Target) -> str | None:
        if f is None:
            return "フォーカスのある部品が読めない"
        if f.pid != w.pid:
            return "フォーカスのある部品が伝票の画面のものでない"
        if f.class_name != t.class_name:
            return f"フォーカスのある部品のクラスが {t.class_name} でない"
        x, y = f.rect[0] - w.rect[0], f.rect[1] - w.rect[1]
        tol = self.kp.tolerance
        if abs(x - t.x) > tol or abs(y - t.y) > tol:
            return f"フォーカスのある部品の位置 ({x}, {y}) が {t.field} の ({t.x}, {t.y}) と合わない"
        if t.width is not None and abs((f.rect[2] - f.rect[0]) - t.width) > tol:
            return f"フォーカスのある部品の幅が {t.field} の {t.width} と合わない"
        return None

    def _check_input(self) -> None:
        if self.desk.human_input_seen():
            # 低水準のフックで、送った自分の入力でない（injected でない）入力を見た。時刻の差では分けられない分も止める
            raise Stop("人がキーボードかマウスを触った")
        if self.desk.keys_held():
            raise Stop("修飾キー（Shift・Ctrl・Alt・Win）かマウスのボタンが押されているか、かな固定が入っている")
        if self.desk.last_input_tick() != self.tick:
            raise Stop("人がキーボードかマウスを触った")
        if self.desk.cursor_pos() != self.cursor:
            raise Stop("マウスが動いた")

    def _check_all(self, t: Target) -> FocusInfo:
        """人の入力・窓・ダイアログ・フォーカスを今確かめる。1 つでも外れれば Stop。"""
        self._check_input()
        w = self._check_window()
        f = self.desk.focused()
        problem = self._focus_problem(w, f, t)
        if problem:
            raise Stop(problem)
        return f

    def _wait_focus(self, t: Target, timeout: float = FOCUS_TIMEOUT_S) -> FocusInfo:
        """フォーカスが t に来て、STABLE_S の間そこに続けてあるまで待つ。待つ間も人の入力・窓・ダイアログを確かめ続ける。"""
        waited = 0.0
        stable = 0.0
        while True:
            self._check_input()
            w = self._check_window()
            f = self.desk.focused()
            problem = self._focus_problem(w, f, t)
            if problem is None:
                if stable >= STABLE_S:
                    return f
                stable += POLL_S
            else:
                stable = 0.0
            if waited >= timeout:
                raise Stop(f"{t.field} を待ったが来ない: {problem}")
            self.desk.sleep(POLL_S)
            waited += POLL_S

    def _wait_name(self, t: Target, ok: Callable[[str], bool], what: str) -> None:
        waited = 0.0
        while True:
            f = self._check_all(t)
            if ok(f.name):
                return
            if waited >= READBACK_TIMEOUT_S:
                # Name は送った値そのものなので、出力には文字数だけを出す
                raise Stop(f"{t.field}: {what}（読み返し {mask(f.name)}）")
            self.desk.sleep(POLL_S)
            waited += POLL_S

    # -- 送る --

    def _send(self, t: Target, send: Callable[[], None]) -> None:
        """確かめてから 1 つだけ送り、送った自分の入力の分を差し引いて、人の入力の基準を取り直す。"""
        self._check_all(t)
        sent_at = self.desk.tick_now()
        send()
        self.desk.sleep(SETTLE_S)
        last = self.desk.last_input_tick()
        # GetLastInputInfo は自分の入力でも進むので、送った直後の分は差し引く。
        # この幅の中の人の入力は時刻では分けられないので、human_input_seen（injected の印）でも見る
        if _tick_after(last, sent_at) > OWN_INPUT_MARGIN_MS:
            # 送った直後より後に入力があった＝人の入力（待つ間に人が触った）
            raise Stop("送った後に、人がキーボードかマウスを触った")
        self.tick = last
        if self.desk.cursor_pos() != self.cursor:
            raise Stop("マウスが動いた")
        self._check_window()

    def _send_char(self, t: Target, ch: str) -> None:
        if t.numeric:
            allowed = DIGITS | ({"."} if t.source == "qty" else set())
            if ch not in allowed:
                raise Stop(f"{t.field}: 数の欄に送ってよい文字でない")
        elif not t.allow_text or not ch.isprintable() or len(ch) != 1:
            raise Stop(f"{t.field}: 文字を送ってよい欄でない")
        self._send(t, lambda: self.desk.send_char(ch))

    def _send_key(self, t: Target, key: str) -> None:
        if key not in SEND_KEYS:
            raise Stop(f"送ってよいキーでない: {key!r}")
        self._send(t, lambda: self.desk.send_key(key))

    def _wait_start(self) -> None:
        """人が伝票の画面の明細 1 行目の最初の欄にフォーカスを置き、手を離すまで待つ。この間は何も送らない。"""
        first = self.groups[0].target
        waited = 0.0
        while True:
            w = self.desk.foreground()
            ready = False
            if self._window_ok(w) is None:
                f = self.desk.focused()
                idle = _tick_after(self.desk.tick_now(), self.desk.last_input_tick())
                ready = self._focus_problem(w, f, first) is None and idle >= START_QUIET_MS and not self.desk.keys_held()
            if ready:
                self.desk.reset_human_input()  # 人が欄をクリックした分は数えない。ここから後の人の入力で止める
                self.hwnd, self.pid = w.hwnd, w.pid
                self.tick = self.desk.last_input_tick()
                self.cursor = self.desk.cursor_pos()
                return
            if waited >= START_TIMEOUT_S:
                raise Stop(f"{START_TIMEOUT_S:.0f} 秒待ったが、伝票の画面の {first.field} にフォーカスが来ない")
            self.desk.sleep(0.1)
            waited += 0.1

    def run(self) -> None:
        if not self.groups:
            raise Stop("手順が無い")
        self.log(f"伝票の画面で、明細 1 行目の {self.groups[0].target.field.split('.', 1)[1]} の欄をクリックし、手を離してください。")
        self._wait_start()
        self.log("始めます。キーボードとマウスに触ると止まります。")
        for g in self.groups:
            t = g.target
            f = self._wait_focus(t)
            if g.text is not None:
                if f.name != "":
                    raise Stop(f"{t.field}: 打つ前の欄が空でない（読み返し {mask(f.name)}）")
                for i, ch in enumerate(g.text):
                    if i:
                        # 前の文字までが欄に入ったのを確かめてから次の文字を送る（Codex の指摘）
                        prefix = g.text[:i]
                        self._wait_name(t, lambda name: prefix_matches(t, prefix, name), "打っている途中の読み返しが合わない")
                    self._send_char(t, ch)
                self._wait_name(t, lambda name: readback_matches(t, g.text, name), "打った値と読み返しが合わない")
                self.log(f"{t.field}: 打った {mask(g.text)}、読み返し一致")
            elif t.require_nonempty:
                self._wait_name(t, lambda name: name != "", "名前が入っていない（マスタの品目でない）")
            self._send_key(t, g.key)
        rows = len(self.groups) // len(self.kp.path)
        nxt = next_row_target(self.kp, rows)
        if nxt is not None:
            self._wait_focus(nxt)
        else:
            self._check_input()
            self._check_window()
        self.log(f"明細 {rows} 行を入れ終えました。ここで止まります。中身を画面で確かめ、保存は人が押してください。")


def run(desk: Desktop, kp: Keypath, groups: list[Group], log: Callable[[str], None]) -> None:
    Sender(desk, kp, groups, log).run()
