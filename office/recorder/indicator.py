"""記録中であることを画面の右下に小さく出す。フォーカスを奪わない小窓にする。"""

from __future__ import annotations

import tkinter as tk
from typing import Callable


class Indicator:
    def __init__(self) -> None:
        self.root = tk.Tk()
        self.root.overrideredirect(True)
        self.root.attributes("-topmost", True)
        self.root.attributes("-alpha", 0.75)
        try:
            self.root.attributes("-toolwindow", True)
            self.root.attributes("-disabled", True)  # クリックとフォーカスを受けない
        except tk.TclError:
            pass
        tk.Label(self.root, text="● 記録中（RacroS）", fg="white", bg="#b03020", font=("Meiryo UI", 9), padx=6, pady=2).pack()
        self.root.update_idletasks()
        w, h = self.root.winfo_width(), self.root.winfo_height()
        sw, sh = self.root.winfo_screenwidth(), self.root.winfo_screenheight()
        self.root.geometry(f"+{sw - w - 12}+{sh - h - 56}")
        self.root.withdraw()
        self.visible = False

    def show(self, on: bool) -> None:
        if on and not self.visible:
            self.root.deiconify()
            self.root.attributes("-topmost", True)
        elif not on and self.visible:
            self.root.withdraw()
        self.visible = on

    def loop(self, tick: Callable[[], None], interval_ms: int) -> None:
        def step() -> None:
            try:
                tick()
            finally:  # tick が例外を出しても次の呼び出しを必ず登録する
                self.root.after(interval_ms, step)

        self.root.after(0, step)
        self.root.mainloop()
