# タイヤの伝票（タイヤの作業・品目を 1 行でも含む伝票）の明細を、この PC の中でマスキングして書き出す。
# 読むのは RacroS III の DB だけ（RacrosDb.psm1 経由。SELECT だけ）。書くのは OutDir と対応表だけ。
#
# 出力:
#   <OutDir>/tire_lines.csv     マスキング済みの明細（1 行 = 明細 1 行。客・車・伝票は仮名）
#   <OutDir>/export_meta.json   件数・実行時刻（客の情報なし）
#   <MapPath>                   仮名と RacroS の内部番号の対応表（リポジトリの外）
# 標準出力には件数だけを出す（行の中身は出さない）。
param(
    [string]$OutDir = (Join-Path $PSScriptRoot '..\..\data\private\racros'),
    [string]$MapPath = 'C:\Users\PRS\nda-private\racros\pseudonyms.csv',
    [string[]]$Databases = @('RS3_SYARE', 'RS3_DATA'),
    [int]$MinCustomers = 3,   # 品名・品番を残すのに必要な、その品名を使った客の数
    [int]$MinVehicles = 3     # 車種・型式を残すのに必要な、その値を持つ車の数
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'RacrosDb.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'RacrosMask.psm1') -Force

$started = Get-Date
$mapFull = Assert-PrivatePath -Path $MapPath -OutsideRepo
$OutDir = Assert-PrivatePath -Path $OutDir
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# タイヤの伝票を見分ける条件（工賃コードか品名）
$tireCodes = '277,278,279,296,309,50100,50101,50102,50103,50105,50110,50121,50122,50123,50128,50129,82570,88220,520001'
$tireDenSql = "SELECT DISTINCT SYAJNL_DENNO FROM SYAJNL_DAT WHERE SYAJNL_KOUCD IN ($tireCodes) OR SYAJNL_NM LIKE N'%タイヤ%' OR SYAJNL_NM LIKE N'%ﾀｲﾔ%' OR SYAJNL_NM LIKE N'%スタッドレス%' OR SYAJNL_NM LIKE N'%ｽﾀｯﾄﾞﾚｽ%' OR SYAJNL_NM LIKE N'%ｽﾀｯﾄﾚｽ%'"

# ---- 共通の値の集合（品名・車種・型式）。多くの客・車に現れる値だけを残すため ----
function Add-Common {
    param([hashtable]$Counts, [string]$Value, [int]$N)
    $t = ConvertTo-NormalizedText $Value
    if (-not $t) { return }
    # 表記ゆれを正規化して合わせるとき、同じ客を二重に数えないよう、和ではなく最大を取る
    if (-not $Counts.ContainsKey($t) -or $Counts[$t] -lt $N) { $Counts[$t] = $N }
}
$nameCounts = @{}; $modelCounts = @{}; $kataCounts = @{}; $hinbanCounts = @{}
foreach ($db in $Databases) {
    foreach ($r in (Invoke-RacrosSelect -Database $db -Sql "SELECT l.SYAJNL_NM v, COUNT(DISTINCT h.TJNL_KOKCD) n FROM SYAJNL_DAT l JOIN TJNL_DAT h ON h.TJNL_DENNO = l.SYAJNL_DENNO GROUP BY l.SYAJNL_NM")) { Add-Common $nameCounts $r.v $r.n }
    foreach ($r in (Invoke-RacrosSelect -Database $db -Sql "SELECT l.SYAJNL_HINBAN v, COUNT(DISTINCT h.TJNL_KOKCD) n FROM SYAJNL_DAT l JOIN TJNL_DAT h ON h.TJNL_DENNO = l.SYAJNL_DENNO GROUP BY l.SYAJNL_HINBAN")) { Add-Common $hinbanCounts ("$($r.v)".ToUpperInvariant()) $r.n }
    foreach ($r in (Invoke-RacrosSelect -Database $db -Sql "SELECT TJNL_SYASYU v, COUNT(DISTINCT TJNL_CARCD) n FROM TJNL_DAT GROUP BY TJNL_SYASYU")) { Add-Common $modelCounts $r.v $r.n }
    foreach ($r in (Invoke-RacrosSelect -Database $db -Sql "SELECT TJNL_KATA v, COUNT(DISTINCT TJNL_CARCD) n FROM TJNL_DAT GROUP BY TJNL_KATA")) { Add-Common $kataCounts $r.v $r.n }
}
function New-CommonSet { param([hashtable]$Counts, [int]$Min)
    $s = New-Object 'System.Collections.Generic.HashSet[string]'
    foreach ($k in $Counts.Keys) { if ($Counts[$k] -ge $Min) { [void]$s.Add($k) } }
    return , $s
}
$common = @{
    names = (New-CommonSet $nameCounts $MinCustomers)
    models = (New-CommonSet $modelCounts $MinVehicles)
    katas = (New-CommonSet $kataCounts $MinVehicles)
    hinbans = (New-CommonSet $hinbanCounts $MinCustomers)
}

# ---- 許可リスト。ここに無い列は出力に出ない ----
$spec = [ordered]@{
    src           = @{ from = 'src'; as = 'keep' }
    slip          = @{ from = 'TJNL_DENNO'; as = 'pseudonym:slip' }
    date          = @{ from = 'TJNL_YMD'; as = 'int' }
    customer      = @{ from = 'TJNL_KOKCD'; as = 'pseudonym:customer' }
    vehicle       = @{ from = 'TJNL_CARCD'; as = 'pseudonym:vehicle' }
    densyu        = @{ from = 'TJNL_DENSYU'; as = 'int' }
    slip_type     = @{ from = 'TJNL_TYPE'; as = 'int' }
    urikbn        = @{ from = 'TJNL_URIKBN'; as = 'int' }
    kdel          = @{ from = 'TJNL_KDEL'; as = 'int' }
    maker_cd      = @{ from = 'TJNL_MAKER'; as = 'int' }
    model         = @{ from = 'TJNL_SYASYU'; as = 'rare:models' }
    katashiki     = @{ from = 'TJNL_KATA'; as = 'rare:katas' }
    km_band       = @{ from = 'TJNL_KM'; as = 'km' }
    summer_f      = @{ from = 'TJNL_TIRE1_F'; as = 'size' }
    summer_r      = @{ from = 'TJNL_TIRE1_R'; as = 'size' }
    winter_f      = @{ from = 'TJNL_TIRE2_F'; as = 'size' }
    winter_r      = @{ from = 'TJNL_TIRE2_R'; as = 'size' }
    line_no       = @{ from = 'SYAJNL_DENSEQ'; as = 'int' }
    category      = @{ from = 'category'; as = 'keep' }
    kou_cd        = @{ from = 'SYAJNL_KOUCD'; as = 'int' }
    buh_cd        = @{ from = 'SYAJNL_BUHCD'; as = 'int' }
    bykbn         = @{ from = 'SYAJNL_BYKBN'; as = 'int' }
    sagkbn        = @{ from = 'SYAJNL_SAGKBN'; as = 'int' }
    item          = @{ from = 'SYAJNL_NM'; as = 'freetext' }
    item_size     = @{ from = 'SYAJNL_NM'; as = 'size' }
    item_brand    = @{ from = 'SYAJNL_NM'; as = 'brand' }
    item_season   = @{ from = 'SYAJNL_NM'; as = 'season' }
    hinban        = @{ from = 'SYAJNL_HINBAN'; as = 'code' }
    work_sisu     = @{ from = 'SYAJNL_S_SISU'; as = 'int' }
    work_amount   = @{ from = 'SYAJNL_S_KIN'; as = 'int' }
    qty_x10       = @{ from = 'SYAJNL_B_SU'; as = 'int' }
    unit_price    = @{ from = 'SYAJNL_B_TAN'; as = 'int' }
    parts_amount  = @{ from = 'SYAJNL_B_KIN'; as = 'int' }
    line_del      = @{ from = 'SYAJNL_DEL'; as = 'int' }
}

$map = New-PseudonymMap -Path $mapFull
$out = New-Object System.Collections.Generic.List[object]
$perDb = [ordered]@{}
foreach ($db in $Databases) {
    $sql = @"
SELECT N'$db' AS src,
  h.TJNL_DENNO, h.TJNL_YMD, h.TJNL_KOKCD, h.TJNL_CARCD, h.TJNL_DENSYU, h.TJNL_TYPE, h.TJNL_URIKBN, h.TJNL_KDEL, h.TJNL_MAKER,
  h.TJNL_SYASYU, h.TJNL_KATA, h.TJNL_KM, h.TJNL_TIRE1_F, h.TJNL_TIRE1_R, h.TJNL_TIRE2_F, h.TJNL_TIRE2_R,
  l.SYAJNL_DENSEQ, l.SYAJNL_KOUCD, l.SYAJNL_BUHCD, l.SYAJNL_BYKBN, l.SYAJNL_SAGKBN, l.SYAJNL_NM, l.SYAJNL_HINBAN,
  l.SYAJNL_S_SISU, l.SYAJNL_S_KIN, l.SYAJNL_B_SU, l.SYAJNL_B_TAN, l.SYAJNL_B_KIN, l.SYAJNL_DEL
FROM TJNL_DAT h JOIN SYAJNL_DAT l ON l.SYAJNL_DENNO = h.TJNL_DENNO
WHERE h.TJNL_DENNO IN ($tireDenSql)
ORDER BY h.TJNL_DENNO, l.SYAJNL_DENSEQ
"@
    $rows = Invoke-RacrosSelect -Database $db -Sql $sql
    $perDb[$db] = @($rows).Count
    foreach ($r in $rows) {
        $r | Add-Member -NotePropertyName category -NotePropertyValue (Get-TireLineCategory -KouCd $r.SYAJNL_KOUCD -Name $r.SYAJNL_NM)
        $out.Add((ConvertTo-MaskedRow -Row $r -Spec $spec -Map $map -CommonSets $common))
    }
    $rows = $null
}

$csv = Join-Path $OutDir 'tire_lines.csv'
$out | Export-Csv -LiteralPath $csv -NoTypeInformation -Encoding UTF8
Save-PseudonymMap -Map $map

$meta = [ordered]@{
    exported_at = (Get-Date).ToString('s')
    seconds = [int]((Get-Date) - $started).TotalSeconds
    lines_per_db = $perDb
    lines = $out.Count
    slips = @($out | Select-Object -ExpandProperty slip -Unique).Count
    min_customers_for_names = $MinCustomers
    min_vehicles_for_models = $MinVehicles
    common_names = $common.names.Count
    common_hinbans = $common.hinbans.Count
}
$meta | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutDir 'export_meta.json') -Encoding UTF8
Write-Output ("lines={0} slips={1} seconds={2} ({3})" -f $meta.lines, $meta.slips, $meta.seconds, (($perDb.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ' '))
