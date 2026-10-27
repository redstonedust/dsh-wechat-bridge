#requires -version 5.1
<#
    native/test-inject.ps1 -- wechat-inject 的端到端自测。

    流程:
        1. 构建（或校验产物已存在）
        2. 起 build\test-target.exe，拿 pid
        3. wechat-inject.exe --pid <pid> --dll <abs> --json，解析 JSON
        4. 断言 ok=true，且 %TEMP%\wechat-inject-selftest-<pid>.txt 在 3 秒内出现
        5. 错误路径: --process definitely-not-running.exe -> code=process-not-found，退出码非 0
        6. 杀掉靶子进程，打印每一步结果；有失败则非 0 退出

    注意:
        脚本会把靶子进程的 TEMP/TMP 指到 build\selftest-tmp，这样 marker 落在仓库内、
        不污染真实 %TEMP%，并且在低完整性（沙箱/受限）环境里也能写。marker 的路径
        仍然由 DLL 通过 GetTempPathW 自己算出来，即"目标进程的 %TEMP%"。

    用法:
        powershell -NoProfile -ExecutionPolicy Bypass -File native\test-inject.ps1
        powershell -NoProfile -ExecutionPolicy Bypass -File native\test-inject.ps1 -SkipBuild
#>
[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [int]$MarkerTimeoutSec = 3
)

$ErrorActionPreference = 'Stop'

# 让 native 子进程的 UTF-8 输出按 UTF-8 解码，JSON 里的中文报错才不会乱码。
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$root      = $PSScriptRoot
$buildDir  = Join-Path $root 'build'
$injectExe = Join-Path $buildDir 'wechat-inject.exe'
$payloadDll= Join-Path $buildDir 'test-payload.dll'
$targetExe = Join-Path $buildDir 'test-target.exe'
$tmpDir    = Join-Path $buildDir 'selftest-tmp'

$script:passCount = 0
$script:failCount = 0

function Write-Step([string]$text) {
    Write-Host ''
    Write-Host "=== $text" -ForegroundColor Cyan
}
function Write-Pass([string]$text) {
    Write-Host "  [PASS] $text" -ForegroundColor Green
    $script:passCount++
}
function Write-Fail([string]$text) {
    Write-Host "  [FAIL] $text" -ForegroundColor Red
    $script:failCount++
}
function Write-Info([string]$text) {
    Write-Host "         $text" -ForegroundColor DarkGray
}
function Assert-True([bool]$condition, [string]$text) {
    if ($condition) { Write-Pass $text } else { Write-Fail $text; throw "断言失败: $text" }
}

$proc = $null
$exitCode = 1

try {
    # ---------------------------------------------------------------- 1/6 构建
    Write-Step '步骤 1/6: 构建 (build.ps1)'
    if ($SkipBuild) {
        Write-Info '-SkipBuild: 跳过编译，直接使用已有产物'
    }
    else {
        $buildScript = Join-Path $root 'build.ps1'
        & powershell -NoProfile -ExecutionPolicy Bypass -File $buildScript
        if ($LASTEXITCODE -ne 0) {
            throw "build.ps1 退出码 $LASTEXITCODE"
        }
        Write-Pass 'build.ps1 成功'
    }
    foreach ($f in @($injectExe, $payloadDll, $targetExe)) {
        if (-not (Test-Path -LiteralPath $f)) { throw "缺少产物: $f" }
    }
    Write-Pass "三个产物就绪: $buildDir"

    # ------------------------------------------------------------ 2/6 起靶子
    Write-Step '步骤 2/6: 启动靶子进程 test-target.exe'
    if (Test-Path -LiteralPath $tmpDir) {
        Remove-Item -LiteralPath $tmpDir -Recurse -Force
    }
    New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName               = $targetExe
    $psi.UseShellExecute        = $false
    $psi.CreateNoWindow         = $true
    $psi.RedirectStandardOutput = $true
    # 靶子进程的 %TEMP% -> build\selftest-tmp（见文件头注释）
    $psi.EnvironmentVariables['TEMP'] = $tmpDir
    $psi.EnvironmentVariables['TMP']  = $tmpDir

    $proc = [System.Diagnostics.Process]::Start($psi)
    Start-Sleep -Milliseconds 500
    if ($proc.HasExited) {
        throw "靶子进程启动后立刻退出，退出码 $($proc.ExitCode)"
    }
    $targetPid = $proc.Id
    Write-Pass "靶子进程已启动: pid=$targetPid"
    Write-Info "目标进程的 %TEMP% = $tmpDir"

    # ---------------------------------------------------------------- 3/6 注入
    Write-Step '步骤 3/6: 注入 test-payload.dll 并解析 JSON'
    $injectArgs = @('--pid', "$targetPid", '--dll', $payloadDll, '--json')
    Write-Info ("命令: wechat-inject.exe " + ($injectArgs -join ' '))

    $stdout = & $injectExe @injectArgs
    $injectExit = $LASTEXITCODE
    $jsonText = ($stdout | Out-String).Trim()
    Write-Info "退出码: $injectExit"
    Write-Info "stdout: $jsonText"

    Assert-True ($injectExit -eq 0) "注入器退出码为 0 (实际 $injectExit)"

    $result = $null
    try {
        $result = $jsonText | ConvertFrom-Json
    }
    catch {
        throw "无法把 stdout 解析成 JSON: $jsonText"
    }
    Assert-True ($result.ok -eq $true) 'JSON ok=true'
    Assert-True ($result.pid -eq $targetPid) "JSON pid 与靶子一致 ($($result.pid))"
    Assert-True ($result.process -eq 'test-target.exe') "JSON process=test-target.exe ($($result.process))"
    Assert-True ($result.injector -eq 'x64') "JSON injector=x64 ($($result.injector))"
    Assert-True ($result.target -eq 'x64') "JSON target=x64 ($($result.target))"
    $dllOk = [string]::Equals($result.dll, $payloadDll, [System.StringComparison]::OrdinalIgnoreCase)
    Assert-True $dllOk "JSON dll 是 test-payload.dll 的绝对路径 ($($result.dll))"

    # ------------------------------------------------------------- 4/6 marker
    Write-Step '步骤 4/6: 检查 marker 文件（3 秒内出现）'
    $marker = Join-Path $tmpDir ("wechat-inject-selftest-{0}.txt" -f $targetPid)
    $deadline = (Get-Date).AddSeconds($MarkerTimeoutSec)
    while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $marker)) {
        Start-Sleep -Milliseconds 100
    }
    if (-not (Test-Path -LiteralPath $marker)) {
        throw "marker 未在 $MarkerTimeoutSec 秒内出现: $marker"
    }
    $elapsed = [int]((Get-Date) - $deadline.AddSeconds(-$MarkerTimeoutSec)).TotalMilliseconds
    Write-Pass "marker 已出现（等待约 ${elapsed} ms）: $marker"
    Write-Info 'marker 内容:'
    Get-Content -LiteralPath $marker -Encoding UTF8 | ForEach-Object { Write-Info "  $_" }

    # --------------------------------------------------------- 5/6 错误路径
    Write-Step '步骤 5/6: 错误路径 --process definitely-not-running.exe'
    $badArgs = @('--process', 'definitely-not-running.exe', '--dll', $payloadDll, '--json')
    $badOut = & $injectExe @badArgs
    $badExit = $LASTEXITCODE
    $badText = ($badOut | Out-String).Trim()
    Write-Info "退出码: $badExit"
    Write-Info "stdout: $badText"

    Assert-True ($badExit -ne 0) "退出码非 0 (实际 $badExit)"
    Assert-True ($badExit -eq 2) "退出码为 2 = process not found (实际 $badExit)"

    $badResult = $null
    try {
        $badResult = $badText | ConvertFrom-Json
    }
    catch {
        throw "错误路径的 stdout 不是合法 JSON: $badText"
    }
    Assert-True ($badResult.ok -eq $false) 'JSON ok=false'
    Assert-True ($badResult.code -eq 'process-not-found') "JSON code=process-not-found ($($badResult.code))"

    # ------------------------------------------------------------- 6/6 收尾
    Write-Step '步骤 6/6: 结束靶子进程'
    if ($proc -and -not $proc.HasExited) {
        Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue
        $proc.WaitForExit(3000) | Out-Null
    }
    Assert-True ($proc.HasExited) "靶子进程已退出 (pid=$targetPid)"
    $proc = $null

    $exitCode = 0
}
catch {
    Write-Fail $_.Exception.Message
}
finally {
    if ($proc -and -not $proc.HasExited) {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    }
}

# ---------------------------------------------------------------------- 汇总
Write-Host ''
if ($exitCode -eq 0 -and $script:failCount -eq 0) {
    Write-Host "全部通过: $($script:passCount) 项断言" -ForegroundColor Green
    exit 0
}
Write-Host "自测失败: $($script:failCount) 项失败，$($script:passCount) 项通过" -ForegroundColor Red
exit 1
