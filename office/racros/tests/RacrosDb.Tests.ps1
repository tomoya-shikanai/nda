# 読み取り専用のガードのテスト（DB には接続しない）
Import-Module (Join-Path $PSScriptRoot '..\RacrosDb.psm1') -Force

Describe 'Assert-ReadOnlySql: 通す文' {
    It 'SELECT を通す' { Assert-ReadOnlySql -Sql 'SELECT a FROM T' | Should Be $true }
    It '小文字・前後の空白・末尾の ; を通す' { Assert-ReadOnlySql -Sql "  select a from T ;  " | Should Be $true }
    It 'WITH（CTE）を通す' { Assert-ReadOnlySql -Sql "WITH x AS (SELECT 1 a) SELECT a FROM x" | Should Be $true }
    It '文字列の中の禁止語は気にしない' { Assert-ReadOnlySql -Sql "SELECT a FROM T WHERE nm = N'DELETE; DROP TABLE x'" | Should Be $true }
    It '2 部名・3 部名と小数は通す' { Assert-ReadOnlySql -Sql "SELECT t.a, 1.5 FROM dbo.T t JOIN RS3_DATA.dbo.U u ON u.k = t.k" | Should Be $true }
    It '日本語の 3 部名は通す' { Assert-ReadOnlySql -Sql "SELECT 明細.金額 FROM 業務.dbo.明細" | Should Be $true }
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
        "SELECT 1 COMMIT",
        "SELECT * FROM [REMOTE].[db].[dbo].[t]",
        "SELECT * FROM REMOTE.db.dbo.t",
        "SELECT * FROM REMOTE...t",
        "SELECT * FROM REMOTE . db . dbo . t",
        "SELECT * FROM 遠隔.業務.dbo.明細",
        "SELECT RS3_DATA.dbo.T.a FROM RS3_DATA.dbo.T",
        "SELECT 1 --`rWAITFOR DELAY '00:00:05'",
        "SELECT 1 --`rCOMMIT"
    )
    foreach ($s in $bad) {
        It "拒否: $($s -replace "`n",' ')" { { Assert-ReadOnlySql -Sql $s } | Should Throw }
    }
}

Describe 'Invoke-RacrosSelect: 送る前に止める' {
    It 'RS3_ 以外のデータベースは拒否' { { Invoke-RacrosSelect -Database 'master' -Sql 'SELECT 1' } | Should Throw }
    It 'WITH に続く書き換えも接続の前に拒否' { { Invoke-RacrosSelect -Database 'RS3_DATA' -Sql 'WITH x AS (SELECT 1 a) DELETE FROM x' -ConnectionFile 'C:\nonexistent\none.txt' } | Should Throw '使えない語' }
}

Describe 'Get-RacrosConnectionString: 読むだけのログインだけを使う' {
    It 'データベース名と読み取りの意図を足す（架空の値）' {
        $f = Join-Path $TestDrive 'reader.txt'
        Set-Content -LiteralPath $f -Value 'Server=.\FAKE;User ID=fake_reader;Password=fake-pass' -Encoding UTF8
        $cs = Get-RacrosConnectionString -Database 'RS3_DATA' -ConnectionFile $f
        $cs | Should Match 'Initial Catalog=RS3_DATA'
        $cs | Should Match 'ApplicationIntent=ReadOnly'
        $cs | Should Match 'User ID=fake_reader'
    }
    It 'Windows 認証の接続文字列は拒否' {
        $f = Join-Path $TestDrive 'win.txt'
        Set-Content -LiteralPath $f -Value 'Server=.\FAKE;Integrated Security=True' -Encoding UTF8
        { Get-RacrosConnectionString -Database 'RS3_DATA' -ConnectionFile $f } | Should Throw 'Windows 認証'
    }
    It 'ファイルが無ければ止まる' { { Get-RacrosConnectionString -Database 'RS3_DATA' -ConnectionFile 'C:\nonexistent\none.txt' } | Should Throw }
    It '書き換えの文は、接続文字列のファイルを読む前に拒否' { { Invoke-RacrosSelect -Database 'RS3_DATA' -Sql 'DELETE FROM T' -ConnectionFile 'C:\nonexistent\none.txt' } | Should Throw 'SELECT か WITH' }
}

Describe 'Invoke-RacrosSelect: 接続の失敗' {
    It '接続できないとき、文言にパスワードを出さない（架空の接続先）' {
        $f = Join-Path $TestDrive 'bad.txt'
        Set-Content -LiteralPath $f -Value 'Server=tcp:127.0.0.1,1;User ID=fake_reader;Password=fake-secret-pass;Connect Timeout=2' -Encoding UTF8
        $err = $null
        try { Invoke-RacrosSelect -Database 'RS3_DATA' -Sql 'SELECT 1 a' -ConnectionFile $f } catch { $err = "$($_.Exception.Message)" }
        $err | Should Match '接続できません'
        $err | Should Not Match 'fake-secret-pass'
    }
}
