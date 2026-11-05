# マスキングの部品のテスト。データはすべて架空。
Import-Module (Join-Path $PSScriptRoot '..\RacrosMask.psm1') -Force

Describe '仮名' {
    It '顧客は A から、26 番目の次は AA' {
        Format-Pseudonym -Kind customer -Index 0 | Should Be '顧客A'
        Format-Pseudonym -Kind customer -Index 25 | Should Be '顧客Z'
        Format-Pseudonym -Kind customer -Index 26 | Should Be '顧客AA'
        Format-Pseudonym -Kind customer -Index 701 | Should Be '顧客ZZ'
        Format-Pseudonym -Kind customer -Index 702 | Should Be '顧客AAA'
    }
    It '車両は 3 桁、伝票は 5 桁' {
        Format-Pseudonym -Kind vehicle -Index 0 | Should Be '車両001'
        Format-Pseudonym -Kind vehicle -Index 1233 | Should Be '車両1234'
        Format-Pseudonym -Kind slip -Index 41 | Should Be '伝票00042'
    }
    It '同じ ID には同じ仮名、0 や空は空' {
        $m = New-PseudonymMap
        Get-Pseudonym -Map $m -Kind customer -SourceId 9001 | Should Be '顧客A'
        Get-Pseudonym -Map $m -Kind customer -SourceId 9002 | Should Be '顧客B'
        Get-Pseudonym -Map $m -Kind customer -SourceId 9001 | Should Be '顧客A'
        Get-Pseudonym -Map $m -Kind vehicle -SourceId 9001 | Should Be '車両001'
        Get-Pseudonym -Map $m -Kind customer -SourceId 0 | Should Be ''
        Get-Pseudonym -Map $m -Kind customer -SourceId $null | Should Be ''
    }
    It '対応表を保存して読み直すと、続きの番号から振る' {
        $path = Join-Path $TestDrive 'map.csv'
        $m = New-PseudonymMap -Path $path
        foreach ($i in 1..28) { [void](Get-Pseudonym -Map $m -Kind customer -SourceId (5000 + $i)) }
        [void](Get-Pseudonym -Map $m -Kind vehicle -SourceId 77)
        Save-PseudonymMap -Map $m
        $m2 = New-PseudonymMap -Path $path
        Get-Pseudonym -Map $m2 -Kind customer -SourceId 5028 | Should Be '顧客AB'
        Get-Pseudonym -Map $m2 -Kind customer -SourceId 6000 | Should Be '顧客AC'
        Get-Pseudonym -Map $m2 -Kind vehicle -SourceId 78 | Should Be '車両002'
    }
}

Describe 'タイヤのサイズ・季節・銘柄' {
    It 'サイズを読む' {
        Get-TireSize '155/65R14 75S' | Should Be '155/65R14'
        Get-TireSize 'ﾌﾞﾘﾁﾞｽﾄﾝ W965 145R12 6PR' | Should Be '145R12'
        Get-TireSize 'P205/75R14 95S' | Should Be '205/75R14'
        Get-TireSize '１５５／６５Ｒ１４' | Should Be '155/65R14'
        Get-TireSize '195/80R15 107/105L' | Should Be '195/80R15'
        Get-TireSize '7.00R16 12PR' | Should Be '7.00R16'
        Get-TireSize '175/60R 16' | Should Be '175/60R16'
    }
    It 'サイズでないものは空' {
        Get-TireSize 'クーラ･ガス･R12' | Should Be ''
        Get-TireSize 'ガソリン・エンジンオイル 5W-30 SN' | Should Be ''
        Get-TireSize 'RGﾊﾟﾜｰﾊﾞﾙﾌﾞ･H4U 12V-145/135W' | Should Be ''
        Get-TireSize '' | Should Be ''
    }
    It '季節を読む' {
        Get-TireSeason '155/65R14 75Q' | Should Be '冬'
        Get-TireSeason 'ｽﾀｯﾄﾚｽ･ﾀｲﾔ 145R12' | Should Be '冬'
        Get-TireSeason '155/65R14 75S' | Should Be '夏'
        Get-TireSeason '145R12 6PR' | Should Be ''
    }
    It '銘柄を読む' {
        Get-TireBrand 'ｽﾀｯﾄﾚｽ･ﾀｲﾔ ﾌﾞﾘﾁﾞｽﾄﾝ W965 145R12 6PR' | Should Be 'ブリヂストン'
        Get-TireBrand 'ﾀｲﾔ ﾀﾞﾝﾛｯﾌﾟ DV-01 145R12' | Should Be 'ダンロップ'
        Get-TireBrand 'iceGUARD iG70 155/65R14' | Should Be 'ヨコハマ'
        Get-TireBrand 'ﾀｲﾔ･履き替え' | Should Be ''
    }
}

Describe '自由記述' {
    $common = New-Object 'System.Collections.Generic.HashSet[string]'
    [void]$common.Add('タイヤ・履き替え')
    [void]$common.Add('架空商店様 持込')
    It '共通の文言は正規化して残す' { Protect-FreeText -Text 'ﾀｲﾔ･履き替え' -Common $common | Should Be 'タイヤ・履き替え' }
    It '敬称を含むと共通でも捨てる' { Protect-FreeText -Text '架空商店様 持込' -Common $common | Should Be '<除外>' }
    It '電話番号・長い数字・メールを含むと捨てる' {
        Protect-FreeText -Text '連絡 017-000-0000' -Common $common | Should Be '<除外>'
        Protect-FreeText -Text '番号 12345678' -Common $common | Should Be '<除外>'
        Protect-FreeText -Text 'x@example.com' -Common $common | Should Be '<除外>'
    }
    It '共通でないタイヤの品名は銘柄とサイズだけにする' {
        Protect-FreeText -Text 'ﾌﾞﾘﾁﾞｽﾄﾝ VRX3 155/65R14 中古 架空の書き込み' -Common $common | Should Be '<タイヤ ブリヂストン 155/65R14>'
        Protect-FreeText -Text 'タイヤ 持ち込み品' -Common $common | Should Be '<自由記述>'
    }
    It '共通でない文言は記号に置き換える' { Protect-FreeText -Text '架空の人の頼みごと' -Common $common | Should Be '<自由記述>' }
    It '空は空' { Protect-FreeText -Text $null -Common $common | Should Be '' }
}

Describe 'Protect-RareValue と走行距離' {
    $common = New-Object 'System.Collections.Generic.HashSet[string]'
    [void]$common.Add('ワゴンR')
    It '多い車種は残し、少ない車種は伏せる' {
        Protect-RareValue -Value 'ﾜｺﾞﾝR' -Common $common | Should Be 'ワゴンR'
        Protect-RareValue -Value '架空の珍しい車' -Common $common | Should Be '<少数>'
    }
    It '走行距離は 1 万 km の幅' {
        ConvertTo-KmBucket 54321 | Should Be '50000-59999'
        ConvertTo-KmBucket 0 | Should Be ''
        ConvertTo-KmBucket $null | Should Be ''
    }
}

Describe 'ConvertTo-MaskedRow: 許可リスト' {
    $spec = [ordered]@{
        slip = @{ from = 'DENNO'; as = 'pseudonym:slip' }
        customer = @{ from = 'KOKCD'; as = 'pseudonym:customer' }
        name = @{ from = 'NM'; as = 'freetext' }
        size = @{ from = 'TIRE'; as = 'size' }
        qty = @{ from = 'SU'; as = 'int' }
    }
    $row = [pscustomobject]@{ DENNO = 123; KOKCD = 456; NM = '架空太郎様の車'; TIRE = '155/65R14 75S'; SU = 40; TEL = '017-000-0000'; JYU1 = '架空県架空市' }
    It 'spec の列だけを出し、ほかの列は出さない' {
        $m = New-PseudonymMap
        $o = ConvertTo-MaskedRow -Row $row -Spec $spec -Map $m
        @($o.PSObject.Properties.Name) -join ',' | Should Be 'slip,customer,name,size,qty'
        $o.slip | Should Be '伝票00001'
        $o.customer | Should Be '顧客A'
        $o.name | Should Be '<除外>'
        $o.size | Should Be '155/65R14'
        $o.qty | Should Be 40
        ($o | ConvertTo-Csv -NoTypeInformation) -join "`n" | Should Not Match '017-000-0000|架空県|架空太郎|\b123\b|\b456\b'
    }
    It '元の列が無ければ止まる' {
        $m = New-PseudonymMap
        $bad = [ordered]@{ x = @{ from = 'NOPE'; as = 'keep' } }
        { ConvertTo-MaskedRow -Row $row -Spec $bad -Map $m } | Should Throw
    }
    It '未知の変換は止まる' {
        $m = New-PseudonymMap
        $bad = [ordered]@{ x = @{ from = 'NM'; as = 'raw' } }
        { ConvertTo-MaskedRow -Row $row -Spec $bad -Map $m } | Should Throw
    }
}

Describe '明細の行の分類' {
    $cases = @(
        @(277, 'ﾀｲﾔ･履き替え', 'tire_swap'),
        @(50100, 'タイヤ・履き替え', 'tire_swap'),
        @(0, 'タイヤ夏冬入れ替え', 'tire_swap'),
        @(278, 'ﾀｲﾔ･組み替え', 'tire_mount'),
        @(50100, 'タイヤ・組替え', 'tire_mount'),
        @(279, 'ﾎｲｰﾙ･ﾊﾞﾗﾝｽ', 'balance'),
        @(0, 'ﾎｲｰﾙﾊﾞﾗﾝｽ測定(ｱﾙﾐﾎｲｰﾙ)', 'balance'),
        @(296, 'ﾀｲﾔ･ｺﾞﾑﾊﾞﾙﾌﾞ･TR413 CLX', 'valve'),
        @(0, 'ﾀｲﾔ･ｴｱﾊﾞﾙﾌﾞ', 'valve'),
        @(0, '廃ﾀｲﾔ', 'disposal'),
        @(0, '用済み・タイヤ', 'disposal'),
        @(0, 'ﾀｲﾔ保管料', 'storage'),
        @(50124, 'タイヤ パンク修理', 'puncture'),
        @(50127, 'ホイール･ナット', 'nut'),
        @(50100, 'ｽﾀｯﾄﾚｽ･ﾀｲﾔ ﾌﾞﾘﾁﾞｽﾄﾝ W965 145R12 6PR', 'tire'),
        @(0, '架空銘柄 155/65R14', 'tire'),
        @(50100, 'タイヤ', 'tire'),
        @(50125, 'アルミホイール', 'wheel'),
        @(70950, 'リヤ･ホイールシリンダＯ／Ｈ', 'other'),
        @(20191, 'ガソリン・エンジンオイル 5W-30 SN', 'other'),
        @(75100, 'クーラ･ガス･R12', 'other')
    )
    foreach ($c in $cases) {
        It "$($c[1]) → $($c[2])" { Get-TireLineCategory -KouCd $c[0] -Name $c[1] | Should Be $c[2] }
    }
}

Describe '品番' {
    $common = New-Object 'System.Collections.Generic.HashSet[string]'
    foreach ($x in @('AB-123.4', '16510-81420', 'ABC1-1234567', 'KASO TARO')) { [void]$common.Add($x) }
    It '多くの客に共通する英数字の品番は残す' {
        Protect-PartCode 'ab-123.4' -Common $common | Should Be 'AB-123.4'
        Protect-PartCode '16510-81420' -Common $common | Should Be '16510-81420'
    }
    It '共通でない品番は伏せる' {
        Protect-PartCode 'AB-124.4' -Common $common | Should Be '<少数>'
        Protect-PartCode 'XY-999' | Should Be '<少数>'
    }
    It '数字を含まない値は共通でも捨てる（ローマ字の名前など）' { Protect-PartCode 'kaso taro' -Common $common | Should Be '<除外>' }
    It '車台番号の形は共通でも捨てる' { Protect-PartCode 'abc1-1234567' -Common $common | Should Be '<除外>' }
    It '純正の品番の形（5 桁-英数字）は車台番号の検査から外す' {
        [void]$common.Add('90915-YZZD1')
        Protect-PartCode '90915-yzzd1' -Common $common | Should Be '90915-YZZD1'
        Protect-PartCode '90915-YZZD2' -Common $common | Should Be '<少数>'
    }
    It 'ConvertTo-MaskedRow の code は品番の共通集合を使う' {
        $spec = [ordered]@{ hinban = @{ from = 'HINBAN'; as = 'code' } }
        $m = New-PseudonymMap
        (ConvertTo-MaskedRow -Row ([pscustomobject]@{ HINBAN = '16510-81420' }) -Spec $spec -Map $m -CommonSets @{ hinbans = $common }).hinban | Should Be '16510-81420'
        (ConvertTo-MaskedRow -Row ([pscustomobject]@{ HINBAN = '16510-81421' }) -Spec $spec -Map $m -CommonSets @{ hinbans = $common }).hinban | Should Be '<少数>'
        (ConvertTo-MaskedRow -Row ([pscustomobject]@{ HINBAN = '16510-81420' }) -Spec $spec -Map $m).hinban | Should Be '<少数>'
    }
    It '電話番号と見分けられない 0 始まりの長い数字は捨てる' {
        Protect-PartCode '09000000000' | Should Be '<除外>'
        Protect-PartCode '090-0000-0000' | Should Be '<除外>'
        Protect-PartCode '0888380016' | Should Be '<除外>'
    }
    It 'かな・漢字の書き込みは捨てる' { Protect-PartCode '架空さん取り置き' | Should Be '<除外>' }
}


Describe '出力の置き場' {
    $repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
    It 'リポジトリの外は通す' { Assert-PrivatePath -Path $TestDrive | Should Not BeNullOrEmpty }
    It 'リポジトリの中で git に無視される所は通す' { Assert-PrivatePath -Path (Join-Path $repo 'data\private\racros') | Should Not BeNullOrEmpty }
    It 'リポジトリの中で無視されない所は止める' {
        { Assert-PrivatePath -Path $repo } | Should Throw '無視されない'
        { Assert-PrivatePath -Path (Join-Path $repo 'office\racros') } | Should Throw '無視されない'
    }
    It '名前が似ているだけの隣のフォルダはリポジトリの外とみなす' { Assert-PrivatePath -Path ($repo.TrimEnd('\') + '-other\x') | Should Not BeNullOrEmpty }
    It 'ジャンクションを通る置き場は止める（外に見えても中を指していれば書かない）' {
        $alias = Join-Path $TestDrive 'alias'
        cmd /c mklink /J "$alias" "$(Join-Path $repo 'office\racros')" | Out-Null
        try {
            { Assert-PrivatePath -Path $alias } | Should Throw 'リンク'
            { Assert-PrivatePath -Path (Join-Path $alias 'pseudonyms.csv') -OutsideRepo } | Should Throw 'リンク'
        } finally { cmd /c rmdir "$alias" | Out-Null }
    }
    It '相対パスは PowerShell の今の場所から解く' {
        Push-Location $repo
        try { { Assert-PrivatePath -Path 'map.csv' -OutsideRepo } | Should Throw 'リポジトリの外' } finally { Pop-Location }
    }
    It '対応表はリポジトリの中なら無視される所でも止める' { { Assert-PrivatePath -Path (Join-Path $repo 'data\private\map.csv') -OutsideRepo } | Should Throw 'リポジトリの外' }
    It 'Save-PseudonymMap も自分で置き場を確かめる' {
        $m = New-PseudonymMap -Path (Join-Path $repo 'data\private\racros\map-test.csv')
        [void](Get-Pseudonym -Map $m -Kind customer -SourceId 1)
        { Save-PseudonymMap -Map $m } | Should Throw 'リポジトリの外'
        Test-Path (Join-Path $repo 'data\private\racros\map-test.csv') | Should Be $false
    }
}
