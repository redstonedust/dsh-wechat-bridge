<#
.SYNOPSIS
    setup-hook.ps1 的自测：用假的探测结果 + 假 DLL 目录，验证「3.9.x 路径」能选对 DLL。

.DESCRIPTION
    本机是 Weixin 4.x（没有可用 hook DLL），所以真正的一键注入跑不到第 2 步之后。
    这个测试把探测结果和 DLL 仓库都换成 fixture，验证：
      · 3.9.x 判定 → wcferry-dll
      · 版本精确命中 / 前缀命中
      · 没有 DLL 时给出「放成什么名字」并能正确失败
      · -DryRun 不会编译/注入/改配置

    用法: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\test-setup-hook.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$root = Split-Path -Parent $PSScriptRoot
$setup = Join-Path $PSScriptRoot 'setup-hook.ps1'
$work = Join-Path ([System.IO.Path]::GetTempPath()) ("setup-hook-test-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $work -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $work 'dlls') -Force | Out-Null

$failures = 0
function Pass([string]$label) { Write-Host "  [PASS] $label" -ForegroundColor Green }
function Fail([string]$label, [string]$detail) { $script:failures++; Write-Host "  [FAIL] $label" -ForegroundColor Red; if ($detail) { Write-Host "         $detail" -ForegroundColor DarkGray } }

function New-Detect([string]$family, [string]$version, [string]$exe, [string]$strategy) {
    $payload = [ordered]@{
        ok           = $true
        found        = $true
        family       = $family
        exePath      = $exe
        installSource = 'fixture'
        version      = $version
        arch         = 'x64'
        processName  = $(if ($family -eq 'wechat3') { 'WeChat.exe' } else { 'Weixin.exe' })
        running      = $false
        pids         = @()
        windowVisible = $false
        others       = @()
        strategy     = $strategy
        reason       = 'fixture'
        alternatives = @()
    }
    $file = Join-Path $work ("detect-" + $family + "-" + $version + ".json")
    ($payload | ConvertTo-Json -Compress) | Set-Content -LiteralPath $file -Encoding UTF8
    return $file
}

function Invoke-Setup([string]$detectFile, [string]$dllDir) {
    $args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $setup, '-DetectJson', $detectFile, '-DllDirOverride', $dllDir, '-DryRun')
    $output = & powershell @args 2>&1
    return [pscustomobject]@{ Code = $LASTEXITCODE; Text = ($output -join "`n") }
}

Write-Host ''
Write-Host 'setup-hook 自测（fixture）' -ForegroundColor Magenta
Write-Host ''

# ── 1) 3.9.x + 文件名带版本 → 命中 ─────────────────────────────────────────
$dlls = Join-Path $work 'dlls'
Set-Content -LiteralPath (Join-Path $dlls 'sdk-3.9.12.17.dll') -Value 'fixture' -Encoding ASCII
$detect = New-Detect 'wechat3' '3.9.12.17' 'C:\Program Files (x86)\Tencent\WeChat\WeChat.exe' 'wcferry-dll'
$result = Invoke-Setup $detect $dlls
if ($result.Code -eq 0 -and $result.Text -match '匹配到' -and $result.Text -match 'sdk-3\.9\.12\.17\.dll') {
    Pass '3.9.12.17 + sdk-3.9.12.17.dll → 命中并 DryRun 退出'
} else {
    Fail '精确命中失败' $result.Text
}

# ── 2) 同前缀版本 → 前缀命中 ───────────────────────────────────────────────
$detect2 = New-Detect 'wechat3' '3.9.12.99' 'C:\Program Files (x86)\Tencent\WeChat\WeChat.exe' 'wcferry-dll'
$result2 = Invoke-Setup $detect2 $dlls
if ($result2.Code -eq 0 -and $result2.Text -match 'filename:|catalog') {
    Pass '3.9.12.99 → 用同前缀的 3.9.12.17 兜底'
} else {
    Fail '前缀命中失败' $result2.Text
}

# ── 3) 没有匹配的 DLL → 非 0 且给出该放什么 ────────────────────────────────
$empty = Join-Path $work 'empty'
New-Item -ItemType Directory -Path $empty -Force | Out-Null
$detect3 = New-Detect 'wechat3' '3.9.9.9' 'C:\Program Files (x86)\Tencent\WeChat\WeChat.exe' 'wcferry-dll'
$result3 = Invoke-Setup $detect3 $empty
if ($result3.Code -ne 0 -and $result3.Text -match 'sdk-3\.9\.9\.9\.dll') {
    Pass '缺 DLL → 失败并指出该放成 sdk-3.9.9.9.dll'
} else {
    Fail '缺 DLL 的失败路径不对' ("exit=" + $result3.Code + "`n" + $result3.Text)
}

# ── 4) 4.x → 直接拒绝（不会走到注入） ──────────────────────────────────────
$detect4 = New-Detect 'weixin4' '4.2.0.9' 'C:\Program Files\Tencent\Weixin\Weixin.exe' 'unsupported'
$result4 = Invoke-Setup $detect4 $dlls
if ($result4.Code -eq 2 -and $result4.Text -match '走不了注入路线') {
    Pass '4.x → 拒绝注入并给替代路线（exit 2）'
} else {
    Fail '4.x 判定不对' ("exit=" + $result4.Code + "`n" + $result4.Text)
}

# ── 5) DryRun 一定不改配置 ─────────────────────────────────────────────────
$patch = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\cordis.patch.yml'
$before = if (Test-Path $patch) { (Get-Item $patch).LastWriteTimeUtc } else { $null }
$null = Invoke-Setup $detect $dlls
$after = if (Test-Path $patch) { (Get-Item $patch).LastWriteTimeUtc } else { $null }
if ($before -eq $after) {
    Pass 'DryRun 没有动 profile 的 cordis.patch.yml'
} else {
    Fail 'DryRun 改了配置' "$before → $after"
}

Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
if ($failures -eq 0) {
    Write-Host '全部通过' -ForegroundColor Green
    exit 0
}
Write-Host ("$failures 项失败") -ForegroundColor Red
exit 1
