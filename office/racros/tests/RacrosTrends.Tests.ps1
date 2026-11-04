# 集計の部品のテスト。行はすべて架空（マスキング済みの形を模したもの）。
Import-Module (Join-Path $PSScriptRoot '..\RacrosTrends.psm1') -Force

function New-Line {
    param($Slip, $Vehicle, $Date, $Category, $Item = '', $Work = 0, $Parts = 0, $Qty10 = 0, $Model = '架空車A', $Summer = '155/65R14', $Winter = '', $ItemSize = '', $Brand = '', $Season = '', $Del = 0, $KDel = 0)
    [pscustomobject]@{
        slip = $Slip; vehicle = $Vehicle; customer = "顧客$Vehicle"; date = "$Date"; model = $Model; summer_f = $Summer; winter_f = $Winter
        category = $Category; item = $Item; item_size = $ItemSize; item_brand = $Brand; item_season = $Season
        work_amount = "$Work"; parts_amount = "$Parts"; qty_x10 = "$Qty10"; line_del = "$Del"; kdel = "$KDel"
    }
}

Describe '統計' {
    It '中央値と幅' {
        $s = Get-Stats @(1000, 2000, 3000, 4000, 5000)
        $s.n | Should Be 5
        $s.median | Should Be 3000
        $s.min | Should Be 1000
        $s.max | Should Be 5000
        $s.p10 | Should Be 1400
    }
    It '空や $null を除く' {
        (Get-Stats @()).n | Should Be 0
        (Get-Stats @($null, '', 10)).median | Should Be 10
    }
}

Describe '伝票の種類とサイズ' {
    It 'タイヤを買えば組み替え' {
        Get-SlipKind @((New-Line 's1' 'v1' 20251101 'tire_swap' -Work 2000), (New-Line 's1' 'v1' 20251101 'tire' -Parts 40000 -Qty10 40)) | Should Be 'mount'
    }
    It '履き替えだけなら履き替え' { Get-SlipKind @((New-Line 's1' 'v1' 20251101 'tire_swap' -Work 2000)) | Should Be 'swap' }
    It 'パンクだけならその他' { Get-SlipKind @((New-Line 's1' 'v1' 20251101 'puncture' -Work 1500)) | Should Be 'other' }
    It 'サイズは見出しの夏 → 冬 → 明細の順' {
        Get-SlipSize @((New-Line 's1' 'v1' 20251101 'tire' -Summer '' -Winter '145/80R13')) | Should Be '145/80R13'
        Get-SlipSize @((New-Line 's1' 'v1' 20251101 'other' -Summer '' -Winter ''), (New-Line 's1' 'v1' 20251101 'tire' -Summer '' -ItemSize '165/55R14')) | Should Be '165/55R14'
    }
}

Describe '台帳' {
    # 架空: 車種 架空車A（155/65R14）の 4 台が 2025 年 11 月に履き替え、1 台はタイヤを 4 本購入。古い 2018 年の伝票は「最近」に入らない。
    $rows = @(
        (New-Line 's1' 'v1' 20251105 'tire_swap' 'タイヤ・履き替え' -Work 2400 -Qty10 40),
        (New-Line 's1' 'v1' 20251105 'disposal' '廃タイヤ' -Work 300 -Qty10 10),
        (New-Line 's2' 'v2' 20251110 'tire_swap' 'タイヤ・履き替え' -Work 2400 -Qty10 40),
        (New-Line 's3' 'v3' 20251112 'tire_swap' 'タイヤ・履き替え' -Work 2200 -Qty10 40),
        (New-Line 's4' 'v4' 20251120 'tire_mount' 'タイヤ・組み替え' -Work 6000 -Qty10 40),
        (New-Line 's4' 'v4' 20251120 'tire' '<タイヤ 架空 155/65R14>' -Parts 32000 -Qty10 40 -ItemSize '155/65R14' -Brand 'ブリヂストン' -Season '冬'),
        (New-Line 's5' 'v5' 20180410 'tire_swap' 'タイヤ・履き替え' -Work 2000 -Qty10 40),
        (New-Line 's6' 'v6' 20251121 'tire_swap' 'タイヤ・履き替え' -Work 9999 -Qty10 40 -Del 1),
        (New-Line 's7' 'v7' 20251122 'tire_swap' 'タイヤ・履き替え' -Work 9999 -Qty10 40 -KDel 9),
        (New-Line 's8' 'v8' 20251123 'tire_swap' 'タイヤ・履き替え' -Work 2400 -Qty10 40 -Model '<少数>')
    )
    $l = New-TireLedger -Rows $rows -MinVehicles 3 -RecentYears 3 -Today 20261104

    It '削除の印がある行・伝票は数えない' { $l.totals.slips | Should Be 6 }
    It '「最近」は 2024 年 1 月 1 日から' {
        $l.definitions.recent_from | Should Be 20240101
        $l.totals.recent_slips | Should Be 5
    }
    It '年・月ごとの件数' {
        $l.by_year['2025'].swap | Should Be 4
        $l.by_year['2025'].mount | Should Be 1
        $l.by_month_of_year['11'].swap | Should Be 4
        $l.by_month_of_year['4'].swap | Should Be 1
    }
    It '履き替えの金額（最近）は 2018 年の分と削除分を含まない' {
        $w = $l.work_prices['tire_swap']
        $w.recent_amount.n | Should Be 4
        $w.recent_amount.median | Should Be 2400
        $w.recent_amount.max | Should Be 2400
        $w.recent_per_unit.median | Should Be 600
        $w.amount_by_year['2018'].median | Should Be 2000
    }
    It 'タイヤ本体は台数が足りないサイズを出さない' { $l.tire_price_by_size.Count | Should Be 0 }
    It '品名にサイズが無いタイヤは、伝票のサイズで数える' {
        $more = $rows + @(
            (New-Line 't1' 'w1' 20251101 'tire' 'タイヤ' -Parts 20000 -Qty10 40),
            (New-Line 't2' 'w2' 20251102 'tire' 'タイヤ' -Parts 24000 -Qty10 40)
        )
        $l2 = New-TireLedger -Rows $more -MinVehicles 3 -RecentYears 3 -Today 20261104
        $s = $l2.tire_price_by_size['155/65R14']
        $s.vehicles | Should Be 3
        $s.price_per_tire.median | Should Be 6000
    }
    It '少ない区分は出さない（車種×サイズの履き替えは 3 台で出る、組み替えは 1 台なので出ない）' {
        $ms = @($l.invoice_ledger | Where-Object { $_.level -eq 'model+size' })
        @($ms | Where-Object kind -eq 'swap').Count | Should Be 1
        @($ms | Where-Object kind -eq 'mount').Count | Should Be 0
        $e = $ms | Where-Object kind -eq 'swap'
        $e.model | Should Be '架空車A'
        $e.vehicles | Should Be 3
        ($e.lines | Where-Object category -eq 'tire_swap').share_of_slips | Should Be 1
        ($e.lines | Where-Object category -eq 'disposal').share_of_slips | Should Be 0.33
    }
    It '伏せた車種（<少数>）は車種の区分に入れない' {
        @($l.invoice_ledger | Where-Object { $_.model -like '<*' }).Count | Should Be 0
        $l.models.Contains('<少数>') | Should Be $false
    }
    It 'サイズだけの区分には伏せた車種の伝票も入る' {
        $e = $l.invoice_ledger | Where-Object { $_.level -eq 'size' -and $_.kind -eq 'swap' }
        $e.vehicles | Should Be 4
    }
}
