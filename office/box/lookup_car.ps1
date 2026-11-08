param([Parameter(Mandatory = $true)][string]$ReaderFile, [Parameter(Mandatory = $true)][int]$Kok, [Parameter(Mandatory = $true)][int]$Car)
# 読むだけ。請求の顧客番号・車両番号から、その車のナンバーと客の名前を 1 件だけ引き、JSON で出す。
# 削除した客は KOK_DEL=0 のまま KOK_KDEL=9 になることがある（#55 のセッションが確かめた）ので、引く客は KOK_KDEL=0 だけにする。
# SAME_NO は（削除した客の車も含めて、広く）、題名に出る客の名前（KOK_NAMEJ1）とナンバーの番号の両方が同じ車の数（どの客の分も合わせて）。1 でなければ、番号と題名では見分けられない。
# 名前は、空白（半角・全角）・タブ・改行をすべて除いて比べる。送る側の照合（前後の空白を除いて完全一致）より広く数え、見分けにくい客を必ず数に入れる（Codex の指摘）。
# SELECT だけを、値をパラメータで渡して実行し、読み取り専用の接続（ApplicationIntent=ReadOnly）とロールバックする取引の中で読む。
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$b = New-Object System.Data.SqlClient.SqlConnectionStringBuilder ((Get-Content -LiteralPath $ReaderFile -Raw).Trim())
$b['ApplicationIntent'] = 'ReadOnly'
$conn = New-Object System.Data.SqlClient.SqlConnection $b.ConnectionString
$conn.Open()
try {
  $tx = $conn.BeginTransaction([System.Data.IsolationLevel]::ReadCommitted)
  $cmd = $conn.CreateCommand(); $cmd.Transaction = $tx; $cmd.CommandTimeout = 30
  $cmd.CommandText = @'
SELECT c.CAR_RIKUJI, c.CAR_BANGO, c.CAR_KANA, c.CAR_NO, k.KOK_NAMEJ1, k.KOK_NAMEJ2,
  (SELECT COUNT(*) FROM RS3_DATA.dbo.CAR_DAT s JOIN RS3_DATA.dbo.KOK_DAT k2 ON k2.KOK_CODE = s.CAR_KOKCD
   WHERE s.CAR_NO = c.CAR_NO AND s.CAR_DEL = 0 AND k2.KOK_DEL = 0
     AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(k2.KOK_NAMEJ1, N' ', N''), NCHAR(12288), N''), NCHAR(9), N''), NCHAR(10), N''), NCHAR(13), N'') = REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(k.KOK_NAMEJ1, N' ', N''), NCHAR(12288), N''), NCHAR(9), N''), NCHAR(10), N''), NCHAR(13), N'')) AS SAME_NO
FROM RS3_DATA.dbo.CAR_DAT c JOIN RS3_DATA.dbo.KOK_DAT k ON k.KOK_CODE = c.CAR_KOKCD
WHERE c.CAR_CODE = @car AND c.CAR_KOKCD = @kok AND c.CAR_DEL = 0 AND k.KOK_DEL = 0 AND k.KOK_KDEL = 0
'@
  [void]$cmd.Parameters.Add('@car', [System.Data.SqlDbType]::Int); $cmd.Parameters['@car'].Value = $Car
  [void]$cmd.Parameters.Add('@kok', [System.Data.SqlDbType]::Int); $cmd.Parameters['@kok'].Value = $Kok
  $r = $cmd.ExecuteReader()
  $rows = @()
  while ($r.Read()) {
    $rows += [pscustomobject]@{
      rikuji = [string]$r[0]; bango = [string]$r[1]; kana = [string]$r[2]; no = [int]$r[3]
      name = (([string]$r[4]) + ' ' + ([string]$r[5])).Trim(); title_name = [string]$r[4]; same_no = [int]$r[6]
    }
  }
  $r.Close()
  $tx.Rollback()
  ConvertTo-Json -InputObject @($rows) -Compress
} finally { $conn.Close() }
