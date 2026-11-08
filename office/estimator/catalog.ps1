param([Parameter(Mandatory = $true)][string]$ReaderFile, [Parameter(Mandatory = $true)][string]$SqlFile,
      [Parameter(Mandatory = $true)][int]$Since)
# 読むだけ。catalog.sql（UTF-8 で読む）を、読み取り専用の接続とロールバックする取引の中で実行し、結果の表を JSON で出す。
# SQL は SELECT だけ（書き込みの言葉があれば実行しない）。客の情報を返す SELECT は catalog.sql に書かない。
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$sql = [IO.File]::ReadAllText($SqlFile, [Text.Encoding]::UTF8)
$check = ($sql -replace "'[^']*'", '') -replace '--.*', ''
if ($check -match '(?i)\b(insert|update|delete|exec|execute|drop|alter|create|truncate|merge|grant|revoke|into|sp_|xp_)\b') { throw 'SELECT でない言葉がある' }
$b = New-Object System.Data.SqlClient.SqlConnectionStringBuilder ((Get-Content -LiteralPath $ReaderFile -Raw).Trim())
$b['ApplicationIntent'] = 'ReadOnly'
$b['Initial Catalog'] = 'RS3_DATA'
$conn = New-Object System.Data.SqlClient.SqlConnection $b.ConnectionString
$conn.Open()
try {
  $tx = $conn.BeginTransaction([System.Data.IsolationLevel]::ReadCommitted)
  $cmd = $conn.CreateCommand(); $cmd.Transaction = $tx; $cmd.CommandTimeout = 300
  $cmd.CommandText = $sql
  [void]$cmd.Parameters.Add('@since', [System.Data.SqlDbType]::Int); $cmd.Parameters['@since'].Value = $Since
  $da = New-Object System.Data.SqlClient.SqlDataAdapter $cmd
  $ds = New-Object System.Data.DataSet
  [void]$da.Fill($ds)
  $tx.Rollback()
  $out = @()
  foreach ($t in $ds.Tables) {
    $rows = @()
    foreach ($r in $t.Rows) {
      $o = [ordered]@{}
      foreach ($c in $t.Columns) { $v = $r[$c.ColumnName]; $o[$c.ColumnName] = $(if ($v -is [DBNull]) { $null } else { $v }) }
      $rows += [pscustomobject]$o
    }
    $out += , @($rows)
  }
  ConvertTo-Json -InputObject $out -Depth 4 -Compress
} finally { $conn.Close() }
