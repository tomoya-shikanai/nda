# RacroS III から取り出した行を、この PC の中でマスキングするための部品。
# 方針（docs/anonymization.md・docs/racros-schema.md）:
#   - 出してよい列を許可リスト（spec）で決める。spec に無い列は捨てる。
#   - 客・車・伝票の番号は 顧客A・車両001・伝票00001 の仮名にする。対応表はリポジトリの外に置く。
#   - 自由記述（品名など）は、多くの客に共通する文言だけを残し、それ以外は構造化した値（サイズ・銘柄）か記号に置き換える。
#   - 電話番号・メール・長い数字・敬称などを含む文字列は、共通でも捨てる。
# DB には触れない（純粋な関数だけ）。テストは tests/RacrosMask.Tests.ps1。

Set-StrictMode -Version Latest

# ---------- 文字の正規化 ----------

# 半角カナ・全角英数を揃え（NFKC）、空白を 1 つにまとめる
function ConvertTo-NormalizedText {
    param([AllowNull()][AllowEmptyString()][string]$Text)
    if ($null -eq $Text) { return '' }
    $t = $Text.Normalize([Text.NormalizationForm]::FormKC)
    $t = $t -replace '[　\s]+', ' '
    return $t.Trim()
}

# ---------- 仮名 ----------

# 0 → A, 25 → Z, 26 → AA（全単射の 26 進）
function ConvertTo-AlphaIndex {
    param([Parameter(Mandatory)][int]$Index)
    if ($Index -lt 0) { throw 'Index は 0 以上' }
    $s = ''; $n = $Index + 1
    while ($n -gt 0) { $n--; $s = [string][char][int](65 + ($n % 26)) + $s; $n = [int][Math]::Floor($n / 26) }
    return $s
}

function Format-Pseudonym {
    param([Parameter(Mandatory)][string]$Kind, [Parameter(Mandatory)][int]$Index)
    switch ($Kind) {
        'customer' { return '顧客' + (ConvertTo-AlphaIndex $Index) }
        'vehicle' { return '車両' + ($Index + 1).ToString('000') }
        'slip' { return '伝票' + ($Index + 1).ToString('00000') }
        default { throw "未知の仮名の種類: $Kind" }
    }
}

# 対応表（kind, source_id → pseudonym）。ファイルから読み、新しい ID には次の番号を振る。
function New-PseudonymMap {
    param([string]$Path)
    $map = @{ path = $Path; entries = @{}; next = @{}; dirty = $false }
    if ($Path -and (Test-Path -LiteralPath $Path)) {
        foreach ($r in (Import-Csv -LiteralPath $Path -Encoding UTF8)) {
            $map.entries["$($r.kind)|$($r.source_id)"] = $r.pseudonym
            $i = [int]$r.index
            if (-not $map.next.ContainsKey($r.kind) -or $map.next[$r.kind] -le $i) { $map.next[$r.kind] = $i + 1 }
        }
    }
    return $map
}

function Get-Pseudonym {
    param([Parameter(Mandatory)][hashtable]$Map, [Parameter(Mandatory)][string]$Kind, [AllowNull()]$SourceId)
    if ($null -eq $SourceId -or "$SourceId" -eq '' -or "$SourceId" -eq '0') { return '' }
    $key = "$Kind|$SourceId"
    if ($Map.entries.ContainsKey($key)) { return $Map.entries[$key] }
    $i = if ($Map.next.ContainsKey($Kind)) { $Map.next[$Kind] } else { 0 }
    $p = Format-Pseudonym -Kind $Kind -Index $i
    $Map.entries[$key] = $p
    $Map.next[$Kind] = $i + 1
    $Map.dirty = $true
    return $p
}

function Save-PseudonymMap {
    param([Parameter(Mandatory)][hashtable]$Map)
    if (-not $Map.path) { return }
    # 確かめた絶対パスに書く（相対パスのまま渡すと、検査と書き込みで基準の場所が違うことがある）
    $path = Assert-PrivatePath -Path $Map.path -OutsideRepo
    $dir = Split-Path -Parent $path
    if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $rows = foreach ($k in $Map.entries.Keys) {
        $kind, $src = $k.Split('|', 2)
        $p = $Map.entries[$k]
        $idx = switch ($kind) {
            'customer' {
                # 顧客AB → 全単射の 26 進を戻す
                $letters = $p.Substring(2); $n = 0
                foreach ($ch in $letters.ToCharArray()) { $n = $n * 26 + ([int]$ch - 64) }
                $n - 1
            }
            default { [int]($p -replace '^\D+', '') - 1 }
        }
        [pscustomobject]@{ kind = $kind; source_id = $src; pseudonym = $p; index = $idx }
    }
    $rows | Sort-Object kind, index | Export-Csv -LiteralPath $path -NoTypeInformation -Encoding UTF8
    $Map.dirty = $false
}

# ---------- 自由記述 ----------

# 個人に結び付き得る書き方。共通の文言でも、これを含むなら捨てる。
$script:SuspiciousPatterns = @(
    '\d{2,5}-\d{1,4}-\d{3,4}',        # 電話番号
    '\d{7,}',                          # 長い数字（電話・番号・ID）
    '[\w.+-]+@[\w-]+\.[\w.]+',         # メール
    '様|さん|殿|氏|ちゃん|くん|君',     # 敬称
    '〒|郵便|住所|番地|丁目|TEL|Tel|tel|電話|携帯|FAX',
    '[A-Z0-9]{2,6}-\d{5,7}',          # 車台番号の形（例: ABC1-1234567）
    '\d{2,3}\s*[ぁ-ん]\s*\d{1,2}-?\d{2}' # ナンバーの一部の形
)

function Test-SuspiciousText {
    param([AllowNull()][AllowEmptyString()][string]$Text)
    if (-not $Text) { return $false }
    foreach ($p in $script:SuspiciousPatterns) { if ($Text -match $p) { return $true } }
    return $false
}

# タイヤのサイズを品名や欄から読む。読めなければ ''。
#   155/65R14 75S → 155/65R14、145R12 6PR → 145R12、P205/75R14 → 205/75R14、7.00R16 → 7.00R16
function Get-TireSize {
    param([AllowNull()][AllowEmptyString()][string]$Text)
    $t = (ConvertTo-NormalizedText $Text).ToUpperInvariant()
    if (-not $t) { return '' }
    $t = $t -replace '／', '/'
    if ($t -match '(?<![\d.])(?:P|LT)?\s*(\d{3})\s*/\s*(\d{2})\s*Z?R\s*-?\s*(\d{2})(?!\d)') { return "$($Matches[1])/$($Matches[2])R$($Matches[3])" }
    if ($t -match '(?<![\d./])(\d{3})\s*R\s*(\d{2})(?!\d)') { return "$($Matches[1])R$($Matches[2])" }
    if ($t -match '(?<![\d.])(\d{1,2}\.\d{2})\s*-?\s*R?\s*(\d{2})(?!\d)') { return "$($Matches[1])R$($Matches[2])" }
    return ''
}

# 夏・冬の別。サイズ欄の速度記号（Q は冬）や、品名の語から読む。読めなければ ''。
function Get-TireSeason {
    param([AllowNull()][AllowEmptyString()][string]$Text)
    $t = (ConvertTo-NormalizedText $Text).ToUpperInvariant()
    if (-not $t) { return '' }
    if ($t -match 'スタッドレス|スタットレス|冬|ウインター|ウィンター|WINTER|BLIZZAK|ブリザック|VRX|W\d{3}\b|ICE|アイス|GARIT|ガリット|OBSERVE|WM0\d|SJ8|IG\d{2}|IG-?\d{2}|\d{2,3}Q\b') { return '冬' }
    if ($t -match 'ラジアル|夏|サマー|\d{2,3}[HSTVWYZ]\b|ECOPIA|エコピア|NEWNO|ニューノ|ENASAVE|エナセーブ|BLUEARTH|ブルーアース|NEXTRY|ネクストリー|SNEAKER|スニーカー') { return '夏' }
    return ''
}

# 銘柄（メーカー）。読めなければ ''。
$script:Brands = [ordered]@{
    'ブリヂストン' = 'ブリヂストン|ブリジストン|ブリヂストン|BRIDGESTONE|\bBS\b|BLIZZAK|ブリザック|ECOPIA|エコピア|NEWNO|ニューノ|NEXTRY|ネクストリー|SNEAKER|スニーカー|VRX|W\d{3}\b|REGNO|レグノ|K370|R710|DURAVIS|デュラビス|POTENZA|ポテンザ|PLAYZ|プレイズ'
    'ダンロップ'   = 'ダンロップ|DUNLOP|ENASAVE|エナセーブ|WINTER\s*MAXX|ウインターマックス|WM0\d|SJ8|DV-?0\d|LE\s*MANS|ルマン|VEURO|ビューロ'
    'ヨコハマ'     = 'ヨコハマ|YOKOHAMA|ICE\s*GUARD|アイスガード|IG\d{2}|IG-?\d{2}|BLUEARTH|ブルーアース|ADVAN|アドバン|GEOLANDAR|ジオランダー|ECOS|エコス|IceGUARD'
    'トーヨー'     = 'トーヨー|TOYO|GARIT|ガリット|OBSERVE|オブザーブ|NANOENERGY|ナノエナジー|TRANPATH|トランパス|PROXES|プロクセス'
    'ミシュラン'   = 'ミシュラン|MICHELIN|X-?ICE|PRIMACY|プライマシー|ENERGY\s*SAVER|AGILIS'
    'グッドイヤー' = 'グッドイヤー|GOOD\s*YEAR|ICE\s*NAVI|アイスナビ|EFFICIENTGRIP|GT-?ECO'
    'ファルケン'   = 'ファルケン|FALKEN|SINCERA|シンセラ|ZIEX|ジークス|ESPIA|エスピア'
    'ピレリ'       = 'ピレリ|PIRELLI'
    'コンチネンタル' = 'コンチネンタル|CONTINENTAL'
    'ナンカン'     = 'ナンカン|NANKANG'
    'ハンコック'   = 'ハンコック|HANKOOK'
    'クムホ'       = 'クムホ|KUMHO'
    'ネクセン'     = 'ネクセン|NEXEN'
    'ノキアン'     = 'ノキアン|NOKIAN|HAKKAPELIITTA'
    'セイバーリング' = 'セイバーリング|SEIBERLING'
}

function Get-TireBrand {
    param([AllowNull()][AllowEmptyString()][string]$Text)
    $t = (ConvertTo-NormalizedText $Text).ToUpperInvariant()
    if (-not $t) { return '' }
    foreach ($b in $script:Brands.Keys) { if ($t -match ('(?i)' + $script:Brands[$b])) { return $b } }
    return ''
}

# 自由記述を守る。
#   - 怪しい書き方を含む → '<除外>'
#   - 共通の文言（$Common に入っている＝十分な数の客で使われた）→ 正規化した文言
#   - それ以外で、タイヤ本体と読める → '<タイヤ 銘柄 サイズ>'（読めた部分だけ）
#   - それ以外 → '<自由記述>'
function Protect-FreeText {
    param(
        [AllowNull()][AllowEmptyString()][string]$Text,
        [System.Collections.Generic.HashSet[string]]$Common
    )
    $t = ConvertTo-NormalizedText $Text
    if (-not $t) { return '' }
    if (Test-SuspiciousText $t) { return '<除外>' }
    if ($null -ne $Common -and $Common.Contains($t)) { return $t }
    $size = Get-TireSize $t
    $brand = Get-TireBrand $t
    if ($size -or ($brand -and $t -match 'タイヤ|TIRE')) {
        $parts = @('タイヤ') + @($brand, $size | Where-Object { $_ })
        return '<' + ($parts -join ' ') + '>'
    }
    return '<自由記述>'
}

# 品番は、英数字と記号だけで、怪しい書き方を含まず、多くの客に共通する値（$Common）だけを残す。
# 品番の欄には車台番号やローマ字の名前も書けるので、形だけでは残さない。$Common が無ければ残さない。
function Protect-PartCode {
    param(
        [AllowNull()][AllowEmptyString()][string]$Value,
        [System.Collections.Generic.HashSet[string]]$Common
    )
    $t = (ConvertTo-NormalizedText $Value).ToUpperInvariant()
    if (-not $t) { return '' }
    # 0 で始まる 10 桁以上の数字は電話番号と見分けられないので捨てる（ハイフン・空白で区切ってあっても）
    if (($t -replace '[ .\-/]', '') -match '^0\d{9,}$') { return '<除外>' }
    if ($t -notmatch '^[A-Z0-9][A-Z0-9 .\-/]{0,29}$' -or $t -match '[\w.+-]+@') { return '<除外>' }
    # 国産車の純正の品番（例: 16510-81420、90915-YZZD1）は車台番号と同じ形なので、怪しい書き方の検査から外す。
    # それ以外（例: ABC1-1234567 は型式に英字を含む車台番号の形）は、共通でも捨てる。
    $isOemNumber = $t -match '^\d{5}-[A-Z0-9]{2,5}(-[A-Z0-9]{2,3})?$'
    if (-not $isOemNumber -and (Test-SuspiciousText $t)) { return '<除外>' }
    # 数字を含まない値（ローマ字の名前など）は品番とみなさない。担当者の名前のように多くの客に共通しても残さない
    if ($t -notmatch '\d') { return '<除外>' }
    if ($null -ne $Common -and $Common.Contains($t)) { return $t }
    return '<少数>'
}

# 出力の置き場を確かめる。
#   OutsideRepo: リポジトリの外だけを許す（対応表）
#   それ以外: リポジトリの外か、リポジトリの中なら git で無視される所だけを許す（明細・台帳・ログ）
# 確かめられないとき（git が無い等）は止める。
function Assert-PrivatePath {
    param([Parameter(Mandatory)][string]$Path, [switch]$OutsideRepo)
    $repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..')).TrimEnd('\')
    # 相対パスは PowerShell の今の場所から解く（.NET のカレントディレクトリとずれることがあるため）
    $full = [IO.Path]::GetFullPath($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)).TrimEnd('\')
    # パスの途中にリンク（ジャンクション・シンボリックリンク）があると、文字列では外に見えても中に書けるので止める
    $p = $full
    while ($p) {
        $item = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
        if ($null -ne $item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "リンク（ジャンクション等）を含む置き場には書きません: $p" }
        $p = Split-Path -Parent $p
    }
    $inside = $full.Equals($repoRoot, [StringComparison]::OrdinalIgnoreCase) -or $full.StartsWith($repoRoot + '\', [StringComparison]::OrdinalIgnoreCase)
    if (-not $inside) { return $full }
    if ($OutsideRepo) { throw "リポジトリの外に置きます: $full" }
    # 置き場の中に書くファイルが無視されるかを確かめる（置き場がまだ無くても確かめられるよう、中のファイルの名前で聞く）
    $probe = Join-Path $full 'nda-private-probe.csv'
    & git -C $repoRoot check-ignore -q -- $probe 2>$null
    if ($LASTEXITCODE -ne 0) { throw "リポジトリの中で git に無視されない所には書きません: $full" }
    return $full
}

# 明細の行を分ける（工賃コードと品名から）。品名を伏せる前に、この PC の中で決める。
#   tire_swap 履き替え / tire_mount 組み替え / balance バランス / valve バルブ / disposal 廃タイヤ /
#   storage 保管 / nut ナット / puncture パンク修理 / rotation ローテーション / tire タイヤ本体 /
#   wheel ホイール / other それ以外
$script:SwapCodes = @(277, 50105, 50123, 50128, 50129)
$script:MountCodes = @(278, 50121, 50122)
$script:BalanceCodes = @(279, 309, 50110)
$script:ValveCodes = @(296)
$script:TireCodes = @(50100, 50101, 50102, 50103, 82570, 88220, 520001)

function Get-TireLineCategory {
    param([AllowNull()]$KouCd, [AllowNull()][AllowEmptyString()][string]$Name)
    $k = if ($null -eq $KouCd -or "$KouCd" -eq '') { 0 } else { [int]$KouCd }
    $t = (ConvertTo-NormalizedText $Name).ToUpperInvariant()
    $isTireWord = $t -match 'タイヤ|TIRE|スタッドレス|スタットレス'
    if ($t -match 'パンク' -or $k -eq 50124) { return 'puncture' }
    if ($t -match 'ローテーション' -or $k -eq 50120) { return 'rotation' }
    if ($t -match '保管') { return 'storage' }
    if ($t -match '廃.?タイヤ|用済.*タイヤ|タイヤ.*(処分|廃棄)') { return 'disposal' }
    if ($k -in $script:MountCodes -or ($isTireWord -and $t -match '組.?[替換]')) { return 'tire_mount' }
    if ($k -in $script:SwapCodes -or ($isTireWord -and $t -match '履.?[替換]|はき.?[替換]|脱着|入替|入れ替')) { return 'tire_swap' }
    if ($k -in $script:BalanceCodes -or $t -match 'バランス') { return 'balance' }
    if ($k -in $script:ValveCodes -or $t -match '(エア|ゴム|タイヤ).?バルブ|TR4\d\d') { return 'valve' }
    if ($t -match 'ナット') { return 'nut' }
    if ((Get-TireSize $t) -or $k -in $script:TireCodes -or ($isTireWord -and (Get-TireBrand $t))) { return 'tire' }
    if ($t -match 'ホイール' -and $t -notmatch 'シリンダ|アライメント|ハブ|ハウス|モール|オイル|パルス|センサ|ステアリング') { return 'wheel' }
    return 'other'
}

# 少ない数の車にしか現れない分類の値（車種・型式）を伏せる
function Protect-RareValue {
    param(
        [AllowNull()][AllowEmptyString()][string]$Value,
        [System.Collections.Generic.HashSet[string]]$Common
    )
    $t = ConvertTo-NormalizedText $Value
    if (-not $t) { return '' }
    if (Test-SuspiciousText $t) { return '<除外>' }
    if ($null -ne $Common -and $Common.Contains($t)) { return $t }
    return '<少数>'
}

# 走行距離を 1 万 km の幅に丸める（1 台を特定しにくくする）
function ConvertTo-KmBucket {
    param([AllowNull()]$Km)
    if ($null -eq $Km -or "$Km" -eq '') { return '' }
    $k = [int64]$Km
    if ($k -le 0) { return '' }
    $lo = [Math]::Floor($k / 10000) * 10000
    return "$lo-$($lo + 9999)"
}

# ---------- 行のマスキング ----------

# spec: [ordered]@{ 出力の列名 = @{ from = '元の列名'; as = '変換' } }
# 変換: keep（そのまま。数値・日付・コード向け）、int、text（正規化だけ。マスタの名前向け）、
#       pseudonym:customer|vehicle|slip、freetext、rare:<共通集合の名前>、size、season、brand、km
# spec に無い列は出力に出ない。元の列が無ければ例外（列の取り違えを黙って通さない）。
function ConvertTo-MaskedRow {
    param(
        [Parameter(Mandatory)]$Row,
        [Parameter(Mandatory)][System.Collections.IDictionary]$Spec,
        [Parameter(Mandatory)][hashtable]$Map,
        [hashtable]$CommonSets = @{}
    )
    $props = @{}
    foreach ($p in $Row.PSObject.Properties) { $props[$p.Name] = $p.Value }
    $o = [ordered]@{}
    foreach ($outName in $Spec.Keys) {
        $s = $Spec[$outName]
        if (-not $props.ContainsKey($s.from)) { throw "元の列がありません: $($s.from)" }
        $v = $props[$s.from]
        $as = $s.as
        $o[$outName] = switch -Regex ($as) {
            '^keep$' { $v }
            '^int$' { if ($null -eq $v -or "$v" -eq '') { $null } else { [int64]$v } }
            '^text$' { $t = ConvertTo-NormalizedText "$v"; if (Test-SuspiciousText $t) { '<除外>' } else { $t } }
            '^pseudonym:(\w+)$' { Get-Pseudonym -Map $Map -Kind $Matches[1] -SourceId $v }
            '^freetext$' { Protect-FreeText -Text "$v" -Common $CommonSets['names'] }
            '^rare:(\w+)$' { Protect-RareValue -Value "$v" -Common $CommonSets[$Matches[1]] }
            '^size$' { Get-TireSize "$v" }
            '^season$' { Get-TireSeason "$v" }
            '^brand$' { Get-TireBrand "$v" }
            '^km$' { ConvertTo-KmBucket $v }
            '^code$' { Protect-PartCode -Value "$v" -Common $CommonSets['hinbans'] }
            default { throw "未知の変換: $as" }
        }
    }
    return [pscustomobject]$o
}

Export-ModuleMember -Function ConvertTo-NormalizedText, ConvertTo-AlphaIndex, Format-Pseudonym, New-PseudonymMap, Get-Pseudonym, Save-PseudonymMap, Test-SuspiciousText, Get-TireSize, Get-TireSeason, Get-TireBrand, Protect-FreeText, Protect-RareValue, Protect-PartCode, Assert-PrivatePath,Get-TireLineCategory, ConvertTo-KmBucket, ConvertTo-MaskedRow
