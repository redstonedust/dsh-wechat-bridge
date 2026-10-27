<#
.SYNOPSIS
    一键体检：离线自检 + preset 一致性 + 线上状态。

.DESCRIPTION
    依次执行：
      1. node --check index.js               语法
      2. node scripts/selftest.mjs           假 ctx 真跑（工具 schema + 回复链路）
      3. node scripts/build-preset.mjs --check  人格 md 与 preset patch 是否一致
      4. GET <origin>/wechat/webhook/status  插件是否在线、配置是否生效
    任一步失败退出码非 0。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\check.ps1
#>
[CmdletBinding()]
param(
    [string]$Origin,
    [switch]$SkipOnline
)

. (Join-Path $PSScriptRoot '_common.ps1')

$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
$failed = 0

try {
    Write-Host ''
    Write-Host 'wechat-bridge 体检' -ForegroundColor Magenta
    Write-Host ''

    Write-Step '1/6 语法'
    node --check index.js
    if ($LASTEXITCODE -ne 0) { Write-Fail 'index.js 语法错误'; $failed++ } else { Write-Ok 'index.js 语法通过' }

    Write-Step '2/6 离线自检'
    node scripts/selftest.mjs | Select-Object -Last 3
    if ($LASTEXITCODE -ne 0) { Write-Fail 'selftest 未通过'; $failed++ } else { Write-Ok 'selftest 通过' }

    Write-Step '3/6 hook 网关与全链路'
    node scripts/test-hook-gateway.mjs | Select-Object -Last 2
    if ($LASTEXITCODE -ne 0) { Write-Fail 'hook-gateway 契约测试未通过'; $failed++ } else { Write-Ok 'hook-gateway 契约测试通过' }
    node scripts/test-hook-integration.mjs | Select-Object -Last 2
    if ($LASTEXITCODE -ne 0) { Write-Fail 'hook 全链路集成测试未通过'; $failed++ } else { Write-Ok 'hook 全链路集成测试通过' }

    Write-Step '4/6 native 注入器（有编译产物才跑）'
    $injector = Join-Path $root 'native\build\wechat-inject.exe'
    if (Test-Path $injector) {
        powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'native\test-inject.ps1') | Select-Object -Last 3
        if ($LASTEXITCODE -ne 0) { Write-Fail 'native 注入自测未通过'; $failed++ } else { Write-Ok 'native 注入自测通过' }
    } else {
        Write-Warn '没有 native/build/wechat-inject.exe（先跑 native/build.ps1）；跳过'
    }

    Write-Step '5/6 preset 一致性'
    node scripts/build-preset.mjs --check
    if ($LASTEXITCODE -ne 0) { Write-Fail 'preset patch 与人格 md 不一致（跑 node scripts/build-preset.mjs）'; $failed++ }
    else { Write-Ok 'preset patch 与人格 md 一致' }

    if (-not $SkipOnline) {
        Write-Step '6/6 线上状态'
        $originValue = Get-DshOrigin -Origin $Origin
        $status = Get-BridgeStatus -Origin $originValue
        if ($null -eq $status) {
            Write-Warn "连不上 $originValue（DSH 没开？插件没启用？）"
            $failed++
        } else {
            Write-Ok "在线：kind=$($status.kind) autoReply=$($status.autoReply) chats=$(@($status.chats).Count)"
            Write-Host ("     counters = " + ($status.counters | ConvertTo-Json -Compress)) -ForegroundColor Gray
            if ($status.gateway) {
                Write-Host ("     gateway  = " + ($status.gateway | ConvertTo-Json -Compress)) -ForegroundColor Gray
            }
            if ($status.lastError) { Write-Warn "lastError = $($status.lastError)" }
            if ($status.counters.errors -gt 0) { Write-Warn "已有 $($status.counters.errors) 次错误（不一定是问题，占位凭据也会计数）" }
        }
    } else {
        Write-Step '6/6 线上状态（已跳过）'
    }
} finally {
    Pop-Location
}

Write-Host ''
if ($failed -eq 0) { Write-Ok '全部通过'; exit 0 }
Write-Fail "$failed 项未通过"
exit 1
