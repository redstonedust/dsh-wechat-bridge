<#
.SYNOPSIS
    一键接入：探测微信 → 挑版本匹配的 hook DLL → 注入 → 起网关 → 写插件配置 → 自检。

.DESCRIPTION
    这是「部署完插件后一键注入用起来」的入口。它不猜、不硬怼：

      1. 探测本机微信家族/版本/架构（native/detect-wechat.mjs）
         - WeChat 3.9.x  → 走注入（有公开 hook DLL 的生态）
         - Weixin 4.x    → 直接告诉你「没有可用 hook」，并给出替代路线后退出（不会瞎注）
      2. 按版本解析 DLL（native/resolve-hook-dll.mjs，目录 native/hook-dlls/）
         没解析到就告你该把文件放成什么名字
      3. 没编译过注入器就先编译（native/build.ps1）
      4. 注入（native/wechat-inject.exe --process <exe> --dll <dll> --json）
      5. 起本仓库的 hook 网关（--driver wcf，指向你的 wcferry HTTP 服务）
      6. 把插件切到 kind=hook + 这个网关地址（写 profile 的受管区块）
      7. 自检：/health、插件 status、拉一次

.PARAMETER HookServiceUrl
    wcferry 那类 hook 服务的 HTTP 地址（注入的 DLL 本身不提供 HTTP，需要那层服务）。

.PARAMETER GatewayPort
    本仓库网关监听端口（插件连这个）。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-hook.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-hook.ps1 -HookServiceUrl http://127.0.0.1:9999 -GatewayPort 8788
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-hook.ps1 -DryRun
#>
[CmdletBinding()]
param(
    [string]$Origin,
    [string]$HookServiceUrl = 'http://127.0.0.1:9999',
    [int]$GatewayPort = 8788,
    [string]$Secret = 'hook-secret',
    [string]$ProcessName = '',
    [string]$DllPath = '',
    # 测试/特殊安装用：直接给一份探测结果 JSON（省掉真探测），或换 DLL 仓库目录
    [string]$DetectJson = '',
    [string]$DllDirOverride = '',
    [switch]$SkipInject,
    [switch]$DryRun
)

. (Join-Path $PSScriptRoot '_common.ps1')

$root = Split-Path -Parent $PSScriptRoot
$origin = Get-DshOrigin -Origin $Origin
$detectScript = Join-Path $root 'native\detect-wechat.mjs'
$resolveScript = Join-Path $root 'native\resolve-hook-dll.mjs'
$injector = Join-Path $root 'native\build\wechat-inject.exe'
$gateway = Join-Path $root 'gateway\hook-gateway.mjs'
$dllDir = if ([string]::IsNullOrEmpty($DllDirOverride)) { Join-Path $root 'native\hook-dlls' } else { $DllDirOverride }

function Get-Json([string[]]$Command) {
    $text = & $Command[0] $Command[1..($Command.Count - 1)] 2>$null
    $line = ($text | Where-Object { $_.Trim() -ne '' } | Select-Object -Last 1)
    if (-not $line) { return $null }
    try { return ($line | ConvertFrom-Json) } catch { return $null }
}

Write-Host ''
Write-Host '微信一键接入' -ForegroundColor Magenta
Write-Host ''

# ── 1) 探测 ────────────────────────────────────────────────────────────────
Write-Step '1/7 探测微信客户端'
if ([string]::IsNullOrEmpty($DetectJson)) {
    $detect = Get-Json @('node', $detectScript, '--json')
} else {
    if (-not (Test-Path -LiteralPath $DetectJson)) { Write-Fail "DetectJson 不存在：$DetectJson"; exit 1 }
    try { $detect = (Get-Content -LiteralPath $DetectJson -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { $detect = $null }
}
if (-not $detect) { Write-Fail '探测失败（node native/detect-wechat.mjs 报错？）'; exit 1 }
Write-Host ("    家族 {0} · 版本 {1} · 架构 {2}" -f $detect.family, $detect.version, $detect.arch) -ForegroundColor Gray
Write-Host ("    路径 {0}" -f $detect.exePath) -ForegroundColor DarkGray

if ($detect.strategy -ne 'wcferry-dll') {
    Write-Host ''
    Write-Host "  ✗ 这台机器走不了注入路线（$($detect.strategy)）" -ForegroundColor Yellow
    Write-Host "    $($detect.reason)" -ForegroundColor Gray
    if ($detect.alternatives) {
        Write-Host ''
        Write-Host '  可行路线：' -ForegroundColor Cyan
        foreach ($item in $detect.alternatives) { Write-Host "    · $item" -ForegroundColor Gray }
    }
    Write-Host ''
    Write-Host '  提示：装一个微信 3.9.x（可与 4.x 共存，装到别的目录）后重跑本脚本即可一键注入。' -ForegroundColor DarkGray
    exit 2
}
Write-Ok "可注入：$($detect.family) $($detect.version)"

if ([string]::IsNullOrEmpty($ProcessName)) { $ProcessName = $detect.processName }

# ── 2) 解析 DLL ────────────────────────────────────────────────────────────
Write-Step '2/7 找与版本匹配的 hook DLL'
if ([string]::IsNullOrEmpty($DllPath)) {
    $resolved = Get-Json @('node', $resolveScript, '--version', "$($detect.version)", '--dir', $dllDir, '--json')
    if (-not $resolved -or -not $resolved.ok) {
        Write-Fail "没有与 $($detect.version) 匹配的 DLL"
        if ($resolved.expected) { Write-Host "    把文件放成：$($resolved.expected)" -ForegroundColor Yellow }
        if ($resolved.message) { Write-Host "    $($resolved.message)" -ForegroundColor Gray }
        Write-Host '    也支持 hook-catalog.json 登记（可带 sha256 校验），见 native/hook-dlls/README.md' -ForegroundColor DarkGray
        exit 3
    }
    $DllPath = $resolved.dllPath
    Write-Ok "匹配到 $($resolved.matchedBy)"
} else {
    if (-not (Test-Path -LiteralPath $DllPath)) { Write-Fail "指定的 DLL 不存在：$DllPath"; exit 3 }
    Write-Ok "使用指定的 DLL：$DllPath"
}
Write-Host ("    {0}" -f $DllPath) -ForegroundColor DarkGray

if ($DryRun) {
    Write-Host ''
    Write-Warn 'DryRun：到此为止，没有编译/注入/改配置。'
    exit 0
}

# ── 3) 注入器 ──────────────────────────────────────────────────────────────
Write-Step '3/7 检查注入器'
if (-not (Test-Path -LiteralPath $injector)) {
    Write-Warn '没编译过，先跑 native/build.ps1'
    powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'native\build.ps1')
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $injector)) { Write-Fail '注入器编译失败'; exit 4 }
}
Write-Ok "注入器就绪：$injector"

# ── 4) 注入 ────────────────────────────────────────────────────────────────
if (-not $SkipInject) {
    Write-Step "4/7 注入 $ProcessName"
    $injectOut = & $injector --process $ProcessName --dll $DllPath --json --timeout 15000 2>$null
    $inject = $null
    try { $inject = (($injectOut | Where-Object { $_.Trim() -ne '' } | Select-Object -Last 1) | ConvertFrom-Json) } catch { }
    if (-not $inject -or -not $inject.ok) {
        Write-Fail "注入失败：$($inject.code) $($inject.message)"
        if ($inject.code -eq 'process-not-found') { Write-Host '    先登录微信（窗口起来）再跑本脚本，或加 -SkipInject 只做配置。' -ForegroundColor Yellow }
        exit 5
    }
    Write-Ok "已注入 pid $($inject.pid)（$($inject.process) / $($inject.target)）"
} else {
    Write-Step '4/7 跳过注入（-SkipInject）'
}

# ── 5) 网关 ────────────────────────────────────────────────────────────────
Write-Step "5/7 起 hook 网关（wcf → $HookServiceUrl，端口 $GatewayPort）"
$health = Invoke-WechatHttpGet -Url "http://127.0.0.1:$GatewayPort/health"
if ($health.Status -eq 200) {
    Write-Warn "端口 $GatewayPort 已在监听，复用"
} else {
    $gw = Start-Process -FilePath 'node' -ArgumentList @($gateway, '--driver', 'wcf', '--port', "$GatewayPort", '--secret', $Secret, '--wcf-base', $HookServiceUrl) -WindowStyle Hidden -PassThru
    Start-Sleep -Milliseconds 1200
    Write-Ok "网关已启动（pid $($gw.Id)）"
}
$svc = Invoke-WechatHttpGet -Url "$HookServiceUrl/health"
if ($svc.Status -ne 200) {
    Write-Warn "hook 服务 $HookServiceUrl 还没响应 —— 注入的 DLL 不提供 HTTP，需要你的 wcferry 那层服务起来。"
    Write-Host '    起好后本脚本的插件配置已经指向网关，直接重跑（或到面板点「立即拉一次」）。' -ForegroundColor DarkGray
} else {
    Write-Ok "hook 服务在线：$($svc.Body)"
}

# ── 6) 插件配置 ────────────────────────────────────────────────────────────
Write-Step '6/7 把插件切到 kind=hook'
$config = @{
    kind        = 'hook'
    webhookPath = '/wechat/webhook'
    hook        = @{
        baseUrl   = "http://127.0.0.1:$GatewayPort"
        secret    = $Secret
        pollMs    = 3000
        autoStart = $true
        selfIds   = @()
    }
    inject      = @{
        injectorPath = './native/build/wechat-inject.exe'
        processName  = $ProcessName
        hookDll      = $DllPath
        autoDetect   = $true
        dllDir       = './native/hook-dlls'
    }
    reply       = @{ autoReply = $true; mode = 'raw'; agentPreset = 'wechat-agent' }
    persona     = @{ file = './persona/wechat-persona.md'; inject = $false; scope = 'sessions' }
    history     = @{ maxMessages = 200 }
}
$yaml = ConvertTo-WechatBridgeConfigYaml -Config $config
$null = Set-WechatBridgeOverlay -Body $yaml

$null = Wait-DshReady -Origin $origin
$status = Wait-Status -Origin $origin -Description '插件已切到 kind=hook 并指向本机网关' -TimeoutSec 90 -Predicate {
    param($s)
    if ($s.kind -ne 'hook') { return $false }
    if ($null -ne $s.hook -and $null -ne $s.hook.baseUrl) { return ($s.hook.baseUrl -like "*:$GatewayPort*") }
    return $true
}
if (-not $status -or $status.kind -ne 'hook') {
    Write-Warn '插件还没热加载，到面板「设置 → 网关」确认 kind=hook / 地址；或重载插件后重跑。'
}

# ── 7) 自检 ────────────────────────────────────────────────────────────────
Write-Step '7/7 自检'
$poll = Invoke-WechatHttpPost -Url "$origin/wechat/api/console" -Body '{"action":"hook-poll"}' -ContentType 'application/json; charset=utf-8'
if ($poll.Status -eq 200) {
    $result = $null
    try { $result = $poll.Body | ConvertFrom-Json } catch { }
    if ($result -and $result.ok) { Write-Ok "拉取一次成功：+$($result.accepted) / 跳过 $($result.skipped)" }
    else { Write-Warn "拉取失败：$($poll.Body)" }
} else {
    Write-Warn "面板接口没响应（HTTP $($poll.Status)）"
}

Write-Host ''
Write-Ok '一键接入完成'
Write-Host '  接着就可以在 DSH 里直接聊：微信消息 → 插件轮询 → agent → 原样回微信。' -ForegroundColor Gray
Write-Host '  面板：控制台 →「个人微信 Hook」能看游标/错误、手动拉一次、随时停/开。' -ForegroundColor Gray
