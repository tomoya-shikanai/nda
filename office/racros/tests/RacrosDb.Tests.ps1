# 読み取り専用のガードのテスト（DB には接続しない）
Import-Module (Join-Path $PSScriptRoot '..\RacrosDb.psm1') -Force

Describe 'Assert-ReadOnlySql: 通す文' {
    It 'SELECT を通す' { Assert-ReadOnlySql -Sql 'SELECT a FROM T' | Should Be $true }
    It '小文字・前後の空白・末尾の ; を通す' { Assert-ReadOnlySql -Sql "  select a from T ;  " | Should Be $true }
    It 'WITH（CTE）を通す' { Assert-ReadOnlySql -Sql "WITH x AS (SELECT 1 a) SELECT a FROM x" | Should Be $true }
    It '文字列の中の禁止語は気にしない' { Assert-ReadOnlySql -Sql "SELECT a FROM T WHERE nm = N'DELETE; DROP TABLE x'" | Should Be $true }
    It '[ ] の中の禁止語は気にしない' { Assert-ReadOnlySql -Sql "SELECT [UPDATE], [SET] FROM T" | Should Be $true }
    It '禁止語を含む列名（UPDSTAMP・INSYMD）は通す' { Assert-ReadOnlySql -Sql "SELECT X_UPDSTAMP, X_INSYMD, X_DEL FROM T" | Should Be $true }
    It "文字列の '' のエスケープを扱える" { Assert-ReadOnlySql -Sql "SELECT 'it''s' a" | Should Be $true }
}

Describe 'Assert-ReadOnlySql: 拒否する文' {
    $bad = @(
        "INSERT INTO T VALUES (1)",
        "UPDATE T SET a = 1",
        "DELETE FROM T",
        "MERGE T USING S ON 1=1 WHEN MATCHED THEN DELETE;",
        "TRUNCATE TABLE T",
        "DROP TABLE T",
        "CREATE TABLE T (a int)",
        "ALTER TABLE T ADD b int",
        "EXEC sp_who",
        "EXECUTE('SELECT 1')",
        "BACKUP DATABASE X TO DISK='c:\x.bak'",
        "RESTORE DATABASE X FROM DISK='c:\x.bak'",
        "SELECT * INTO NewT FROM T",
        "SELECT 1; DELETE FROM T",
        "SELECT 1 /* x */ ; UPDATE T SET a=1",
        "WITH x AS (SELECT 1 a) DELETE FROM x",
        "WITH x AS (SELECT 1 a) UPDATE x SET a = 2",
        "SELECT * FROM OPENROWSET('SQLNCLI','x','SELECT 1')",
        "SELECT * FROM OPENQUERY(L, 'SELECT 1')",
        "WAITFOR DELAY '00:00:10'",
        "SELECT 1 WAITFOR DELAY '00:00:10'",
        "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE",
        "DECLARE @a int",
        "SELECT 1`nGO`nDELETE FROM T",
        "DBCC CHECKDB",
        "SELECT master.dbo.xp_cmdshell('dir')",
        "SELECT a FROM T WITH (TABLOCKX, HOLDLOCK) OUTPUT inserted.a",
        "",
        "   ",
        "-- SELECT 1",
        "SELECT 'unterminated",
        "SELECT a FROM [T",
        "SELECT `"a`" FROM T",
        "/* SELECT */ DELETE FROM T",
        "BEGIN TRAN SELECT 1",
        "SELECT 1 COMMIT"
    )
    foreach ($s in $bad) {
        It "拒否: $($s -replace "`n",' ')" { { Assert-ReadOnlySql -Sql $s } | Should Throw }
    }
}

Describe 'Invoke-RacrosSelect: 送る前に止める' {
    It 'RS3_ 以外のデータベースは拒否' { { Invoke-RacrosSelect -Database 'master' -Sql 'SELECT 1' } | Should Throw }
    It '書き換えの文は接続の前に拒否' { { Invoke-RacrosSelect -Database 'RS3_DATA' -Sql 'DELETE FROM T' -Instance 'nonexistent\none' } | Should Throw 'SELECT か WITH' }
    It 'WITH に続く書き換えも接続の前に拒否' { { Invoke-RacrosSelect -Database 'RS3_DATA' -Sql 'WITH x AS (SELECT 1 a) DELETE FROM x' -Instance 'nonexistent\none' } | Should Throw '使えない語' }
}
