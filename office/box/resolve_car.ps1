param([Parameter(Mandatory = $true)][string]$ReaderFile, [Parameter(Mandatory = $true)][int]$No)
# 読むだけ。ナンバーの番号（CAR_NO）が同じ、削除されていない車と、その客の照らす欄を JSON の list で出す（resolve.py が照らす）。
# 削除: 車は CAR_DEL<>0、客は KOK_DEL<>0 か KOK_KDEL<>0（削除した客は KOK_KDEL=9 で KOK_DELYMD が入る。2026-11-08 に件数で確かめた）。
# SELECT だけを、値をパラメータで渡して実行し、読み取り専用の接続（ApplicationIntent=ReadOnly）とロールバックする取引の中で読む。
# この ps1 は PowerShell 5.1 が ANSI で読むので、日本語の文字を直に書かない（要るときは NCHAR(n)）。
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
if ($No -lt 1 -or $No -gt 9999) { throw 'No must be 1..9999' }
$b = New-Object System.Data.SqlClient.SqlConnectionStringBuilder ((Get-Content -LiteralPath $ReaderFile -Raw).Trim())
$b['ApplicationIntent'] = 'ReadOnly'
$conn = New-Object System.Data.SqlClient.SqlConnection $b.ConnectionString
$conn.Open()
try {
  $tx = $conn.BeginTransaction([System.Data.IsolationLevel]::ReadCommitted)
  $cmd = $conn.CreateCommand(); $cmd.Transaction = $tx; $cmd.CommandTimeout = 30
  $cmd.CommandText = @'
SELECT c.CAR_CODE, c.CAR_KOKCD, c.CAR_DEL, k.KOK_DEL, k.KOK_KDEL, c.CAR_NO,
  c.CAR_RIKUJI, c.CAR_BANGO, c.CAR_KANA, c.CAR_SYASYU,
  k.KOK_NAMEK, k.KOK_RYAKU, k.KOK_NAMEJ1, k.KOK_NAMEJ2,
  c.CAR_SYO_NM1, c.CAR_SYO_NM2, c.CAR_SYO_KANA, c.CAR_SI_NM1, c.CAR_SI_NM2, c.CAR_SI_KANA
FROM RS3_DATA.dbo.CAR_DAT c JOIN RS3_DATA.dbo.KOK_DAT k ON k.KOK_CODE = c.CAR_KOKCD
WHERE c.CAR_NO = @no AND c.CAR_DEL = 0 AND k.KOK_DEL = 0 AND k.KOK_KDEL = 0
ORDER BY c.CAR_CODE
'@
  [void]$cmd.Parameters.Add('@no', [System.Data.SqlDbType]::Int); $cmd.Parameters['@no'].Value = $No
  $r = $cmd.ExecuteReader()
  $rows = New-Object System.Collections.ArrayList
  while ($r.Read()) {
    $o = [ordered]@{}
    for ($i = 0; $i -lt $r.FieldCount; $i++) {
      $v = $r.GetValue($i)
      if ($v -is [DBNull]) { $v = $null } elseif ($v -isnot [int]) { $v = [string]$v }
      $o[$r.GetName($i).ToLowerInvariant()] = $v
    }
    [void]$rows.Add([pscustomobject]$o)
  }
  $r.Close()
  $tx.Rollback()
  [Console]::Out.Write((ConvertTo-Json -InputObject @($rows) -Compress -Depth 3))
} finally { $conn.Close() }
