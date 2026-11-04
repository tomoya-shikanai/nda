# RacroS III の履歴から、タイヤの伝票の傾向を集める

事務所の Windows PC で動かす PowerShell（5.1）のスクリプトです。業務ソフト RacroS III の SQL Server を **読むだけ** で、過去のタイヤ交換の伝票から、請求書を作るときに使える傾向（よく使う作業と品番、サイズ、工賃、数量、季節、金額の幅、車種ごとの違い）を集めます。
DB の構造は `docs/racros-schema.md` にあります。

## 守っていること

- **書き換えない**: すべてのクエリは `RacrosDb.psm1` の `Invoke-RacrosSelect` を通します。
  - SELECT か WITH で始まる 1 文だけを通します。文字列・コメント・`[ ]` を取り除いた骨格に、INSERT・UPDATE・DELETE・MERGE・DDL・EXEC・BACKUP・RESTORE・ATTACH・INTO・SET・WAITFOR などの語があれば、送る前に止めます。
  - 接続は READ UNCOMMITTED のトランザクションで読み、最後に必ず ROLLBACK します（RacroS の利用を止めるロックを取らない。万一ガードをすり抜けても確定させない）。
  - 対象は `RS3_` で始まる DB だけです。`C:\RACROS3` 以下のファイルには触れません。
- **客の情報を外に出さない**: 取り出しは許可リスト（`Export-RacrosTireLines.ps1` の `$spec`）の列だけです。
  - 客・車・伝票の番号は `顧客A`・`車両001`・`伝票00001` の仮名にします。対応表は `C:\Users\PRS\nda-private\racros\pseudonyms.csv`（リポジトリの外）です。
  - 品名などの自由記述は、3 人以上の客に共通する文言だけを残し、ほかは `<タイヤ 銘柄 サイズ>`・`<自由記述>`・`<除外>` に置き換えます。
  - 車種・型式は 3 台以上にある値だけを残し、走行距離は 1 万 km の幅に丸めます。
  - 集計では、3 台未満の区分（車種×サイズなど）を出しません。
- **出力はコミットしない**: すべて `data/private/racros/`（.gitignore）に置きます。

## ファイル

| ファイル | 役目 |
|---|---|
| `RacrosDb.psm1` | 読み取り専用の接続（ガード） |
| `RacrosMask.psm1` | マスキングの部品（仮名、自由記述、サイズ・銘柄・季節の読み取り、行の分類） |
| `RacrosTrends.psm1` | 集計の部品（台帳を作る） |
| `Get-RacrosSchema.ps1` | テーブル名・列名・型・件数だけを書き出す |
| `Export-RacrosTireLines.ps1` | タイヤの伝票の明細を取り出し、マスキングして `tire_lines.csv` に書く |
| `Get-RacrosTireTrends.ps1` | `tire_lines.csv` から台帳 `trends/tire-ledger.json` と要約 `trends/summary.md` を作る（DB に触れない） |
| `Invoke-RacrosNightly.ps1` | 毎晩の入口（取り出し → 集計。ログは `logs/`） |
| `tests/*.Tests.ps1` | 架空のデータのテスト（Pester 3.4。Windows に最初から入っている） |

## 使い方

PowerShell で、このフォルダから:

```powershell
# テスト（DB に接続しない）
Invoke-Pester -Script .\tests

# 取り出し（1 分ほど）→ 集計（10 秒ほど）
.\Export-RacrosTireLines.ps1
.\Get-RacrosTireTrends.ps1
```

`.ps1`・`.psm1` は UTF-8（BOM 付き）で保存します。BOM が無いと PowerShell 5.1 が日本語を読み違えます。

## 傾向の台帳（`trends/tire-ledger.json`）

請求書を作るとき、車種とサイズで引いて「よく載る行と、その金額の中央値と幅」を出すための台帳です。

| 項目 | 中身 |
|---|---|
| `invoice_ledger` | 区分ごとの台帳。`level` は `model+size`（車種×サイズ）→ `size`（サイズだけ）→ `all`（全体）。引くときは細かい方から探し、無ければ粗い方へ下がる。`kind` は `swap`（履き替え）／`mount`（組み替え）。`lines` に、作業の分類ごとの「載る割合・代表の品名・数量・1 行の金額・1 本あたり」 |
| `work_prices` | 作業ごとの金額（最近の中央値と幅、年ごとの推移、よく使う品名） |
| `tire_price_by_size`・`tire_price_by_brand` | タイヤ本体の 1 本の値段（サイズ別・銘柄別） |
| `models` | 車種ごとの夏・冬のサイズ（車の台数で数える） |
| `by_year`・`by_month_of_year`・`by_year_month` | 件数（季節の山） |
| `co_items` | タイヤの伝票に一緒に載る、タイヤ以外の行 |

金額は「最近」（既定は直近 3 年）の分から出します。値上げがあるためです（年ごとの推移は `work_prices.*.amount_by_year`）。

使い方の案: 父の声から作った明細の候補に、この台帳の値を **参考の幅** として並べ、幅から外れた金額を確認事項にする。台帳の値で明細を埋めることはしない（「推測で埋めない」）。

## 毎晩の更新

**差分ではなく、毎晩すべてを取り出し直して集計し直します。**

- 伝票は日付の後からも直される（`UPDSTAMP` が変わる）ので、「前回の日付の続き」だけを読むと直しを取りこぼします。
- すべて読み直しても 1 分半ほどで終わり、件数も小さい（伝票は年に数百件ずつ増える程度）。
- 仮名は対応表に残るので、毎晩同じ客・車には同じ仮名が付きます。
- 毎晩の台帳は `trends/history/tire-ledger-<日付>.json` に控えを残すので、傾向の移り変わりは控えどうしを比べて見ます。

件数が大きく増えて時間がかかるようになったら、`SYAJNL_UPDSTAMP`・`TJNL_UPDSTAMP` が前回より新しい伝票だけを読み直す形に変えます（今は不要）。

### タスクスケジューラへの登録（まだ登録していません）

1. 事務所の PC に PRS でログオンします（SQL Server には Windows 認証で入るため、PRS として動かします）。
2. 管理者でない PowerShell で、次を実行します（毎日 2:30。RacroS を使っていない時間）。パスワードを聞かれたら PRS のパスワードを入れます（画面に出ません）。

   ```powershell
   $script = 'C:\Users\PRS\業務効率化\nda\office\racros\Invoke-RacrosNightly.ps1'
   schtasks /Create /TN "nda\racros-tire-trends" /SC DAILY /ST 02:30 /RU PRS /RP `
     /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$script`""
   ```

3. 一度だけ手で動かして、ログを見ます。

   ```powershell
   schtasks /Run /TN "nda\racros-tire-trends"
   Get-Content C:\Users\PRS\業務効率化\nda\data\private\racros\logs\nightly-$(Get-Date -Format yyyyMMdd).log
   ```

4. やめるとき: `schtasks /Delete /TN "nda\racros-tire-trends" /F`

注意:
- スクリプトのパスは、ブランチを `main` に取り込んだ後の `nda` の作業コピーを指します。
- PC が眠っていると動きません。「スリープを解除してこのタスクを実行する」は、タスクスケジューラの画面（`nda\racros-tire-trends` のプロパティ → 条件）で入れます。
- 前の晩の分が動いている間は、`nightly.lock` を見て二重には動きません。
