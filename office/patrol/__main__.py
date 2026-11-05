"""業務ソフトの画面を読むだけで巡回する（Windows、office フォルダで）。

  python -m patrol            … メニューを起動し、読むだけの画面を開いて部品を書き出し、閉じる

やること:
1. 業務ソフトのメニュー（RS_MENU.exe）がまだ動いていなければ起動する。動いていれば、それには触らずに止める。
2. メニューの窓の部品を書き出す（伏せ方は記録ツールと同じ）。
3. メニューの項目のうち、名前が読むだけの画面を指すもの（guard.menu_allowed）だけを Invoke で開く。
   開いた画面（新しく起動したプロセス）の部品を書き出し、WM_CLOSE で閉じる。
4. 確認のダイアログが出たら、いいえ・キャンセル・閉じる だけを押す。無ければ何も押さずに止める。

押さないもの: 座標のクリック、キー、名前の無いボタン、許可の外の名前。
触らないもの: 巡回を始める前から動いていたプロセスの窓（開いている顧客・車両の画面など）。
人がキーボードかマウスを触ったら、全体で 20 分を過ぎたら、止める。メニューは閉じずに残す。
"""

from __future__ import annotations

import ctypes
import json
import subprocess
import sys
import time
from pathlib import Path

from .guard import Budget, dialog_choice, menu_allowed, norm

EXE_DIR = Path(r"C:\RACROS3\EXE")
MENU_EXE = "RS_MENU.exe"
TOTAL_SEC = 20 * 60
OPEN_WAIT_SEC = 20
CLOSE_WAIT_SEC = 10
MAX_SCREENS = 8
WM_CLOSE = 0x0010


class Stop(Exception):
    """巡回を止める（理由つき）。"""


def last_input_tick() -> int | None:
    try:
        class LASTINPUTINFO(ctypes.Structure):
            _fields_ = [("cbSize", ctypes.c_uint), ("dwTime", ctypes.c_uint)]

        li = LASTINPUTINFO()
        li.cbSize = ctypes.sizeof(LASTINPUTINFO)
        if not ctypes.windll.user32.GetLastInputInfo(ctypes.byref(li)):
            return None
        return int(li.dwTime)
    except Exception:
        return None


def racros_pids() -> dict[int, str]:
    import psutil

    out = {}
    for p in psutil.process_iter(["pid", "name", "exe"]):
        try:
            exe = p.info.get("exe") or ""
            if exe and Path(exe).parent.resolve() == EXE_DIR.resolve():
                out[p.info["pid"]] = p.info.get("name") or ""
        except Exception:
            continue
    return out


def top_windows(pid: int):
    import uiautomation as auto

    return [w for w in auto.GetRootControl().GetChildren() if _pid(w) == pid]


def _pid(c) -> int | None:
    try:
        return int(c.ProcessId)
    except Exception:
        return None


class Patrol:
    def __init__(self, out: Path, budget: Budget) -> None:
        from recorder.config import load

        self.cfg = load()
        self.out = out
        self.budget = budget
        self.log: list[dict] = []
        self.before = racros_pids()  # 巡回の前から動いていたプロセス。これには一切触らない
        self.mine: set[int] = set()

    def note(self, kind: str, **kw) -> None:
        self.log.append({"t": time.strftime("%H:%M:%S"), "kind": kind, **kw})

    def check(self) -> None:
        r = self.budget.stop_reason(time.time(), last_input_tick())
        if r:
            raise Stop(r)

    def wait(self, sec: float, cond) -> bool:
        end = time.time() + sec
        while time.time() < end:
            self.check()
            self.handle_dialogs()
            if cond():
                return True
            time.sleep(0.5)
        return False

    def handle_dialogs(self) -> None:
        """自分で起動したプロセスの確認のダイアログ（#32770）だけを扱う。"""
        for pid in list(self.mine):
            for w in top_windows(pid):
                if (w.ClassName or "") != "#32770":
                    continue
                buttons = [(c.Name or "", c) for c in w.GetChildren() if c.ControlTypeName == "ButtonControl" and _pid(c) == pid]
                names = [n for n, _ in buttons]
                choice = dialog_choice(names)
                self.note("dialog", pid=pid, buttons=[n[:20] for n in names], pressed=choice)
                if choice is None:
                    raise Stop("押してよいボタンの無いダイアログが出た")
                for n, c in buttons:
                    if n == choice:
                        c.GetInvokePattern().Invoke()
                        time.sleep(1)
                        break

    def dump(self, pid: int, label: str) -> None:
        """記録ツールの dump を、この pid の実行ファイル名だけを対象にして使う（伏せ方は同じ）。"""
        import psutil
        from recorder import win
        from recorder.config import Config

        name = psutil.Process(pid).name()
        cfg = Config(target_exe=[name], root=self.cfg.root, name_value_classes=self.cfg.name_value_classes)
        path = win.dump_tree(cfg, self.out / "dumps")
        self.note("dump", label=label, exe=name, file=path.name if path else None)

    def run(self) -> None:
        if any(n.lower() == MENU_EXE.lower() for n in self.before.values()):
            raise Stop("メニューがすでに動いている（触らない）")
        self.check()
        proc = subprocess.Popen([str(EXE_DIR / MENU_EXE)], cwd=str(EXE_DIR))
        self.mine.add(proc.pid)
        self.note("launch", exe=MENU_EXE, pid=proc.pid)
        if not self.wait(OPEN_WAIT_SEC, lambda: any((w.ClassName or "") != "#32770" for w in top_windows(proc.pid))):
            raise Stop("メニューの窓が出なかった")
        time.sleep(2)
        self.dump(proc.pid, "menu")

        import uiautomation as auto

        items = []
        for w in top_windows(proc.pid):
            for c, _ in auto.WalkControl(w, includeTop=False, maxDepth=25):
                if _pid(c) != proc.pid or c.ControlTypeName not in ("ButtonControl", "MenuItemControl"):
                    continue
                n = c.Name or ""
                if n:
                    items.append((n, c))
        self.note("menu_items", names=sorted({norm(n) for n, _ in items}), allowed=sorted({norm(n) for n, _ in items if menu_allowed(n)}))

        opened = 0
        seen = set()
        for n, c in items:
            if opened >= MAX_SCREENS:
                break
            key = norm(n)
            if key in seen or not menu_allowed(n):
                continue
            seen.add(key)
            self.check()
            before = set(racros_pids())
            try:
                c.GetInvokePattern().Invoke()
            except Exception as ex:
                self.note("invoke_failed", item=key, error=type(ex).__name__)
                continue
            self.note("invoke", item=key)
            new: list[int] = []

            def appeared() -> bool:
                new[:] = [p for p in racros_pids() if p not in before and p not in self.before]
                return any(top_windows(p) for p in new)

            if not self.wait(OPEN_WAIT_SEC, appeared):
                self.note("no_new_screen", item=key)
                continue
            self.mine.update(new)
            time.sleep(2)
            for p in new:
                self.dump(p, key)
            self.close(new)
            opened += 1

    def close(self, pids: list[int]) -> None:
        """自分で開いたプロセスの窓だけに WM_CLOSE を送る。閉じなければ止める。"""
        import psutil

        for p in pids:
            if p in self.before or p not in self.mine:
                continue
            for w in top_windows(p):
                try:
                    ctypes.windll.user32.PostMessageW(int(w.NativeWindowHandle), WM_CLOSE, 0, 0)
                except Exception:
                    pass
        if not self.wait(CLOSE_WAIT_SEC, lambda: not any(psutil.pid_exists(p) and top_windows(p) for p in pids)):
            raise Stop("開いた画面が閉じなかった（残して止める）")
        self.note("closed", pids=pids)


def main() -> int:
    from recorder import win
    from recorder.config import load

    win.set_dpi_aware()
    out = Path(load().root) / "patrol" / time.strftime("%Y%m%d-%H%M%S")
    out.mkdir(parents=True, exist_ok=True)
    patrol = Patrol(out, Budget(time.time(), TOTAL_SEC, last_input_tick()))
    reason = "最後まで回った"
    try:
        patrol.run()
    except Stop as s:
        reason = str(s)
    except Exception as ex:  # 文面は出さない（部品の名前が入り得る）
        reason = f"失敗: {type(ex).__name__}"
    patrol.note("end", reason=reason)
    (out / "patrol.json").write_text(json.dumps(patrol.log, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{reason} → {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
