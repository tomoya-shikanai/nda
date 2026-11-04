# マスキング済みのタイヤの明細（tire_lines.csv）から、請求書づくりに使う「傾向の台帳」を作る部品。
# DB には触れない。入力はマスキング済みの行だけ。純粋な関数にしてテストする（tests/RacrosTrends.Tests.ps1）。

Set-StrictMode -Version Latest

# 分位（線形補間）。空なら $null
function Get-Quantile {
    param([double[]]$Sorted, [double]$P)
    if (-not $Sorted -or $Sorted.Count -eq 0) { return $null }
    if ($Sorted.Count -eq 1) { return $Sorted[0] }
    $h = ($Sorted.Count - 1) * $P
    $lo = [Math]::Floor($h); $hi = [Math]::Ceiling($h)
    return $Sorted[$lo] + ($h - $lo) * ($Sorted[$hi] - $Sorted[$lo])
}

# 件数・中央値・幅（10〜90%）・最小・最大
function Get-Stats {
    param([AllowEmptyCollection()][object[]]$Values)
    $v = @($Values | Where-Object { $null -ne $_ -and "$_" -ne '' } | ForEach-Object { [double]$_ } | Sort-Object)
    if ($v.Count -eq 0) { return [ordered]@{ n = 0 } }
    return [ordered]@{
        n = $v.Count
        median = [Math]::Round((Get-Quantile $v 0.5))
        p10 = [Math]::Round((Get-Quantile $v 0.1))
        p90 = [Math]::Round((Get-Quantile $v 0.9))
        min = $v[0]
        max = $v[-1]
    }
}

# 値 → 件数（多い順）
function ConvertTo-CountMap {
    param([AllowEmptyCollection()][object[]]$Values)
    $h = [ordered]@{}
    foreach ($g in ($Values | Group-Object | Sort-Object Count -Descending)) { $h[$g.Name] = $g.Count }
    return $h
}

# 伝票の種類: mount（タイヤを買って組み替え）／swap（季節の履き替え）／other（パンク・保管・廃タイヤだけ等）
function Get-SlipKind {
    param([Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Lines)
    $cats = @($Lines | ForEach-Object { $_.category })
    $tireBought = @($Lines | Where-Object { $_.category -eq 'tire' -and [int]$_.parts_amount -gt 0 }).Count -gt 0
    if ($cats -contains 'tire_mount' -or $tireBought) { return 'mount' }
    if ($cats -contains 'tire_swap') { return 'swap' }
    return 'other'
}

# 伝票のサイズ: 見出しの夏のサイズ → 冬のサイズ → 明細のタイヤのサイズ
function Get-SlipSize {
    param([Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Lines)
    $h = $Lines[0]
    if ($h.summer_f) { return $h.summer_f }
    if ($h.winter_f) { return $h.winter_f }
    $s = @($Lines | Where-Object { $_.item_size } | Select-Object -First 1)
    if ($s.Count) { return $s[0].item_size }
    return ''
}

# 1 行の金額（工賃＋部品）と数量
function Get-LineAmount { param($Line) return [int64]$Line.work_amount + [int64]$Line.parts_amount }
function Get-LineQty { param($Line) return [double]$Line.qty_x10 / 10 }

# 明細を伝票ごとにまとめる。削除の印がある伝票・行は除く。
function Group-TireSlips {
    param([Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Rows)
    $valid = @($Rows | Where-Object { [int]$_.line_del -eq 0 -and [int]$_.kdel -eq 0 })
    $slips = foreach ($g in ($valid | Group-Object slip)) {
        $lines = @($g.Group)
        $d = [int]$lines[0].date
        [pscustomobject]@{
            slip = $g.Name
            date = $d
            year = [int][Math]::Floor($d / 10000)
            month = [int]([Math]::Floor($d / 100) % 100)
            vehicle = $lines[0].vehicle
            customer = $lines[0].customer
            model = $lines[0].model
            size = Get-SlipSize -Lines $lines
            kind = Get-SlipKind -Lines $lines
            lines = $lines
        }
    }
    return , @($slips)
}

# 行の束の金額の傾向（行単位）。代表の品名は最も多いもの。
function Get-LineSummary {
    param([AllowEmptyCollection()][object[]]$Lines, [int]$SlipCount)
    $byCat = $Lines | Group-Object category
    $out = foreach ($g in $byCat) {
        $ls = @($g.Group)
        $slipsWith = @($ls | Select-Object -ExpandProperty slip -Unique).Count
        $topItem = $ls | Group-Object item | Sort-Object Count -Descending | Select-Object -First 1
        $perUnit = @($ls | Where-Object { (Get-LineQty $_) -gt 0 -and (Get-LineAmount $_) -gt 0 } | ForEach-Object { (Get-LineAmount $_) / (Get-LineQty $_) })
        [ordered]@{
            category = $g.Name
            share_of_slips = if ($SlipCount) { [Math]::Round($slipsWith / $SlipCount, 2) } else { $null }
            top_item = $topItem.Name
            qty = Get-Stats @($ls | Where-Object { (Get-LineQty $_) -gt 0 } | ForEach-Object { Get-LineQty $_ })
            amount = Get-Stats @($ls | Where-Object { (Get-LineAmount $_) -gt 0 } | ForEach-Object { Get-LineAmount $_ })
            per_unit = Get-Stats $perUnit
        }
    }
    return , @($out | Sort-Object { - $_.share_of_slips })
}

# 台帳を作る。
#   MinVehicles: 1 つの区分（車種×サイズなど）を出すのに必要な車の台数（少ない区分は出さない）
#   RecentYears: 金額の「最近」の範囲（年）。値上げを反映するため、台帳の金額は最近の分から出す
#   Today: 基準日（yyyyMMdd の数。テストで固定する）
function New-TireLedger {
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Rows,
        [int]$MinVehicles = 3,
        [int]$RecentYears = 3,
        [int]$Today = [int](Get-Date -Format 'yyyyMMdd')
    )
    $tireCats = @('tire_swap', 'tire_mount', 'balance', 'valve', 'disposal', 'storage', 'nut', 'puncture', 'rotation', 'tire', 'wheel')
    $slips = Group-TireSlips -Rows $Rows
    $recentFrom = ([int][Math]::Floor($Today / 10000) - $RecentYears + 1) * 10000 + 101
    $recent = @($slips | Where-Object { $_.date -ge $recentFrom })
    $recentLines = @($recent | ForEach-Object { $_.lines } | Where-Object { $_.category -in $tireCats })

    # 全体の件数（年・月）
    $byYear = [ordered]@{}
    foreach ($g in ($slips | Group-Object year | Sort-Object { [int]$_.Name })) {
        $byYear[$g.Name] = [ordered]@{
            slips = $g.Count
            swap = @($g.Group | Where-Object kind -eq 'swap').Count
            mount = @($g.Group | Where-Object kind -eq 'mount').Count
            other = @($g.Group | Where-Object kind -eq 'other').Count
        }
    }
    $byMonth = [ordered]@{}
    foreach ($m in 1..12) {
        $ms = @($slips | Where-Object month -eq $m)
        $byMonth["$m"] = [ordered]@{ swap = @($ms | Where-Object kind -eq 'swap').Count; mount = @($ms | Where-Object kind -eq 'mount').Count; other = @($ms | Where-Object kind -eq 'other').Count }
    }
    $byYearMonth = [ordered]@{}
    foreach ($g in ($slips | Group-Object { '{0}-{1:00}' -f $_.year, $_.month } | Sort-Object Name)) {
        $byYearMonth[$g.Name] = [ordered]@{ swap = @($g.Group | Where-Object kind -eq 'swap').Count; mount = @($g.Group | Where-Object kind -eq 'mount').Count; other = @($g.Group | Where-Object kind -eq 'other').Count }
    }

    # 作業ごとの金額（年ごとと最近）
    $work = [ordered]@{}
    foreach ($cat in $tireCats) {
        $all = @($slips | ForEach-Object { $_.lines } | Where-Object category -eq $cat)
        if ($all.Count -eq 0) { continue }
        $yearly = [ordered]@{}
        foreach ($g in ($all | Group-Object { [int][Math]::Floor([int]$_.date / 10000) } | Sort-Object { [int]$_.Name })) {
            $yearly[$g.Name] = Get-Stats @($g.Group | Where-Object { (Get-LineAmount $_) -gt 0 } | ForEach-Object { Get-LineAmount $_ })
        }
        $rc = @($recentLines | Where-Object category -eq $cat)
        $work[$cat] = [ordered]@{
            lines = $all.Count
            recent_amount = Get-Stats @($rc | Where-Object { (Get-LineAmount $_) -gt 0 } | ForEach-Object { Get-LineAmount $_ })
            recent_per_unit = Get-Stats @($rc | Where-Object { (Get-LineQty $_) -gt 0 -and (Get-LineAmount $_) -gt 0 } | ForEach-Object { (Get-LineAmount $_) / (Get-LineQty $_) })
            recent_qty = Get-Stats @($rc | Where-Object { (Get-LineQty $_) -gt 0 } | ForEach-Object { Get-LineQty $_ })
            recent_top_items = @($rc | Group-Object item | Sort-Object Count -Descending | Select-Object -First 5 | ForEach-Object { [ordered]@{ item = $_.Name; n = $_.Count } })
            amount_by_year = $yearly
        }
    }

    # タイヤ本体（サイズ・銘柄ごとの 1 本の値段。最近の分）
    # 品名にサイズが無い行（「タイヤ」だけ等）は、伝票のサイズ（見出しの夏 → 冬）で補う
    $slipSize = @{}
    foreach ($s in $recent) { $slipSize[$s.slip] = $s.size }
    $tireLines = @($recentLines | Where-Object { $_.category -eq 'tire' -and [int]$_.parts_amount -gt 0 -and (Get-LineQty $_) -gt 0 })
    $bySize = [ordered]@{}
    foreach ($g in ($tireLines | Group-Object { if ($_.item_size) { $_.item_size } else { $slipSize[$_.slip] } } | Where-Object { $_.Name } | Sort-Object Count -Descending)) {
        $veh = @($g.Group | Select-Object -ExpandProperty vehicle -Unique).Count
        if ($veh -lt $MinVehicles) { continue }
        $bySize[$g.Name] = [ordered]@{
            lines = $g.Count
            vehicles = $veh
            price_per_tire = Get-Stats @($g.Group | ForEach-Object { [int64]$_.parts_amount / (Get-LineQty $_) })
            qty = Get-Stats @($g.Group | ForEach-Object { Get-LineQty $_ })
            brands = (ConvertTo-CountMap @($g.Group | ForEach-Object { if ($_.item_brand) { $_.item_brand } else { '(不明)' } }))
            seasons = (ConvertTo-CountMap @($g.Group | ForEach-Object { if ($_.item_season) { $_.item_season } else { '(不明)' } }))
        }
    }
    $byBrand = [ordered]@{}
    foreach ($g in ($tireLines | Group-Object { if ($_.item_brand) { $_.item_brand } else { '(不明)' } } | Sort-Object Count -Descending)) {
        $veh = @($g.Group | Select-Object -ExpandProperty vehicle -Unique).Count
        if ($veh -lt $MinVehicles) { continue }
        $byBrand[$g.Name] = [ordered]@{ lines = $g.Count; vehicles = $veh; price_per_tire = Get-Stats @($g.Group | ForEach-Object { [int64]$_.parts_amount / (Get-LineQty $_) }) }
    }

    # 請求書の台帳: 車種×サイズ → よく載る行と金額。少ない区分は出さない。
    $entries = New-Object System.Collections.Generic.List[object]
    $keys = @(
        @{ level = 'model+size'; key = { param($s) if ($s.model -and $s.model -notlike '<*' -and $s.size) { "$($s.model)|$($s.size)" } else { '' } } },
        @{ level = 'size'; key = { param($s) if ($s.size) { $s.size } else { '' } } },
        @{ level = 'all'; key = { param($s) 'all' } }
    )
    foreach ($kd in $keys) {
        foreach ($kind in @('swap', 'mount')) {
            $groups = $recent | Where-Object kind -eq $kind | Group-Object { & $kd.key $_ } | Where-Object { $_.Name }
            foreach ($g in $groups) {
                $ss = @($g.Group)
                $veh = @($ss | Select-Object -ExpandProperty vehicle -Unique).Count
                if ($veh -lt $MinVehicles) { continue }
                $lines = @($ss | ForEach-Object { $_.lines } | Where-Object { $_.category -in $tireCats })
                $model, $size = if ($kd.level -eq 'model+size') { $g.Name.Split('|', 2) } elseif ($kd.level -eq 'size') { '', $g.Name } else { '', '' }
                $entries.Add([ordered]@{
                    level = $kd.level
                    kind = $kind
                    model = $model
                    size = $size
                    slips = $ss.Count
                    vehicles = $veh
                    slip_total = Get-Stats @($ss | ForEach-Object { ($_.lines | Where-Object { $_.category -in $tireCats } | ForEach-Object { Get-LineAmount $_ } | Measure-Object -Sum).Sum })
                    lines = Get-LineSummary -Lines $lines -SlipCount $ss.Count
                })
            }
        }
    }

    # 車種ごとのサイズ（見出しの値。車の台数で数える）
    $models = [ordered]@{}
    foreach ($g in ($slips | Where-Object { $_.model -and $_.model -notlike '<*' } | Group-Object model | Sort-Object Count -Descending)) {
        $veh = @($g.Group | Select-Object -ExpandProperty vehicle -Unique)
        if ($veh.Count -lt $MinVehicles) { continue }
        $first = @($g.Group | ForEach-Object { $_.lines[0] })
        $models[$g.Name] = [ordered]@{
            slips = $g.Count
            vehicles = $veh.Count
            summer_sizes = (ConvertTo-CountMap @($first | Where-Object summer_f | Sort-Object vehicle -Unique | ForEach-Object { $_.summer_f }))
            winter_sizes = (ConvertTo-CountMap @($first | Where-Object winter_f | Sort-Object vehicle -Unique | ForEach-Object { $_.winter_f }))
            kinds = (ConvertTo-CountMap @($g.Group | ForEach-Object { $_.kind }))
        }
    }

    # タイヤの伝票に一緒に載る、タイヤ以外の行（共通の品名だけ）
    $co = @($recent | ForEach-Object { $_.lines } | Where-Object { $_.category -eq 'other' -and $_.item -notlike '<*' } | Group-Object item | Sort-Object Count -Descending | Select-Object -First 20 | ForEach-Object { [ordered]@{ item = $_.Name; lines = $_.Count } })

    return [ordered]@{
        definitions = [ordered]@{
            min_vehicles = $MinVehicles
            recent_from = $recentFrom
            amounts = '工賃（S_KIN）＋部品（B_KIN）。RacroS の明細の金額をそのまま使う（税の扱いは未確認）'
            qty = 'B_SU ÷ 10（例: 40 → 4 本）'
            kinds = 'mount=タイヤを買って組み替え、swap=季節の履き替え、other=パンク・保管・廃タイヤだけ等'
        }
        totals = [ordered]@{ slips = $slips.Count; recent_slips = $recent.Count; vehicles = @($slips | Select-Object -ExpandProperty vehicle -Unique).Count }
        by_year = $byYear
        by_month_of_year = $byMonth
        by_year_month = $byYearMonth
        work_prices = $work
        tire_price_by_size = $bySize
        tire_price_by_brand = $byBrand
        invoice_ledger = $entries.ToArray()
        models = $models
        co_items = $co
    }
}

Export-ModuleMember -Function Get-Quantile, Get-Stats, Get-SlipKind, Get-SlipSize, Group-TireSlips, Get-LineSummary, New-TireLedger
