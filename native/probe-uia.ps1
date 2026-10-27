# requires -version 5.1
<#
    probe-uia.ps1 —— 只读探针：看看微信窗口的 UI Automation 树长什么样。

    为什么需要它：WeChatFerry 那套 hook DLL 只对 WeChat.exe 3.9.x 有效，
    而 Weixin 4.x 是另一套进程/UI。如果 UIA 能读到会话列表、消息列表、输入框，
    就可以不依赖任何 DLL 做「版本无关」的接入。

    用法:
        powershell -NoProfile -ExecutionPolicy Bypass -File native\probe-uia.ps1
        powershell -NoProfile -ExecutionPolicy Bypass -File native\probe-uia.ps1 -Depth 6 -Max 400
#>
[CmdletBinding()]
param(
    [string]$ProcessName = 'Weixin',
    [int]$Depth = 4,
    [int]$Max = 160,
    [switch]$Stats
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$AE = [System.Windows.Automation.AutomationElement]
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker

$procs = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue)
if ($procs.Count -eq 0) {
    Write-Host "没有找到进程 $ProcessName" -ForegroundColor Yellow
    exit 2
}
Write-Host ("进程: {0} 个，主窗口见下" -f $procs.Count)

$count = 0
function Show-Node($element, $level) {
    if ($script:count -ge $Max) { return }
    $script:count++
    $pad = '  ' * $level
    $name = ''
    $autoId = ''
    $type = ''
    $class = ''
    try { $name = [string]$element.Current.Name } catch { }
    try { $autoId = [string]$element.Current.AutomationId } catch { }
    try { $type = [string]$element.Current.ControlType.ProgrammaticName } catch { }
    try { $class = [string]$element.Current.ClassName } catch { }
    if ($name.Length -gt 42) { $name = $name.Substring(0, 42) + '…' }
    if ($type.Length -gt 0) { $type = $type -replace 'ControlType\.', '' }
    $line = '{0}[{1}] name="{2}" id="{3}" class="{4}"' -f $pad, $type, $name, $autoId, $class
    Write-Host $line
}

function Walk($element, $level) {
    if ($script:count -ge $Max) { return }
    Show-Node $element $level
    if ($level -ge $Depth) { return }
    $child = $walker.GetFirstChild($element)
    while ($null -ne $child) {
        Walk $child ($level + 1)
        if ($script:count -ge $Max) { return }
        $child = $walker.GetNextSibling($child)
    }
}

foreach ($p in $procs) {
    $cond = New-Object System.Windows.Automation.PropertyCondition($AE::ProcessIdProperty, $p.Id)
    $windows = $AE::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
    if ($windows.Count -eq 0) { continue }
    Write-Host ''
    Write-Host ("=== pid {0} 顶级窗口 {1} 个" -f $p.Id, $windows.Count) -ForegroundColor Cyan
    foreach ($w in $windows) {
        $count = 0
        Walk $w 0
        Write-Host ("  (本窗口节点数 {0})" -f $count) -ForegroundColor DarkGray
        if ($count -ge 3) { break }
    }
    break
}

if ($Stats) {
    Write-Host ''
    Write-Host '=== 每个窗口的后代节点统计（判断这个客户端是否暴露可用的 UIA 树）===' -ForegroundColor Cyan
    foreach ($p in $procs) {
        $cond = New-Object System.Windows.Automation.PropertyCondition($AE::ProcessIdProperty, $p.Id)
        $windows = $AE::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
        foreach ($w in $windows) {
            $all = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
            $title = ''
            $class = ''
            try { $title = [string]$w.Current.Name } catch { }
            try { $class = [string]$w.Current.ClassName } catch { }
            Write-Host ("pid={0} class={1} title={2} descendants={3}" -f $p.Id, $class, $title, $all.Count)
            $table = @{}
            foreach ($e in $all) {
                $t = 'unknown'
                try { $t = [string]$e.Current.ControlType.ProgrammaticName -replace 'ControlType\.', '' } catch { }
                if ($table.ContainsKey($t)) { $table[$t] = $table[$t] + 1 } else { $table[$t] = 1 }
            }
            foreach ($entry in ($table.GetEnumerator() | Sort-Object Value -Descending)) {
                Write-Host ("    {0,-26} {1}" -f $entry.Name, $entry.Value) -ForegroundColor DarkGray
            }
        }
    }
}

Write-Host ''
Write-Host '提示：Weixin 4.x 的会话列表/消息区通常是 List/ListControl + TextControl；输入框是 Edit/Document。' -ForegroundColor DarkGray
