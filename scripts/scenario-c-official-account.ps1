<#
.SYNOPSIS
    场景 C：接微信公众平台（服务号/订阅号），含本地签名验签自测。

.DESCRIPTION
    切到 kind=official 后，本脚本会用你给的 Token 在**本地**模拟微信的服务器配置校验：
      * 正确签名 → 期望原样回 echostr；
      * 错误签名 → 期望 403。
    -TestInbound 还会推一条签名过的 XML 文本消息，验证解析链路（注意：这会触发一次真实客服消息
    发送，用假 appId/appSecret 时你会看到 errcode，属于正常现象）。

    跑完后把 -PublicUrl 指到插件的地址填进公众号后台即可。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\scenario-c-official-account.ps1 `
        -AppId wx1234567890abcdef -AppSecret <secret> -Token <token> -PublicUrl https://bot.example.com/wechat/webhook

.EXAMPLE
    # 只做本地验签与解析，不实际发消息（用占位凭据也能跑）
    .\scripts\scenario-c-official-account.ps1 -AppId wx_placeholder -AppSecret placeholder -Token 'my-token' -TestInbound
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$AppId,
    [Parameter(Mandatory = $false)][string]$AppSecret = '',
    [Parameter(Mandatory = $true)][string]$Token,
    [string]$PublicUrl = '',
    [string]$Origin,
    [string]$WebhookPath = '/wechat/webhook',
    [string]$ChatId = 'oUpF8uMuAJO_M2pxb1Q9zNjWeS6o',
    [string]$Text = '（场景 C）公众号入站自测',
    [switch]$TestInbound,
    [switch]$WhatIf
)

. (Join-Path $PSScriptRoot '_common.ps1')

$origin = Get-DshOrigin -Origin $Origin

if ([string]::IsNullOrEmpty($AppSecret)) {
    Write-Warn '没给 -AppSecret：入站能收、出站会失败（换 access_token 失败）。只做入站自测可以这样跑。'
}

Write-Host ''
Write-Host '场景 C：微信公众号' -ForegroundColor Magenta
Write-Host "  DSH        $origin${WebhookPath}"
Write-Host "  AppId      $AppId"
Write-Host "  Token      $Token"
if ($PublicUrl) { Write-Host "  公网地址   $PublicUrl" }
Write-Host ''

# ── 1) 配置 ────────────────────────────────────────────────────────────────
Write-Step '写入插件配置（kind=official）'
$config = @{
    kind        = 'official'
    webhookPath = $WebhookPath
    gateway     = @{
        appId     = $AppId
        appSecret = $AppSecret
        token     = $Token
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

$null = Wait-DshReady -Origin $origin
$status = Wait-Status -Origin $origin -Description '插件已切到 official' -TimeoutSec 60 -Predicate {
    param($s) $s.kind -eq 'official'
}
if (-not $status -or $status.kind -ne 'official') {
    Write-Warn '配置可能还没热加载；稍后重跑，或在插件管理器里关一下再开 include:wechat-bridge。'
    return
}

# ── 2) 本地验签自测 ────────────────────────────────────────────────────────
function Get-WechatSignature([string]$TokenValue, [string]$Timestamp, [string]$Nonce) {
    $joined = (@($TokenValue, $Timestamp, $Nonce) | Sort-Object) -join ''
    $sha1 = [System.Security.Cryptography.SHA1]::Create()
    try {
        $bytes = $sha1.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($joined))
        return (-join ($bytes | ForEach-Object { $_.ToString('x2') }))
    } finally {
        $sha1.Dispose()
    }
}

$timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds().ToString()
$nonce = (Get-Random -Minimum 100000 -Maximum 999999).ToString()
$signature = Get-WechatSignature -TokenValue $Token -Timestamp $timestamp -Nonce $nonce
$echo = "echo-$([guid]::NewGuid().ToString('N').Substring(0, 12))"

Write-Step '验签自测 1：正确签名应原样回 echostr'
$query = "?signature=$signature&timestamp=$timestamp&nonce=$nonce&echostr=$echo"
$probe = Invoke-WechatHttpGet -Url "$origin${WebhookPath}$query"
if ($probe.Status -ne 200) {
    Write-Fail "验签请求失败：HTTP $($probe.Status) $($probe.Body)"
    throw '验签请求未返回 200'
}
if ($probe.Body.Trim() -eq $echo) {
    Write-Ok "验签通过，收回 echostr：$echo"
} else {
    Write-Fail "验签返回了别的东西：$($probe.Body)"
    throw '验签未按预期回 echostr'
}

Write-Step '验签自测 2：错误签名应被拒（403）'
$rejected = Invoke-WechatHttpGet -Url "$origin${WebhookPath}?signature=deadbeef&timestamp=$timestamp&nonce=$nonce&echostr=$echo"
if ($rejected.Status -eq 403) { Write-Ok '错误签名被拒（403），符合预期' }
elseif ($rejected.Status -eq 200) { Write-Fail '错误签名居然被接受了 —— 检查 gateway.token 是否为空' }
else { Write-Warn "错误签名的响应码是 $($rejected.Status)（期望 403）" }

# ── 3) 可选：入站 XML 解析自测 ─────────────────────────────────────────────
if ($TestInbound) {
    Write-Step '入站自测：推一条签名过的 XML 文本消息'
    if ([string]::IsNullOrEmpty($AppSecret) -or $AppSecret -eq 'placeholder') {
        Write-Warn '凭据是占位值：入站会入库，但回复会因为换不到 access_token 而失败（counters.errors +1）。'
    }
    $timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds().ToString()
    $nonce = (Get-Random -Minimum 100000 -Maximum 999999).ToString()
    $signature = Get-WechatSignature -TokenValue $Token -Timestamp $timestamp -Nonce $nonce
    $xml = @"
<xml>
  <ToUserName><![CDATA[gh_placeholder]]></ToUserName>
  <FromUserName><![CDATA[$ChatId]]></FromUserName>
  <CreateTime>$timestamp</CreateTime>
  <MsgType><![CDATA[text]]></MsgType>
  <Content><![CDATA[$Text]]></Content>
  <MsgId>$(Get-Random -Minimum 1000000000 -Maximum 2000000000)</MsgId>
</xml>
"@
    $pushed = Invoke-WechatHttpPost -Url "$origin${WebhookPath}?signature=$signature&timestamp=$timestamp&nonce=$nonce" -Body $xml -ContentType 'text/xml; charset=utf-8'
    if ($pushed.Status -ne 200) {
        Write-Fail "XML 推送失败：HTTP $($pushed.Status) $($pushed.Body)"
        throw 'XML 入站未返回 200'
    }
    if ($pushed.Body.Trim() -eq 'success') { Write-Ok 'XML 已被接受（回 success），微信侧的 5 秒约束满足' }
    else { Write-Warn "返回内容不是 success：$($pushed.Body)" }

    # 注意：谓词里不要嵌套 Where-Object（内层 scriptblock 看不到外层变量 $ChatId），用 foreach。
    $status = Wait-Status -Origin $origin -Description '公众号会话已入库' -TimeoutSec 60 -Predicate {
        param($s)
        foreach ($c in @($s.chats)) { if ($c.chatId -eq $ChatId) { return $true } }
        return $false
    }
    $chat = $null
    if ($status) { foreach ($candidate in @($status.chats)) { if ($candidate.chatId -eq $ChatId) { $chat = $candidate; break } } }
    if ($null -ne $chat) {
        Write-Ok "会话 $($chat.chatId) 已入库（未读 $($chat.unread)，托管会话 $($chat.sessionId)）"
        Write-Host '  若 counters.errors 增长、lastError 里出现 access_token/errcode，就是占位凭据的预期表现。' -ForegroundColor Gray
    } else {
        Write-Fail "入站没入库：检查 gateway.token 是否与签名一致、或看 status 的 lastError"
        throw '公众号入站未入库'
    }
}

# ── 4) 后续动作 ────────────────────────────────────────────────────────────
Write-Host ''
Write-Ok '场景 C 本地部分通过：验签 + （可选）XML 入站'
Write-Host ''
Write-Host '接下来要你手动做的一次性配置：' -ForegroundColor Cyan
Write-Host '  1) 把插件的 webhook 暴露到公网（HTTPS）。反代只放行这一条路径，例如 Caddy：' -ForegroundColor Gray
Write-Host '       bot.example.com {' -ForegroundColor DarkGray
Write-Host '         handle /wechat/webhook* {' -ForegroundColor DarkGray
Write-Host '           reverse_proxy 127.0.0.1:43120' -ForegroundColor DarkGray
Write-Host '         }' -ForegroundColor DarkGray
Write-Host '       }' -ForegroundColor DarkGray
Write-Host "  2) 公众号后台 → 开发 → 基本配置 → 服务器配置：" -ForegroundColor Gray
$shownUrl = $PublicUrl
if ([string]::IsNullOrEmpty($shownUrl)) { $shownUrl = 'https://<你的域名>' + $WebhookPath }
Write-Host "       URL   = $shownUrl" -ForegroundColor Gray
Write-Host "       Token = $Token" -ForegroundColor Gray
Write-Host '       消息加解密方式 = 明文模式' -ForegroundColor Gray
Write-Host '     点「提交」→ 微信会 GET 一次验签；插件已能正确处理。' -ForegroundColor Gray
Write-Host '  3) 别忘「启用」服务器配置。' -ForegroundColor Gray
Write-Host ''
Write-Host '  注意：公众号客服消息有 48 小时窗口（用户 48h 内没发消息就发不出去，errcode 45015）。' -ForegroundColor DarkYellow
Write-Host '        长期主动推送需要模板消息/订阅消息，本插件不提供。' -ForegroundColor DarkYellow
