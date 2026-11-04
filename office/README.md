# 事務所の記録（RacroS III の操作）

事務所の Windows PC で、整備ソフト RacroS III をどう操作したかを記録するプログラムです。

## 何をするか

- RacroS III が起動している間だけ記録します。起動していないときは何も残しません。
- 他のアプリ（ブラウザ・メールなど）の操作は記録しません。前面の窓・クリックした部品が RacroS III のものかを毎回確かめ、違えば捨てます。
- 読むだけです。RacroS III に入力したり、クリックしたりはしません。
- キー入力そのものは残しません。欄から離れたときに「欄の値がどう変わったか」（前の値 → 後の値）として残します。
- パスワード欄の値は `***` に伏せます。
- 記録を始めるとき（`session_start`）に、対象にしたプロセスの名前・pid・実行ファイルのパスを残します。違うソフトを記録していないかを後で確かめられます。
- 残すのは、窓の切り替わり（題名）、クリックした部品の名前、欄の値の変化、スクリーンショット（窓が変わったとき・ボタンなどを押したとき。2 秒に 1 枚まで、RacroS III の窓の範囲だけ）です。

## 入れ方（最初の 1 回）

1. python.org から Python 3.12 の Windows 版（64bit、「Windows installer (64-bit)」）を入れます。最初の画面で「Add python.exe to PATH」に必ずチェックを入れます。
2. このリポジトリの `office` フォルダをコマンドプロンプトで開き、次を実行します。

   ```
   pip install -r requirements.txt
   ```

## 使い方（office フォルダで）

### 1. 対象の実行ファイル名を確かめる

RacroS III を起動しておいて、次を実行します。

```
python -m recorder list
```

窓を持つプロセスの一覧が出ます。RacroS III の行の、左端の実行ファイル名を確かめます。

対象にするのは、実行ファイル名が `target_exe` のどれかと**完全に一致する**プロセスだけです（大文字小文字は区別しません）。窓の題名や名前の一部では選びません。題名で選ぶと、「RacroS」を題名に含むブラウザのタブやフォルダの窓まで記録してしまうためです。

既定の `RacroS.exe` は**仮の値**です。必ず `python -m recorder list` で確かめて、`recorder\config.json` を作って直します（このファイルは PC ごとの設定なので Git には入りません）。

```json
{
  "target_exe": ["RacroS3.exe"]
}
```

- `target_exe`: 実行ファイル名（`list` の左端に出た名前を `.exe` まで含めてそのまま書く。完全一致）。
- そのほかに書けるもの: `keep_days`（残す日数、既定 7）、`poll_sec`（画面を見る間隔の秒、既定 0.3）、`min_shot_interval`（スクリーンショットの最短の間隔の秒、既定 2）、`jpeg_quality`（既定 70）、`show_indicator`（右下の表示、既定 true）、`root`（記録の置き場）。

### 2. 画面の部品を書き出す

RacroS III で記録したい画面（例: 請求書の入力）を前に出して、次を実行します。

```
python -m recorder dump
```

部品ツリー（`dump-日時.txt`）と窓のスクリーンショット（`dump-日時-番号.jpg`）が `%LOCALAPPDATA%\nda-recorder\dumps` に出ます。読むだけで、RacroS III は操作しません。部品に名前・値（`value=`）が出ているかを見ます。

### 3. 常駐させる

```
python -m recorder run
```

止めるときはコマンドプロンプトで Ctrl+C を押します。窓を出さずに動かすときは `start-recorder.bat` をダブルクリックします（止めるときはタスクマネージャーで `pythonw.exe` を終了します）。

## 記録の置き場

- `%LOCALAPPDATA%\nda-recorder\<日付>\session-<時刻>\` に、RacroS III を起動するたびにフォルダを分けて書きます。
  - `events.jsonl` … 1 行 1 件の記録（窓・クリック・欄の値の変化など）。
  - `screenshots\` … スクリーンショット（JPEG）。
- 7 日より古い日付のフォルダは自動で消えます（起動時と、動いている間 1 時間ごと）。
- 記録中（RacroS III が起動している間）は、画面の右下に赤い「● 記録中（RacroS）」が出ます。RacroS III を閉じると消えます。

## ログオン時に自動で起動する

タスクスケジューラに登録します。コマンドプロンプトを「管理者として実行」で開き、次を実行します（`C:\nda\office` は実際の office フォルダの場所に置き換えます）。

```
schtasks /Create /TN "nda-recorder" /SC ONLOGON /TR "\"C:\nda\office\start-recorder.bat\""
```

`start-recorder.bat` は office フォルダに移ってから `pythonw -m recorder run` を起動します。

- RacroS III を管理者として動かしている場合は、末尾に `/RL HIGHEST` を足します（次の節）。
- ノート PC の場合は、タスクスケジューラの画面でこのタスクを開き、「条件」の「コンピューターを AC 電源で使用している場合のみタスクを開始する」と、「設定」の「タスクを停止するまでの時間」のチェックを外します。
- 消すとき: `schtasks /Delete /TN "nda-recorder" /F`

## RacroS III が管理者権限で動いている場合

Windows には、普通の権限のプログラムが管理者権限のプログラムの画面を読めないようにする仕組み（UIPI）があります。RacroS III が管理者権限で動いていると、普通の権限の記録では窓も部品も読めず、何も残りません。そのときは、記録も管理者権限で動かします。

- 確かめ方: タスクマネージャーの「詳細」で列の見出しを右クリック →「列の選択」→「管理者特権」にチェック。RacroS III の行が「はい」なら管理者権限です。
- 手で動かすとき: コマンドプロンプトを「管理者として実行」で開いてから `python -m recorder run`。
- 自動起動: 上の `schtasks` に `/RL HIGHEST` を足して登録します。

## 明日の最初の確認手順

1. RacroS III を起動し、`python -m recorder list` で RacroS III の行を探します。
2. 実行ファイル名が仮の値の `RacroS.exe` と違えば、`recorder\config.json` の `target_exe` をその名前に直し、`python -m recorder dump` で対象が見つかるかを確かめます。
3. RacroS III で請求書の入力などの画面を出し、`python -m recorder dump`。`dumps` のテキストに部品の名前・値が出ているか、JPEG が RacroS III の窓になっているかを見ます。何も出ないときは、RacroS III が管理者権限で動いていないかを確かめます。
4. `python -m recorder run` を動かし、右下に赤い表示が出るのを確かめます。RacroS III で 1 件だけ操作します（画面を開く・欄に入れる・ボタンを押す）。終わったら Ctrl+C で止めます。
5. `%LOCALAPPDATA%\nda-recorder\<今日の日付>\session-…\events.jsonl` をメモ帳で開き、1 行目の `session_start` の `exe`・`path` が RacroS III のものかを見ます。続いて、操作した順に `window`・`click`・`focus`・`value_changed` が並んでいるかを見ます。`error` の行があれば、その中身を控えます。`screenshots` の JPEG が RacroS III の窓だけを写しているか（他のアプリが写り込んでいないか）を見ます。
6. 記録を動かしたまま普段どおり数分操作し、PC が重くならないか、RacroS III の動きが遅くならないかを見ます。タスクマネージャーで `python.exe` の CPU とメモリも見ます。
7. RacroS III は VB6 で作られている可能性が高いです。dump でウィンドウのクラス名（`ThunderRT6…` なら VB6）と、明細の表の中身が読めるかを見ます。値が `(legacy)` と付いて出ていれば、LegacyIAccessiblePattern（MSAA）から読めています。記録では `value_source: "legacy"` になります。
8. 同じ伝票を重ねて開くと排他警告（8001）が出るので、記録中も重ねて開かないでください。

`start-recorder.bat`（`pythonw`）で動かすと、うまく動かないときにエラーが画面に出ません。その場合はコマンドプロンプトで `python -m recorder run` を動かすと、エラーが表示されます。

## 試験（Mac でも回せる）

```
python3 -m unittest discover -s tests
```

`pnpm check` でも一緒に回ります。
