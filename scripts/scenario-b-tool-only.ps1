<#
.SYNOPSIS
    场景 B：只当工具用 —— 关掉自动转发，agent 自己决定看什么、回什么。

.DESCRIPTION
    切到 autoReply=false 后：
      * 入站消息只入库，不唤醒 agent、不自动回；
      * agent 用 wechat_get_unread_messages / wechat_get_recent_messages 看，
        用 wechat_send_message 回（可以分多条、能引用、能 @）。
    本脚本会先切配置，再推一条消息做**反向断言**：消息进了库，但既没有自动会话也没有出站投递。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\scenario-b-tool-only.ps1

.EXAMPLE
    .\scripts\scenario-b-tool-only.ps1 -Port 8787 -ChatId wxid_group_demo -Kind group -Text "今天谁值班"
#>
[CmdletBinding()]
param(
    [string]$Origin,
    [int]$Port = 8787,
    [string]$Secret = 'change-me',
    [string]$ChatId = 'wxid_demo',
    [string]$ChatName = '工具演示',
    [ValidateSet('private', 'group')][string]$Kind = 'private',
    [string]$Text = '（场景 B）这条只会入库，不会被自动回复。',
    [int]$TimeoutSec = 90,
    [switch]$WhatIf
)

. (Join-Path $PSScriptRoot '_common.ps1')

$origin = Get-DshOrigin -Origin $Origin
$recvLog = Join-Path (Split-Path -Parent $PSScriptRoot) '.recv.log'

Write-Host ''
Write-Host '场景 B：只当工具用（autoReply=false）' -ForegroundColor Magenta
Write-Host "  DSH       $origin"
Write-Host "  网关桩    http://127.0.0.1:$Port/send"
Write-Host "  模拟会话  $ChatId（$Kind）"
Write-Host ''

# ── 1) 配置 ────────────────────────────────────────────────────────────────
Write-Step '写入插件配置（autoReply=false，保留出站通道给工具用）'
$config = @{
    kind        = 'generic'
    webhookPath = '/wechat/webhook'
    gateway     = @{
        sendUrl      = "http://127.0.0.1:$Port/send"
        sharedSecret = $Secret
    }
    reply       = @{
        autoReply   = $false
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

# ── 2) 等配置生效 ──────────────────────────────────────────────────────────
$null = Wait-DshReady -Origin $origin
$status = Wait-Status -Origin $origin -Description '插件已切到 autoReply=false' -TimeoutSec 60 -Predicate {
    param($s) $s.autoReply -eq $false
}
if (-not $status -or $status.autoReply -ne $false) {
    Write-Warn '配置可能还没热加载；稍后重跑本脚本，或在插件管理器里关一下再开 include:wechat-bridge。'
    return
}

# ── 3) 反向断言 ────────────────────────────────────────────────────────────
Clear-WechatBridgeRecvLog -Path $recvLog
$stub = Start-GatewayStub -Port $Port -LogFile $recvLog
try {
    Write-Step "推入站消息：$Text"
    $push = Send-WechatInbound -Body @{
        chatId     = $ChatId
        chatName   = $ChatName
        kind       = $Kind
        senderId   = 'wxid_sender'
        senderName = '演示发言人'
        text       = $Text
        messageId  = "scenario-b-$(Get-Date -Format 'HHmmss')"
    } -Origin $origin -Secret $Secret
    if ($push.Status -ne 200) { throw "入站被拒（HTTP $($push.Status)）：$($push.Body)" }
    Write-Ok "入站已接受：$($push.Body)"

    Write-Step '断言 1：消息进了库（chat 出现，且未读 ≥ 1）'
    # 注意：谓词里不要嵌套 Where-Object（内层 scriptblock 看不到外层变量 $ChatId），用 foreach。
    $status = Wait-Status -Origin $origin -Description '会话已入库且有未读' -TimeoutSec 30 -Predicate {
        param($s)
        foreach ($chat in @($s.chats)) {
            if ($chat.chatId -eq $ChatId) { return ($chat.unread -ge 1) }
        }
        return $false
    }
    if (-not $status) { throw '消息没进库：检查 sharedSecret 与 allowedChatIds。' }

    Write-Step '断言 2：没有自动建会话（不唤醒 agent）'
    $chat = $null
    foreach ($candidate in @($status.chats)) { if ($candidate.chatId -eq $ChatId) { $chat = $candidate; break } }
    if ($chat.sessionId) {
        Write-Warn "该会话已存在托管会话 $($chat.sessionId)（之前自动回复时建的），属正常残留；新消息不会触发自动回复。"
    } else {
        Write-Ok '没有托管会话 —— 自动转发确实关着'
    }

    Write-Step '断言 3：没有任何出站投递'
    Start-Sleep -Seconds 8
    $entries = @(Get-WechatBridgeRecvLog -Path $recvLog)
    if ($entries.Count -eq 0) {
        Write-Ok '网关桩没收到任何投递 —— 符合预期'
    } else {
        Write-Fail "意外收到 $($entries.Count) 条投递："
        $entries | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
        throw 'autoReply=false 却仍出现自动转发。'
    }

    Write-Host ''
    Write-Ok '场景 B 通过：消息只入库，转发权完全交给 agent'
    Write-Host ''
    Write-Host '接下来在 DSH 会话里这么用它（可以直接粘）：' -ForegroundColor Cyan
    Write-Host "  1) 看有没有新消息：  wechat_get_unread_messages(chatId='$ChatId')" -ForegroundColor Gray
    Write-Host "  2) 决定回什么：      wechat_send_message(chatId='$ChatId', messages=@('在','刚看到'))" -ForegroundColor Gray
    Write-Host "  3) 收尾提交水位：    wechat_mark_read(chatId='$ChatId', throughSeq=<读到的 readThroughSeq>)" -ForegroundColor Gray
    Write-Host '  群里想只接被 @ 的话题：在 tool 调用前自己判断 senderName / 文本里有没有 @机器人名。' -ForegroundColor Gray
    Write-Host ''
    Write-Host '  提示：本模式没有 agent 自动参与，需要一个真人在 DSH 里驱动 agent（或让它跑在定时/工作流里）。' -ForegroundColor DarkGray
} finally {
    Stop-GatewayStub -Process $stub
}
