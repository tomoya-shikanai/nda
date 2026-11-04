# マスキング済みの tire_lines.csv から「傾向の台帳」を作る。DB には触れない。
# 出力:
#   <OutDir>/trends/tire-ledger.json            台帳（請求書づくりで引く）
#   <OutDir>/trends/summary.md                  人が読む要約（数字だけ）
#   <OutDir>/trends/history/tire-ledger-<日付>.json  その日の台帳の控え（傾向の移り変わりを後で比べる）
param(
    [string]$OutDir = (Join-Path $PSScriptRoot '..\..\data\private\racros'),
    [int]$MinVehicles = 3,
    [int]$RecentYears = 3
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'RacrosTrends.psm1') -Force

$csv = Join-Path $OutDir 'tire_lines.csv'
if (-not (Test-Path -LiteralPath $csv)) { throw "先に Export-RacrosTireLines.ps1 を流してください: $csv" }
$rows = Import-Csv -LiteralPath $csv -Encoding UTF8
$ledger = New-TireLedger -Rows $rows -MinVehicles $MinVehicles -RecentYears $RecentYears
$metaPath = Join-Path $OutDir 'export_meta.json'
$ledger.Insert(0, 'generated_at', (Get-Date).ToString('s'))
if (Test-Path -LiteralPath $metaPath) { $ledger.Insert(1, 'export', (Get-Content -LiteralPath $metaPath -Raw -Encoding UTF8 | ConvertFrom-Json)) }

$dir = Join-Path $OutDir 'trends'
$hist = Join-Path $dir 'history'
New-Item -ItemType Directory -Force -Path $hist | Out-Null
$json = $ledger | ConvertTo-Json -Depth 12
$json | Set-Content -LiteralPath (Join-Path $dir 'tire-ledger.json') -Encoding UTF8
$json | Set-Content -LiteralPath (Join-Path $hist ("tire-ledger-{0}.json" -f (Get-Date -Format 'yyyyMMdd'))) -Encoding UTF8

# ---- 要約（Markdown）----
$cat = @{ tire_swap = '履き替え'; tire_mount = '組み替え'; balance = 'バランス'; valve = 'バルブ'; disposal = '廃タイヤ'; storage = '保管'; nut = 'ナット'; puncture = 'パンク修理'; rotation = 'ローテーション'; tire = 'タイヤ本体'; wheel = 'ホイール'; other = 'その他' }
function Fmt { param($s) if (-not $s -or $s.n -eq 0) { return '—' } return ('{0:N0}（{1:N0}〜{2:N0}、n={3}）' -f $s.median, $s.p10, $s.p90, $s.n) }
$md = New-Object System.Collections.Generic.List[string]
$md.Add('# タイヤの伝票の傾向（RacroS III から集計）')
$md.Add('')
$md.Add("作成: $($ledger.generated_at)。金額は中央値（10〜90% の幅、件数）。「最近」は $($ledger.definitions.recent_from) 以降。$MinVehicles 台未満の区分は出さない。")
$md.Add('')
$md.Add("- 伝票: $($ledger.totals.slips) 件（最近 $($ledger.totals.recent_slips) 件）、車 $($ledger.totals.vehicles) 台")
$md.Add('')
$md.Add('## 年ごとの件数'); $md.Add(''); $md.Add('| 年 | 伝票 | 履き替え | 組み替え | その他 |'); $md.Add('|---|---:|---:|---:|---:|')
foreach ($y in $ledger.by_year.Keys) { $v = $ledger.by_year[$y]; $md.Add("| $y | $($v.slips) | $($v.swap) | $($v.mount) | $($v.other) |") }
$md.Add(''); $md.Add('## 月ごとの件数（全年の合計）'); $md.Add(''); $md.Add('| 月 | 履き替え | 組み替え | その他 |'); $md.Add('|---:|---:|---:|---:|')
foreach ($m in $ledger.by_month_of_year.Keys) { $v = $ledger.by_month_of_year[$m]; $md.Add("| $m | $($v.swap) | $($v.mount) | $($v.other) |") }
$md.Add(''); $md.Add('## 作業ごとの金額（最近）'); $md.Add(''); $md.Add('| 作業 | 1 行の金額 | 1 本あたり | 数量 | よく使う品名 |'); $md.Add('|---|---|---|---|---|')
foreach ($k in $ledger.work_prices.Keys) {
    $w = $ledger.work_prices[$k]
    $top = ($w.recent_top_items | Select-Object -First 2 | ForEach-Object { "$($_.item)（$($_.n)）" }) -join '、'
    $md.Add("| $($cat[$k]) | $(Fmt $w.recent_amount) | $(Fmt $w.recent_per_unit) | $(Fmt $w.recent_qty) | $top |")
}
$md.Add(''); $md.Add('## 履き替えの 1 行の金額の推移（年ごとの中央値）'); $md.Add('')
if ($ledger.work_prices.Contains('tire_swap')) {
    $md.Add('| 年 | 中央値 | 幅 | 件数 |'); $md.Add('|---|---:|---|---:|')
    foreach ($y in $ledger.work_prices.tire_swap.amount_by_year.Keys) { $s = $ledger.work_prices.tire_swap.amount_by_year[$y]; if ($s.n) { $md.Add("| $y | $('{0:N0}' -f $s.median) | $('{0:N0}' -f $s.p10)〜$('{0:N0}' -f $s.p90) | $($s.n) |") } }
}
$md.Add(''); $md.Add('## タイヤ本体の 1 本の値段（最近・サイズ別）'); $md.Add(''); $md.Add('| サイズ | 1 本 | 本数 | 車 | 銘柄 | 夏冬 |'); $md.Add('|---|---|---|---:|---|---|')
foreach ($s in $ledger.tire_price_by_size.Keys) {
    $v = $ledger.tire_price_by_size[$s]
    $b = ($v.brands.GetEnumerator() | Select-Object -First 3 | ForEach-Object { "$($_.Key) $($_.Value)" }) -join '、'
    $se = ($v.seasons.GetEnumerator() | ForEach-Object { "$($_.Key) $($_.Value)" }) -join '、'
    $md.Add("| $s | $(Fmt $v.price_per_tire) | $(Fmt $v.qty) | $($v.vehicles) | $b | $se |")
}
$md.Add(''); $md.Add('## 請求書の台帳（最近・車種×サイズ、件数の多い順に 30）'); $md.Add('')
$md.Add('| 種類 | 車種 | サイズ | 伝票 | 車 | タイヤ分の合計 | よく載る行（載る割合・1 行の中央値） |'); $md.Add('|---|---|---|---:|---:|---|---|')
foreach ($e in ($ledger.invoice_ledger | Where-Object { $_.level -eq 'model+size' } | Sort-Object { - $_.slips } | Select-Object -First 30)) {
    $ls = ($e.lines | Where-Object { $_.share_of_slips -ge 0.3 } | ForEach-Object { '{0} {1:P0} {2}' -f $cat[$_.category], $_.share_of_slips, $(if ($_.amount.n) { '{0:N0}' -f $_.amount.median } else { '—' }) }) -join '、'
    $md.Add("| $(@{swap='履替';mount='組替'}[$e.kind]) | $($e.model) | $($e.size) | $($e.slips) | $($e.vehicles) | $(Fmt $e.slip_total) | $ls |")
}
$md.Add(''); $md.Add('## サイズだけで引く台帳（最近）'); $md.Add('')
$md.Add('| 種類 | サイズ | 伝票 | 車 | タイヤ分の合計 |'); $md.Add('|---|---|---:|---:|---|')
foreach ($e in ($ledger.invoice_ledger | Where-Object { $_.level -eq 'size' } | Sort-Object { - $_.slips } | Select-Object -First 20)) { $md.Add("| $(@{swap='履替';mount='組替'}[$e.kind]) | $($e.size) | $($e.slips) | $($e.vehicles) | $(Fmt $e.slip_total) |") }
$md.Add(''); $md.Add('## タイヤの伝票に一緒に載る行（最近）'); $md.Add('')
$md.Add((($ledger.co_items | Select-Object -First 15 | ForEach-Object { "$($_.item)（$($_.lines)）" }) -join '、'))
$md | Set-Content -LiteralPath (Join-Path $dir 'summary.md') -Encoding UTF8

Write-Output ("slips={0} recent={1} ledger_entries={2} sizes={3} models={4}" -f $ledger.totals.slips, $ledger.totals.recent_slips, @($ledger.invoice_ledger).Count, $ledger.tire_price_by_size.Count, $ledger.models.Count)
