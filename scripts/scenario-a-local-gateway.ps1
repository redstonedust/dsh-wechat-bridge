<#
.SYNOPSIS
    场景 A：本地跑通「入站 → agent → 原样出站」整条链路（不连真实微信）。

.DESCRIPTION
    做四件事：
      1. 把插件配置切成 generic 网关：sendUrl 指向本地网关桩，带 sharedSecret。
      2. 启动网关桩（node scripts/recv.mjs）。
      3. 往 /wechat/webhook 推一条模拟微信消息，等 agent 跑完。
      4. 断言网关桩收到了原样投递（raw:true），并打印 payload。

    反复运行是安全的：配置写进受管区块、日志每次清空、桩已在跑就复用。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\scenario-a-local-gateway.ps1

.EXAMPLE
    # 只看会写什么配置，不执行
    .\scripts\scenario-a-local-gateway.ps1 -WhatIf

.EXAMPLE
    # 自定义文案与端口，跑完停掉桩
    .\scripts\scenario-a-local-gateway.ps1 -Text "只回三个字：链路通" -Port 8899 -StopStubAfter
#>
[CmdletBinding()]
param(
    [string]$Origin,
    [int]$Port = 8787,
    [string]$Secret = 'change-me',
    [string]$ChatId = 'wxid_demo',
    [string]$ChatName = '本地演示',
    [string]$Text = '只回三个字：链路通',
    [int]$TimeoutSec = 150,
    [switch]$StopStubAfter,
    [switch]$WhatIf
)

. (Join-Path $PSScriptRoot '_common.ps1')

$origin = Get-DshOrigin -Origin $Origin
$recvLog = Join-Path (Split-Path -Parent $PSScriptRoot) '.recv.log'

Write-Host ''
Write-Host '场景 A：本地网关跑通链路' -ForegroundColor Magenta
Write-Host "  DSH       $origin"
Write-Host "  网关桩    http://127.0.0.1:$Port/send  ->  $recvLog"
Write-Host "  模拟会话  $ChatId（$ChatName）"
Write-Host ''

# ── 1) 配置 ────────────────────────────────────────────────────────────────
Write-Step '写入插件配置（generic + 本地网关桩）'
$config = @{
    kind        = 'generic'
    webhookPath = '/wechat/webhook'
    gateway     = @{
        sendUrl      = "http://127.0.0.1:$Port/send"
        sharedSecret = $Secret
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
$backup = Set-WechatBridgeOverlay -Body $yaml -WhatIf:$WhatIf
if ($WhatIf) { return }

# ── 2) 等插件热加载 ────────────────────────────────────────────────────────
$null = Wait-DshReady -Origin $origin
$status = Wait-Status -Origin $origin -Description '插件已切到 generic 且自动回复开启' -TimeoutSec 60 -Predicate {
    param($s) $s.kind -eq 'generic' -and $s.autoReply -eq $true
}
if ($null -ne $status -and $null -ne $status.gateway) {
    # 新版插件会把生效中的网关配置回报出来，可以直接断言
    $null = Wait-Status -Origin $origin -Description "sendUrl 已生效：http://127.0.0.1:$Port/send" -TimeoutSec 40 -Predicate {
        param($s) $s.gateway.sendUrl -eq "http://127.0.0.1:$Port/send"
    }
} else {
    Write-Warn '插件未回报生效中的网关配置（旧构建），跳过 sendUrl 断言，直接看投递结果。'
}

# ── 3) 网关桩 ──────────────────────────────────────────────────────────────
Clear-WechatBridgeRecvLog -Path $recvLog
$stub = Start-GatewayStub -Port $Port -LogFile $recvLog

try {
    # ── 4) 推一条入站消息 ──────────────────────────────────────────────────
    Write-Step "推入站消息：$Text"
    $body = @{
        chatId    = $ChatId
        chatName  = $ChatName
        kind      = 'private'
        senderId  = $ChatId
        senderName = $ChatName
        text      = $Text
        messageId = "scenario-a-$(Get-Date -Format 'HHmmss')"
    }
    $push = Send-WechatInbound -Body $body -Origin $origin -Secret $Secret
    if ($push.Status -eq 401) { throw "401：sharedSecret 不匹配。确认配置里的 sharedSecret 与脚本一致（当前 '$Secret'）。" }
    if ($push.Status -ne 200) { throw "入站被拒（HTTP $($push.Status)）：$($push.Body)" }
    Write-Ok "入站已接受：$($push.Body)"

    # ── 5) 等 agent 回完并投递 ────────────────────────────────────────────
    $entries = @(Wait-OutboundDelivery -TimeoutSec $TimeoutSec -LogPath $recvLog)
    if ($entries.Count -eq 0) {
        $now = Get-BridgeStatus -Origin $origin
        Write-Host ''
        Write-Host '诊断：' -ForegroundColor Yellow
        Write-Host ("  counters = " + ($now.counters | ConvertTo-Json -Compress)) -ForegroundColor Gray
        Write-Host ("  lastError = " + $now.lastError) -ForegroundColor Gray
        Write-Host '  下一步：在 DSH 里对任意会话调用 wechat_diagnose 工具，它会直说失败原因。' -ForegroundColor Gray
        throw '链路未打通：没有收到出站投递。'
    }

    Write-Host ''
    Write-Host '收到的投递（最后一条）：' -ForegroundColor Cyan
    $line = [string]$entries[$entries.Count - 1]
    Write-Host ("  " + $line) -ForegroundColor Green
    $payload = $null
    try { $payload = ($line -split ' ', 3)[2] | ConvertFrom-Json } catch { }
    if ($payload) {
        Write-Host ''
        Write-Host '解析：' -ForegroundColor Cyan
        Write-Host ("  action = " + $payload.action) -ForegroundColor Gray
        Write-Host ("  chatId = " + $payload.chatId) -ForegroundColor Gray
        Write-Host ("  raw    = " + $payload.raw + "   （true = 模型最终文本原样发出）") -ForegroundColor Gray
        Write-Host ("  text   = " + $payload.text) -ForegroundColor Gray
    }

    Write-Host ''
    Write-Ok '场景 A 通过：入站 → agent → 原样出站 已闭环'
    Write-Host '  到 DSH 侧边栏点开 wechat-* 会话，可以看到模型这一轮怎么想的。' -ForegroundColor Gray
    Write-Host '  再验：在会话里调用 wechat_status / wechat_diagnose。' -ForegroundColor Gray
    if ($backup) { Write-Host "  配置备份：$backup" -ForegroundColor DarkGray }
} finally {
    if ($StopStubAfter) { Stop-GatewayStub -Process $stub }
    elseif ($stub) { Write-Host "  网关桩仍在后台运行（pid $($stub.Id)）；不用了执行 Stop-Process -Id $($stub.Id)" -ForegroundColor DarkGray }
}
