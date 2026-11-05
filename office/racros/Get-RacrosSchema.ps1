# RacroS III の DB の構造（テーブル名・列名・型・件数）だけを書き出す。行の中身は読まない。
# 出力: <OutDir>/schema/<DB>.columns.tsv と <DB>.tables.tsv
param(
    [string[]]$Databases = @('RS3_DATA', 'RS3_SYARE', 'RS3_SISU', 'RS3_KATA', 'RS3_JJ', 'RS3_WORK'),
    [string]$OutDir = (Join-Path $PSScriptRoot '..\..\data\private\racros')
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'RacrosDb.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'RacrosMask.psm1') -Force
$OutDir = Assert-PrivatePath -Path $OutDir -Children (@('schema') + @($Databases | ForEach-Object { "schema\$_.tables.tsv"; "schema\$_.columns.tsv" }))

$dir = Join-Path $OutDir 'schema'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

foreach ($db in $Databases) {
    $tables = Invoke-RacrosSelect -Database $db -Sql @"
SELECT t.name AS table_name,
  (SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id = t.object_id AND p.index_id IN (0, 1)) AS row_count,
  (SELECT COUNT(*) FROM sys.columns c WHERE c.object_id = t.object_id) AS column_count
FROM sys.tables t
"@
    $tables | Sort-Object table_name | Export-Csv -Path (Join-Path $dir "$db.tables.tsv") -Delimiter "`t" -NoTypeInformation -Encoding UTF8

    $cols = Invoke-RacrosSelect -Database $db -Sql @"
SELECT t.name AS table_name, c.column_id, c.name AS column_name, ty.name AS type_name, c.max_length, c.is_nullable
FROM sys.tables t
JOIN sys.columns c ON c.object_id = t.object_id
JOIN sys.types ty ON ty.user_type_id = c.user_type_id
"@
    $cols | Sort-Object table_name, column_id | Export-Csv -Path (Join-Path $dir "$db.columns.tsv") -Delimiter "`t" -NoTypeInformation -Encoding UTF8
    Write-Output ("{0}: tables={1} columns={2}" -f $db, @($tables).Count, @($cols).Count)
}
