<#
.SYNOPSIS
    wechat-bridge 场景脚本的公共函数库（被 scenario-a/b/c.ps1 点引用，不单独运行）。

.DESCRIPTION
    约定：
      * 配置只写 profile 的 patch 层，且写入一段带标记的受管区块
        （# === wechat-bridge BEGIN/END ===），重复运行只会替换该区块，不动其它行。
      * 一切验证都通过插件的只读端点 GET <webhookPath>/status 断言，不猜。
#>

$ErrorActionPreference = 'Stop'
# 让中文在 UTF-8 终端里正常显示（PS 5.1 默认按 ANSI 输出）
try {
    [Console]::OutputEncoding = [Text.Encoding]::UTF8
    $OutputEncoding = [Text.Encoding]::UTF8
} catch { }
$script:DshOriginDefault = 'http://127.0.0.1:43120'
$script:MarkerBegin = '# === wechat-bridge BEGIN (managed by scripts) ==='
$script:MarkerEnd = '# === wechat-bridge END ==='

function Write-Step([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "  OK  $Text" -ForegroundColor Green }
function Write-Warn([string]$Text) { Write-Host "  !!  $Text" -ForegroundColor Yellow }
function Write-Fail([string]$Text) { Write-Host "  XX  $Text" -ForegroundColor Red }

function Get-DshHome {
    if ($env:DSH_HOME) { return $env:DSH_HOME }
    return (Join-Path $env:USERPROFILE '.dsh')
}

function Get-ProfilePatchPath([string]$Profile = 'desktop') {
    if ($env:DSH_PROFILE_DIR) { return (Join-Path $env:DSH_PROFILE_DIR 'cordis.patch.yml') }
    return (Join-Path (Get-DshHome) ("profiles\$Profile\cordis.patch.yml"))
}

function Get-DshOrigin([string]$Origin) {
    if (-not [string]::IsNullOrEmpty($Origin)) { return $Origin.TrimEnd('/') }
    if ($env:DSH_WEB_ORIGIN) { return $env:DSH_WEB_ORIGIN.TrimEnd('/') }
    return $script:DshOriginDefault
}

<#
.SYNOPSIS 读取插件状态端点。DSH 没起来时返回 $null（不抛异常）。
#>
function Get-BridgeStatus([string]$Origin = $script:DshOriginDefault, [string]$WebhookPath = '/wechat/webhook') {
    $url = "$Origin$WebhookPath/status"
    try {
        return Invoke-RestMethod -Uri $url -TimeoutSec 5 -Method Get
    } catch {
        return $null
    }
}

<#
.SYNOPSIS 等 DSH 起来并返回状态；超时则报错并给出可操作提示。
#>
function Wait-DshReady([string]$Origin, [int]$TimeoutSec = 30) {
    Write-Step "等 DSH 响应 $Origin"
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $status = Get-BridgeStatus -Origin $Origin
        if ($null -ne $status) { Write-Ok "DSH 在线，插件已激活"; return $status }
        Start-Sleep -Milliseconds 800
    }
    Write-Fail "连不上 $Origin，或 wechat-bridge 插件没启用。"
    Write-Host "    1) 先启动/重启 DSH Desktop" -ForegroundColor Gray
    Write-Host "    2) 确认插件行 include:wechat-bridge 是 active（插件管理器）" -ForegroundColor Gray
    throw "DSH 不可达：$Origin"
}

<#
.SYNOPSIS 轮询状态直到断言为真。
#>
function Wait-Status([string]$Origin, [scriptblock]$Predicate, [string]$Description, [int]$TimeoutSec = 60) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $status = Get-BridgeStatus -Origin $Origin
        if ($null -ne $status) {
            $ok = $false
            try { $ok = [bool](& $Predicate $status) } catch { $ok = $false; Write-Warn "谓词出错：$($_.Exception.Message)" }
            if ($ok) { Write-Ok $Description; return $status }
        }
        Start-Sleep -Milliseconds 900
    }
    Write-Warn "等待超时（$Description）—— 返回当前状态，交给调用方判定"
    return (Get-BridgeStatus -Origin $Origin)
}

<#
.SYNOPSIS 把一段受管 config 区块写进 profile patch（幂等）。
.DESCRIPTION 已存在同名区块就整体替换，不存在就追加。返回备份路径。
#>
function Set-WechatBridgeOverlay {
    param(
        [Parameter(Mandatory = $true)][string]$Body,
        [string]$Profile = 'desktop',
        [switch]$WhatIf
    )
    $path = Get-ProfilePatchPath -Profile $Profile
    if (-not (Test-Path $path)) { throw "找不到 profile patch：$path（先启动一次 DSH Desktop 让它生成）" }

    $block = $script:MarkerBegin + "`r`n" + $Body.TrimEnd() + "`r`n" + $script:MarkerEnd

    # 关键：必须按 UTF-8 字节读写。PS 5.1 的 Get-Content/Set-Content 默认按 ANSI 解码，
    # 会把已有中文注释解成乱码、甚至吃掉换行，直接毁掉这份 YAML。
    $text = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)

    $beginAt = $text.IndexOf($script:MarkerBegin, [System.StringComparison]::Ordinal)
    if ($beginAt -ge 0) {
        $endAt = $text.IndexOf($script:MarkerEnd, $beginAt, [System.StringComparison]::Ordinal)
        if ($endAt -lt 0) {
            # 有头没尾：从 BEGIN 一直截到文件末尾，避免留下半截区块
            $next = $text.Substring(0, $beginAt).TrimEnd() + "`r`n`r`n" + $block + "`r`n"
        } else {
            $tail = $text.Substring($endAt + $script:MarkerEnd.Length)
            $next = $text.Substring(0, $beginAt) + $block + $tail
        }
        $action = 'replaced'
    } else {
        $next = $text.TrimEnd() + "`r`n`r`n" + $block + "`r`n"
        $action = 'appended'
    }

    if ($WhatIf) {
        Write-Step "[WhatIf] 会 $action 受管区块到 $path"
        Write-Host $block -ForegroundColor DarkGray
        return $null
    }

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backup = "$path.bak-$stamp"
    Copy-Item -LiteralPath $path -Destination $backup -Force

    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($path, $next, $utf8NoBom)

    # 写完立刻自检：区块之外的内容必须一字不差地保留（不能只看文件长度，
    # 换一个更短的场景配置时长度本来就会变）。
    $verify = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
    $safe = $verify.Contains($script:MarkerEnd)
    if ($safe) {
        if ($beginAt -ge 0 -and $endAt -ge 0) {
            $prefix = $text.Substring(0, $beginAt)
            $suffix = $text.Substring($endAt + $script:MarkerEnd.Length)
            if (-not $verify.StartsWith($prefix)) { $safe = $false }
            if ($safe -and $suffix.Length -gt 0 -and -not $verify.EndsWith($suffix.TrimEnd())) { $safe = $false }
        } else {
            if (-not $verify.StartsWith($text.TrimEnd())) { $safe = $false }
        }
    }
    if (-not $safe) {
        Copy-Item -LiteralPath $backup -Destination $path -Force
        throw "写入后校验失败（区块外内容被改动），已回滚：$backup"
    }

    Write-Ok "已 $action 受管区块：$path（备份 $([IO.Path]::GetFileName($backup))）"
    return $backup
}

#
<#
.SYNOPSIS 把 hashtable 渲染成 patch YAML（只支持本插件用得上的两层结构）。
#>
function ConvertTo-WechatBridgeConfigYaml {
    param([Parameter(Mandatory = $true)][hashtable]$Config)
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.AppendLine('- id: wechat-bridge')
    [void]$sb.AppendLine('  name: dsh-wechat-bridge')
    [void]$sb.AppendLine('  config:')
    foreach ($key in $Config.Keys) {
        $value = $Config[$key]
        if ($value -is [hashtable]) {
            [void]$sb.AppendLine("    ${key}:")
            foreach ($subKey in $value.Keys) {
                [void]$sb.AppendLine("      ${subKey}: $(Format-WechatBridgeValue $value[$subKey])")
            }
        } else {
            [void]$sb.AppendLine("    ${key}: $(Format-WechatBridgeValue $value)")
        }
    }
    return $sb.ToString().TrimEnd()
}

function Format-WechatBridgeValue($Value) {
    if ($null -eq $Value) { return "''" }
    if ($Value -is [bool]) { if ($Value) { return 'true' } else { return 'false' } }
    if ($Value -is [int] -or $Value -is [long] -or $Value -is [double]) { return "$Value" }
    if ($Value -is [array]) {
        if ($Value.Count -eq 0) { return '[]' }
        $items = @()
        foreach ($item in $Value) { $items += "'" + ([string]$item).Replace("'", "''") + "'" }
        return '[' + ($items -join ', ') + ']'
    }
    $text = [string]$Value
    if ($text -eq '') { return "''" }
    return "'" + $text.Replace("'", "''") + "'"
}

<#
.SYNOPSIS 往 webhook 推一条入站消息（模拟微信网关）。
#>
function Send-WechatInbound {
    param(
        [Parameter(Mandatory = $true)][hashtable]$Body,
        [string]$Origin = $script:DshOriginDefault,
        [string]$WebhookPath = '/wechat/webhook',
        [string]$Secret = ''
    )
    $headers = @{}
    if (-not [string]::IsNullOrEmpty($Secret)) { $headers['X-WeChat-Secret'] = $Secret }
    $json = $Body | ConvertTo-Json -Depth 6 -Compress
    try {
        $response = Invoke-WebRequest -Uri "$Origin$WebhookPath" -Method Post -Body $json `
            -ContentType 'application/json; charset=utf-8' -Headers $headers -TimeoutSec 10 -UseBasicParsing
        return [pscustomobject]@{ Status = [int]$response.StatusCode; Body = $response.Content }
    } catch {
        $code = 0
        if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
        return [pscustomobject]@{ Status = $code; Body = $_.Exception.Message }
    }
}

<#
.SYNOPSIS 裸 HTTP GET，返回状态码 + 正文（不抛 4xx/5xx，PS 5.1 友好）。
#>
function Invoke-WechatHttpGet {
    param([Parameter(Mandatory = $true)][string]$Url, [int]$TimeoutSec = 10)
    $request = [System.Net.HttpWebRequest]::Create($Url)
    $request.Method = 'GET'
    $request.Timeout = $TimeoutSec * 1000
    try {
        $response = $request.GetResponse()
        $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
        $body = $reader.ReadToEnd()
        $reader.Dispose()
        $code = [int]$response.StatusCode
        $response.Dispose()
        return [pscustomobject]@{ Status = $code; Body = $body }
    } catch [System.Net.WebException] {
        $resp = $_.Exception.Response
        if ($null -ne $resp) {
            $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
            $body = $reader.ReadToEnd()
            $reader.Dispose()
            $code = [int]$resp.StatusCode
            $resp.Dispose()
            return [pscustomobject]@{ Status = $code; Body = $body }
        }
        return [pscustomobject]@{ Status = 0; Body = $_.Exception.Message }
    }
}

<#
.SYNOPSIS 裸 HTTP POST（text/xml 或 application/json），返回状态码 + 正文。
#>
function Invoke-WechatHttpPost {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][string]$Body,
        [string]$ContentType = 'application/json; charset=utf-8',
        [hashtable]$Headers = @{},
        [int]$TimeoutSec = 15
    )
    $request = [System.Net.HttpWebRequest]::Create($Url)
    $request.Method = 'POST'
    $request.Timeout = $TimeoutSec * 1000
    $request.ContentType = $ContentType
    foreach ($key in $Headers.Keys) { $request.Headers[$key] = $Headers[$key] }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Body)
    $request.ContentLength = $bytes.Length
    $stream = $request.GetRequestStream()
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Dispose()
    try {
        $response = $request.GetResponse()
        $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
        $text = $reader.ReadToEnd()
        $reader.Dispose()
        $code = [int]$response.StatusCode
        $response.Dispose()
        return [pscustomobject]@{ Status = $code; Body = $text }
    } catch [System.Net.WebException] {
        $resp = $_.Exception.Response
        if ($null -ne $resp) {
            $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
            $text = $reader.ReadToEnd()
            $reader.Dispose()
            $code = [int]$resp.StatusCode
            $resp.Dispose()
            return [pscustomobject]@{ Status = $code; Body = $text }
        }
        return [pscustomobject]@{ Status = 0; Body = $_.Exception.Message }
    }
}

<#
.SYNOPSIS 启动本地网关桩（node scripts/recv.mjs），返回进程对象；已占用则返回 $null。
#>
function Start-GatewayStub {
    param([int]$Port = 8787, [string]$LogFile = $null)
    $listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($listening) {
        Write-Warn "端口 $Port 已在监听，复用现有网关桩"
        return $null
    }
    $stub = Join-Path $PSScriptRoot 'recv.mjs'
    if (-not (Test-Path $stub)) { throw "缺少 $stub" }
    $arguments = @($stub, "$Port")
    if ($LogFile) { $arguments += $LogFile }
    $process = Start-Process -FilePath 'node' -ArgumentList $arguments -WindowStyle Hidden -PassThru
    Start-Sleep -Milliseconds 900
    Write-Ok "网关桩已启动（pid $($process.Id)），端口 $Port"
    return $process
}

function Stop-GatewayStub([System.Diagnostics.Process]$Process) {
    if ($null -eq $Process) { return }
    try {
        if (-not $Process.HasExited) { Stop-Process -Id $Process.Id -Force }
        Write-Ok "网关桩已停止（pid $($Process.Id)）"
    } catch {
        Write-Warn "停止网关桩失败：$($_.Exception.Message)"
    }
}

function Get-WechatBridgeRecvLog([string]$Path = $null) {
    if (-not $Path) { $Path = Join-Path (Split-Path -Parent $PSScriptRoot) '.recv.log' }
    if (-not (Test-Path $Path)) { return @() }
    return @(Get-Content -LiteralPath $Path -Encoding UTF8 -ErrorAction SilentlyContinue | Where-Object { $_.Trim() -ne '' })
}

function Wait-OutboundDelivery {
    param([int]$TimeoutSec = 120, [string]$LogPath = $null, [int]$MinCount = 1)
    Write-Step "等插件把回复投递到网关桩（最多 $TimeoutSec 秒）"
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $entries = Get-WechatBridgeRecvLog -Path $LogPath
        if ($entries.Count -ge $MinCount) {
            Write-Ok "收到 $($entries.Count) 条投递"
            return $entries
        }
        Start-Sleep -Milliseconds 900
    }
    Write-Fail "超时没收到投递。检查 status 里的 counters.errors 与 lastError，或网关桩是否还在跑。"
    return @()
}

function Clear-WechatBridgeRecvLog([string]$Path = $null) {
    if (-not $Path) { $Path = Join-Path (Split-Path -Parent $PSScriptRoot) '.recv.log' }
    Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
}
