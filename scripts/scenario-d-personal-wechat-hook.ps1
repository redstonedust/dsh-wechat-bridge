<#
.SYNOPSIS
    场景 D：个人微信 hook —— 插件主动轮询本地 hook 服务，agent 回完再主动发出去。

.DESCRIPTION
    这一步才真正接「个人微信」。个人微信没有公开 API，所以链路是：

        微信客户端 ──(hook)──▶ hook 服务 ──(HTTP 轮询)──▶ 插件 ──▶ DSH agent
                                    ▲                                  │
                                    └────────(POST /send)──────────────┘

    本脚本用自带的 mock 驱动把这条链路在**不需要微信**的情况下跑通：
      1. 起 gateway/hook-gateway.mjs --driver mock（127.0.0.1:8788）
      2. 把插件切成 kind=hook、hook.baseUrl 指向它
      3. POST /mock/push 造一条「好友发来的消息」
      4. 等插件轮询入库 → agent 回复 → 插件 POST /send
      5. 从 GET /mock/out 里读出 agent 真的发了什么

    跑通之后，把同一个网关换成真实驱动即可：
      --driver wcf  --wcf-base http://127.0.0.1:9999      （WeChatFerry 的 HTTP 封装）
      --driver exec --get-cmd "..." --send-cmd "..."      （把任何本地 hook 脚本包一层）

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\scenario-d-personal-wechat-hook.ps1

.EXAMPLE
    .\scripts\scenario-d-personal-wechat-hook.ps1 -Port 8788 -Secret hook-secret -Text "在吗" -KeepGateway
#>
[CmdletBinding()]
param(
    [string]$Origin,
    [int]$Port = 8788,
    [string]$Secret = 'hook-secret',
    [string]$ChatId = 'wxid_hook',
    [string]$ChatName = '微信好友',
    [string]$Text = '在吗？回我一句就好',
    [int]$TimeoutSec = 180,
    [switch]$KeepGateway,
    [switch]$WhatIf
)

. (Join-Path $PSScriptRoot '_common.ps1')

$origin = Get-DshOrigin -Origin $Origin
$root = Split-Path -Parent $PSScriptRoot
$gateway = Join-Path $root 'gateway\hook-gateway.mjs'
if (-not (Test-Path $gateway)) { throw "缺少 $gateway" }

Write-Host ''
Write-Host '场景 D：个人微信 hook（mock 驱动，不用真微信）' -ForegroundColor Magenta
Write-Host "  DSH        $origin"
Write-Host "  hook 网关  http://127.0.0.1:$Port （mock）"
Write-Host "  模拟好友   $ChatId（$ChatName）"
Write-Host ''

# ── 1) 配置 ────────────────────────────────────────────────────────────────
Write-Step '写入插件配置（kind=hook + hook.baseUrl）'
$config = @{
    kind        = 'hook'
    webhookPath = '/wechat/webhook'
    hook        = @{
        baseUrl  = "http://127.0.0.1:$Port"
        secret   = $Secret
        pollMs   = 1000
        limit    = 50
        autoStart = $true
        selfIds  = @('wxid_self')
    }
    reply       = @{
        autoReply   = $true
        mode        = 'raw'
        agentPreset = 'wechat-agent'
        selfNames   = @()
    }
    persona     = @{
        file   = './persona/wechat-persona.md'
        inject = $false
        scope  = 'sessions'
    }
    history     = @{ maxMessages = 200 }
    debug       = $false
}
$yaml = ConvertTo-WechatBridgeConfigYaml -Config $config
$null = Set-WechatBridgeOverlay -Body $yaml -WhatIf:$WhatIf
if ($WhatIf) { return }

# ── 2) 起 hook 网关 ────────────────────────────────────────────────────────
Write-Step "启动 hook 网关（mock，端口 $Port）"
$existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
$gatewayProcess = $null
if ($existing) {
    Write-Warn "端口 $Port 已在监听，复用现有网关（确认它用的密钥是 '$Secret'）"
} else {
    $gatewayProcess = Start-Process -FilePath 'node' `
        -ArgumentList @($gateway, '--driver', 'mock', '--port', "$Port", '--secret', $Secret) `
        -WindowStyle Hidden -PassThru
    Start-Sleep -Milliseconds 1200
    Write-Ok "hook 网关已启动（pid $($gatewayProcess.Id)）"
}

try {
    # ── 3) 等插件切到 hook 并对准这个网关 ──────────────────────────────────
    $null = Wait-DshReady -Origin $origin
    $status = Wait-Status -Origin $origin -Description "插件已切到 kind=hook（baseUrl=http://127.0.0.1:$Port）" -TimeoutSec 90 -Predicate {
        param($s)
        if ($s.kind -ne 'hook') { return $false }
        if ($null -ne $s.hook -and $null -ne $s.hook.baseUrl) { return ($s.hook.baseUrl -like "*:$Port*") }
        return $true
    }
    if (-not $status -or $status.kind -ne 'hook') {
        Write-Warn '插件还是旧配置。到面板「设置 → 网关」把类型改成 hook、地址填好，或重载插件后重跑。'
        throw '插件没有切到 hook 模式'
    }

    $gwHealth = Invoke-WechatHttpGet -Url "http://127.0.0.1:$Port/health"
    if ($gwHealth.Status -ne 200) { throw "hook 网关不可用：HTTP $($gwHealth.Status) $($gwHealth.Body)" }
    Write-Ok "hook 网关在线：$($gwHealth.Body)"

    # ── 4) 造一条「好友发来的消息」 ────────────────────────────────────────
    Write-Step "模拟好友发来消息：$Text"
    $pushed = Invoke-WechatHttpPost -Url "http://127.0.0.1:$Port/mock/push" -Body (@{
        chatId     = $ChatId
        chatName   = $ChatName
        kind       = 'private'
        senderId   = $ChatId
        senderName = $ChatName
        text       = $Text
    } | ConvertTo-Json -Compress)
    if ($pushed.Status -ne 200) { throw "造消息失败：HTTP $($pushed.Status) $($pushed.Body)" }
    Write-Ok '消息已进入 hook 网关的收件箱'

    # ── 5) 等插件轮询拉走 ──────────────────────────────────────────────────
    Write-Step '等插件轮询把它拉走（plugins 主动拉，不是网关推）'
    $status = Wait-Status -Origin $origin -Description '插件已拉到这条消息并建档' -TimeoutSec 60 -Predicate {
        param($s)
        foreach ($chat in @($s.chats)) { if ($chat.chatId -eq $ChatId) { return $true } }
        return $false
    }
    $found = $false
    if ($status) { foreach ($chat in @($status.chats)) { if ($chat.chatId -eq $ChatId) { $found = $true } } }
    if (-not $found) {
        Write-Host ("  当前 hook 状态：" + ($status.hook | ConvertTo-Json -Compress)) -ForegroundColor Gray
        throw '插件没拉到消息：看 hook.lastError（密钥不对？网关没起？）与 counters.errors。'
    }
    Write-Ok "会话 $ChatId 已入库"

    # ── 6) 等 agent 回完并 POST /send ──────────────────────────────────────
    Write-Step "等 agent 回复并经 hook 网关发出去（最多 $TimeoutSec 秒）"
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $outbound = @()
    while ((Get-Date) -lt $deadline) {
        $out = Invoke-WechatHttpGet -Url "http://127.0.0.1:$Port/mock/out"
        if ($out.Status -eq 200) {
            $parsed = $out.Body | ConvertFrom-Json
            $outbound = @($parsed.messages)
            if ($outbound.Count -gt 0) { break }
        }
        Start-Sleep -Milliseconds 900
    }
    if ($outbound.Count -eq 0) {
        $now = Get-BridgeStatus -Origin $origin
        Write-Host ("  counters = " + ($now.counters | ConvertTo-Json -Compress)) -ForegroundColor Gray
        Write-Host ("  lastError = " + $now.lastError) -ForegroundColor Gray
        throw '没等到出站：agent 没回 / 发送失败。用 wechat_diagnose 工具或看 hook.lastError。'
    }

    Write-Host ''
    Write-Host 'agent 真的发出去的（来自 hook 网关的 /mock/out）：' -ForegroundColor Cyan
    foreach ($item in ($outbound | Select-Object -Last 3)) {
        Write-Host ("  → [$($item.chatId)] $($item.text)") -ForegroundColor Green
    }
    Write-Host ''
    Write-Ok '场景 D 通过：微信 → hook → 轮询 → agent → /send 全链路闭环'
    Write-Host ''
    Write-Host '换成真实微信只需要换驱动（插件配置不用动）：' -ForegroundColor Cyan
    Write-Host '  node gateway\hook-gateway.mjs --driver wcf --port 8788 --secret hook-secret --wcf-base http://127.0.0.1:9999' -ForegroundColor Gray
    Write-Host '  node gateway\hook-gateway.mjs --driver exec --port 8788 --secret hook-secret `' -ForegroundColor Gray
    Write-Host '       --get-cmd "python my_hook.py pull {{cursor}} {{limit}}" --send-cmd "python my_hook.py send {{chatId}} {{text}}"' -ForegroundColor Gray
    Write-Host '  你的 wcf-http 路径/方法名不一样时，用 --get-path/--send-path/--get-method/--send-method/--arg-style 适配。' -ForegroundColor DarkGray
    Write-Host '  面板「控制台 → 个人微信 Hook」里能看游标、手动拉一次、随时停/开轮询。' -ForegroundColor DarkGray
} finally {
    if (-not $KeepGateway -and $gatewayProcess) {
        try {
            if (-not $gatewayProcess.HasExited) { Stop-Process -Id $gatewayProcess.Id -Force }
            Write-Host "  hook 网关已停止（pid $($gatewayProcess.Id)）" -ForegroundColor DarkGray
        } catch { }
    } elseif ($gatewayProcess) {
        Write-Host "  hook 网关仍在后台（pid $($gatewayProcess.Id)）" -ForegroundColor DarkGray
    }
}
