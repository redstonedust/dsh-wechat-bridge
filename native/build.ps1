#requires -version 5.1
<#
    native/build.ps1 -- 用 gcc 编译 wechat-inject 的三个产物。

    用法:
        powershell -NoProfile -ExecutionPolicy Bypass -File native\build.ps1
        powershell -NoProfile -ExecutionPolicy Bypass -File native\build.ps1 -Clean

    产物 (都在 native\build\):
        wechat-inject.exe   Win32 CLI 注入器
        test-payload.dll    自测用 DLL，加载后往 %TEMP% 写 marker 文件
        test-target.exe     自测用靶子进程，Sleep(30000) 后退出

    说明:
        - 本文件是 UTF-8 带 BOM + CRLF，PS 5.1 才能正确解析中文注释（见 .gitattributes）。
        - gcc 的原始报错直接打在控制台，本脚本只负责串起命令并在失败时非 0 退出。
#>
[CmdletBinding()]
param(
    [switch]$Clean
)

$ErrorActionPreference = 'Stop'

$root   = $PSScriptRoot
$outDir = Join-Path $root 'build'

# ------------------------------------------------------------------ 环境检查
$gcc = Get-Command gcc -ErrorAction SilentlyContinue
if (-not $gcc) {
    Write-Host '[build] 找不到 gcc，请先把 MinGW 的 bin 目录加入 PATH' -ForegroundColor Red
    exit 1
}

$gccVersion = (& gcc --version | Select-Object -First 1)
$gccMachine = (& gcc -dumpmachine)
Write-Host "[build] gcc    : $gccVersion"
Write-Host "[build] target : $gccMachine"
if ($gccMachine -notmatch 'x86_64') {
    Write-Host '[build] 警告: 当前 gcc 目标不是 x86_64，产物无法注入 64 位微信。' -ForegroundColor Yellow
}

# ------------------------------------------------------------------ 输出目录
if ($Clean -and (Test-Path -LiteralPath $outDir)) {
    Write-Host "[build] -Clean: 删除 $outDir"
    Remove-Item -LiteralPath $outDir -Recurse -Force
}
if (-not (Test-Path -LiteralPath $outDir)) {
    New-Item -ItemType Directory -Path $outDir -Force | Out-Null
}

# ------------------------------------------------------------------ 编译任务
# -static: 只依赖系统 DLL（kernel32/msvcrt 等），不拖 libgcc/winpthread。
$common = @('-O2', '-Wall', '-Wextra', '-static')

$builds = @(
    [pscustomobject]@{ Out = 'wechat-inject.exe'; Src = 'wechat-inject.c'; Extra = @('-lshell32') },
    [pscustomobject]@{ Out = 'test-payload.dll';  Src = 'test-payload.c';  Extra = @('-shared', '-luser32') },
    [pscustomobject]@{ Out = 'test-target.exe';   Src = 'test-target.c';   Extra = @() }
)

foreach ($item in $builds) {
    $src = Join-Path $root $item.Src
    $dst = Join-Path $outDir $item.Out

    if (-not (Test-Path -LiteralPath $src)) {
        Write-Host "[build] 缺少源文件: $src" -ForegroundColor Red
        exit 1
    }

    # 用绝对路径：本脚本可能被从任意 cwd 调用（scripts/check.ps1 就是传绝对路径调过来的），
    # gcc 的工作目录是调用方 cwd，只给相对名会 "No such file or directory"。
    $argv = @($src) + $common + @('-o', $dst) + $item.Extra
    Write-Host ('[build] gcc ' + ($argv -join ' '))

    & gcc @argv
    $code = $LASTEXITCODE
    if ($code -ne 0) {
        Write-Host "[build] gcc 编译 $($item.Src) 失败，退出码 $code" -ForegroundColor Red
        Write-Host '[build] 上面是 gcc 的原始输出' -ForegroundColor Red
        exit 1
    }
    if (-not (Test-Path -LiteralPath $dst)) {
        Write-Host "[build] gcc 返回 0 但没有生成 $dst" -ForegroundColor Red
        exit 1
    }
}

# ------------------------------------------------------------------ 结果列表
Write-Host '[build] 构建完成:'
Get-ChildItem -LiteralPath $outDir -File | Sort-Object Name | ForEach-Object {
    Write-Host ('  {0,-20} {1,9:N0} bytes' -f $_.Name, $_.Length)
}
exit 0
