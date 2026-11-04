# RacroS III の SQL Server を「読むだけ」で使うための接続ヘルパー。
# すべてのクエリはここを通す。SELECT／WITH で始まる 1 文だけを通し、
# 書き換え・実行・権限・バックアップ系の語を含む文は送る前に拒否する。
# さらに、接続は READ UNCOMMITTED のトランザクションの中で読み、最後に必ず ROLLBACK する
# （RacroS の利用を止めるロックを取らない。万一ガードをすり抜けても確定させない）。

Set-StrictMode -Version Latest

# 読むだけのログイン（db_datareader だけ）の接続文字列。リポジトリの外に置き、実行のたびに読む。
# 中身（パスワード）は出力・ログ・例外の文言に出さない。
$script:DefaultConnectionFile = 'C:\Users\PRS\nda-private\sql-reader.txt'

# 接続文字列のファイルを読み、データベース名などを足して返す。Windows 認証の接続は受け付けない。
function Get-RacrosConnectionString {
    param([Parameter(Mandatory)][string]$Database, [string]$ConnectionFile = $script:DefaultConnectionFile)
    if (-not (Test-Path -LiteralPath $ConnectionFile)) { throw "接続文字列のファイルがありません: $ConnectionFile" }
    $raw = (Get-Content -LiteralPath $ConnectionFile -Raw -Encoding UTF8).Trim()
    try { $b = New-Object System.Data.SqlClient.SqlConnectionStringBuilder $raw }
    catch { throw "接続文字列のファイルを読めません（中身は表示しません）: $ConnectionFile" }
    # PowerShell は接続文字列のビルダーを辞書として扱うので、キー名（空白入り）で読み書きする
    if ($b.ContainsKey('Integrated Security') -and "$($b['Integrated Security'])" -match '^(?i)(true|yes|sspi)$') { throw 'Windows 認証の接続は使いません（読むだけのログインを使う）' }
    if (-not $b.ContainsKey('User ID') -or -not "$($b['User ID'])") { throw '接続文字列に User ID がありません' }
    $b['Initial Catalog'] = $Database
    $b['Application Name'] = 'nda-racros-readonly'
    $b['ApplicationIntent'] = 'ReadOnly'
    return $b.ConnectionString
}

# 文字列リテラル・コメント・[角括弧の識別子] を空白に置き換えた「骨格」を返す。
# ガードは骨格に対して判定する（'DELETE' という文字列や列名 [UPDATE_DT] で誤判定しないため）。
function Get-SqlSkeleton {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Sql)
    $sb = New-Object System.Text.StringBuilder
    $i = 0; $n = $Sql.Length
    while ($i -lt $n) {
        $c = $Sql[$i]
        $next = if ($i + 1 -lt $n) { $Sql[$i + 1] } else { [char]0 }
        if ($c -eq '-' -and $next -eq '-') {
            while ($i -lt $n -and $Sql[$i] -ne "`n") { $i++ }
            [void]$sb.Append(' '); continue
        }
        if ($c -eq '/' -and $next -eq '*') {
            $depth = 1; $i += 2
            while ($i -lt $n -and $depth -gt 0) {
                if ($Sql[$i] -eq '/' -and $i + 1 -lt $n -and $Sql[$i + 1] -eq '*') { $depth++; $i += 2; continue }
                if ($Sql[$i] -eq '*' -and $i + 1 -lt $n -and $Sql[$i + 1] -eq '/') { $depth--; $i += 2; continue }
                $i++
            }
            if ($depth -gt 0) { throw "閉じていないコメントがあります" }
            [void]$sb.Append(' '); continue
        }
        if ($c -eq "'") {
            $i++
            while ($true) {
                if ($i -ge $n) { throw "閉じていない文字列があります" }
                if ($Sql[$i] -eq "'") {
                    if ($i + 1 -lt $n -and $Sql[$i + 1] -eq "'") { $i += 2; continue }
                    $i++; break
                }
                $i++
            }
            [void]$sb.Append(" '' "); continue
        }
        if ($c -eq '[') {
            $i++
            while ($true) {
                if ($i -ge $n) { throw "閉じていない [ ] があります" }
                if ($Sql[$i] -eq ']') {
                    if ($i + 1 -lt $n -and $Sql[$i + 1] -eq ']') { $i += 2; continue }
                    $i++; break
                }
                $i++
            }
            [void]$sb.Append(' X '); continue
        }
        if ($c -eq '"') { throw '二重引用符の識別子は使わないでください（[ ] を使う）' }
        [void]$sb.Append($c); $i++
    }
    return $sb.ToString()
}

# 書き換え・実行・権限・外部アクセス・設定変更に使う語。骨格の中に語として現れたら拒否する。
$script:ForbiddenWords = @(
    'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE', 'DROP', 'CREATE', 'ALTER', 'RENAME',
    'EXEC', 'EXECUTE', 'SP_EXECUTESQL', 'BACKUP', 'RESTORE', 'ATTACH', 'DETACH',
    'GRANT', 'REVOKE', 'DENY', 'INTO', 'OPENROWSET', 'OPENQUERY', 'OPENDATASOURCE', 'OPENXML',
    'BULK', 'DBCC', 'SHUTDOWN', 'KILL', 'RECONFIGURE', 'USE', 'SET', 'DECLARE', 'BEGIN', 'COMMIT',
    'ROLLBACK', 'SAVE', 'TRAN', 'TRANSACTION', 'WAITFOR', 'GO', 'CHECKPOINT', 'RAISERROR', 'THROW',
    'WRITETEXT', 'UPDATETEXT', 'READTEXT', 'LOAD', 'DUMP', 'ENABLE', 'DISABLE', 'OUTPUT', 'NEXT'
)

# 1 文の SELECT／WITH だけを通す。違反なら例外を投げる。
function Assert-ReadOnlySql {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Sql)
    $sk = Get-SqlSkeleton -Sql $Sql
    $trimmed = $sk.Trim()
    if ($trimmed.EndsWith(';')) { $trimmed = $trimmed.Substring(0, $trimmed.Length - 1).TrimEnd() }
    if ($trimmed.Length -eq 0) { throw '空の SQL です' }
    if ($trimmed.Contains(';')) { throw '複数の文は使えません（; を含む）' }
    if ($trimmed -notmatch '^(?i)(SELECT|WITH)\b') { throw 'SELECT か WITH で始まる文だけを使えます' }
    foreach ($w in $script:ForbiddenWords) {
        if ($trimmed -match "(?i)(?<![A-Za-z0-9_@#$])$w(?![A-Za-z0-9_@#$])") {
            throw "使えない語が含まれています: $w"
        }
    }
    # システムの拡張プロシージャ（xp_／sp_）を名前で呼ぶことも拒否する
    if ($trimmed -match '(?i)(?<![A-Za-z0-9_])(xp_|sp_)[A-Za-z0-9_]+\s*\(') { throw 'xp_／sp_ の呼び出しは使えません' }
    return $true
}

# 読み取り専用のクエリを流して、行を PSCustomObject の配列で返す。
# -Parameters は @{ name = value } の形（SQL 側は @name）。
function Invoke-RacrosSelect {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Database,
        [Parameter(Mandatory)][string]$Sql,
        [hashtable]$Parameters = @{},
        [string]$ConnectionFile = $script:DefaultConnectionFile,
        [int]$TimeoutSec = 300
    )
    if ($Database -notmatch '^RS3_[A-Z0-9_]+$') { throw "対象は RS3_ で始まるデータベースだけです: $Database" }
    [void](Assert-ReadOnlySql -Sql $Sql)

    $conn = New-Object System.Data.SqlClient.SqlConnection (Get-RacrosConnectionString -Database $Database -ConnectionFile $ConnectionFile)
    try { $conn.Open() }
    catch {
        # SqlClient の例外の文言にパスワードは入らないが、念のため接続文字列は出さず、原因の文だけを返す
        $conn.Dispose()
        throw "SQL Server に接続できません: $($_.Exception.InnerException.Message -replace '(?i)password=[^;]*', 'Password=***')$($_.Exception.Message -replace '(?i)password=[^;]*', 'Password=***')"
    }
    try {
        $tx = $conn.BeginTransaction([System.Data.IsolationLevel]::ReadUncommitted)
        try {
            $cmd = $conn.CreateCommand()
            $cmd.Transaction = $tx
            $cmd.CommandText = $Sql
            $cmd.CommandTimeout = $TimeoutSec
            foreach ($k in $Parameters.Keys) {
                $v = $Parameters[$k]; if ($null -eq $v) { $v = [DBNull]::Value }
                [void]$cmd.Parameters.AddWithValue("@$k", $v)
            }
            $reader = $cmd.ExecuteReader()
            $rows = New-Object System.Collections.Generic.List[object]
            try {
                $names = @(for ($j = 0; $j -lt $reader.FieldCount; $j++) { $reader.GetName($j) })
                while ($reader.Read()) {
                    $o = [ordered]@{}
                    for ($j = 0; $j -lt $names.Count; $j++) {
                        $o[$names[$j]] = if ($reader.IsDBNull($j)) { $null } else { $reader.GetValue($j) }
                    }
                    $rows.Add([pscustomobject]$o)
                }
            } finally { $reader.Close() }
            return , $rows.ToArray()
        } finally {
            # 読むだけなので、確定させずに必ず巻き戻す
            try { $tx.Rollback() } catch { }
        }
    } finally {
        $conn.Close()
    }
}

Export-ModuleMember -Function Get-SqlSkeleton, Assert-ReadOnlySql, Get-RacrosConnectionString, Invoke-RacrosSelect
