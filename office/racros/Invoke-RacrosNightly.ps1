# 毎晩の入口: 取り出し（マスキング）→ 集計。タスクスケジューラから呼ぶ（登録の手順は README）。
# 毎晩すべてを取り出し直して集計し直す（差分ではない）。理由は README「毎晩の更新」。
# ログは <OutDir>/logs/ に残す（件数と時間だけ。行の中身は書かない）。
param(
    [string]$OutDir = (Join-Path $PSScriptRoot '..\..\data\private\racros'),
    [string]$MapPath = 'C:\Users\PRS\nda-private\racros\pseudonyms.csv'
)
$ErrorActionPreference = 'Stop'
$logDir = Join-Path $OutDir 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir ("nightly-{0}.log" -f (Get-Date -Format 'yyyyMMdd'))
function Log { param([string]$m) ('{0} {1}' -f (Get-Date -Format 's'), $m) | Add-Content -LiteralPath $log -Encoding UTF8 }

# 二重起動を止める（前の晩の分がまだ動いている等）
$lock = Join-Path $OutDir 'nightly.lock'
if (Test-Path -LiteralPath $lock) {
    $age = (Get-Date) - (Get-Item -LiteralPath $lock).LastWriteTime
    if ($age.TotalHours -lt 6) { Log "skip: 前の実行が動いています（$lock）"; exit 0 }
    Log "前の実行の lock が古いので消します（$([int]$age.TotalHours) 時間前）"
    Remove-Item -LiteralPath $lock -Force
}
Set-Content -LiteralPath $lock -Value $PID
try {
    Log 'start'
    $e = & (Join-Path $PSScriptRoot 'Export-RacrosTireLines.ps1') -OutDir $OutDir -MapPath $MapPath
    Log "export: $e"
    $t = & (Join-Path $PSScriptRoot 'Get-RacrosTireTrends.ps1') -OutDir $OutDir
    Log "trends: $t"
    Log 'done'
} catch {
    # 例外の文言に行の中身は入らない（SQL の誤り・接続の誤りなど）
    Log "error: $($_.Exception.Message)"
    exit 1
} finally {
    Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue
}
