#!/usr/bin/env node
/**
 * detect-wechat.mjs —— 探测本机的微信客户端，并给出「该怎么接」的判定。
 *
 * 为什么需要它：微信有两代完全不同的客户端，能不能注入 hook DLL 完全取决于这个：
 *
 *   家族          进程            版本线      公开 hook DLL
 *   WeChat 3.9.x  WeChat.exe      3.9.2.x …   有（WeChatFerry 的 sdk.dll，按版本发）
 *   Weixin 4.x    Weixin.exe      4.0 … 4.2   没有；UI 是 Qt 自绘，UIA 也读不到会话/消息
 *
 * 所以「一键注入」必须先探测，再决定走哪条路，而不是拿一个 DLL 硬怼。
 *
 * 输出（--json 时只有一行 JSON）：
 *   {
 *     ok, found, family: 'wechat3'|'weixin4'|null, exePath, version, arch,
 *     processName, running, pids: [...], windowVisible,
 *     strategy: 'wcferry-dll'|'unsupported'|'none',
 *     reason, alternatives: [...]
 *   }
 *
 * 用法：
 *   node native/detect-wechat.mjs            # 人读
 *   node native/detect-wechat.mjs --json     # 给插件/脚本消费
 */
import { readFileSync, statSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'

/* ── PE 头里读架构（不依赖 powershell，快且稳） ─────────────────────────── */
function readPeArch(exePath) {
  try {
    const fd = readFileSync(exePath)
    if (fd.length < 0x40 || fd.readUInt16LE(0) !== 0x5a4d) return 'unknown' // 'MZ'
    const peOffset = fd.readUInt32LE(0x3c)
    if (fd.length < peOffset + 6 || fd.readUInt32LE(peOffset) !== 0x00004550) return 'unknown' // 'PE\0\0'
    const machine = fd.readUInt16LE(peOffset + 4)
    if (machine === 0x8664) return 'x64'
    if (machine === 0x014c) return 'x86'
    if (machine === 0xaa64) return 'arm64'
    return `0x${machine.toString(16)}`
  } catch {
    return 'unknown'
  }
}

/* ── 一次 powershell 拿到：版本号、进程、窗口 ──────────────────────────── */
function powershellJson(script) {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout: 15000, windowsHide: true }, (error, stdout) => {
      const text = String(stdout ?? '').trim()
      if (!text) { resolve(undefined); return }
      try { resolve(JSON.parse(text)) } catch { resolve(undefined) }
    })
  })
}

const PROBE = `
$ErrorActionPreference = 'SilentlyContinue'
$out = @{}
$out.processes = @()
foreach ($name in @('WeChat','Weixin')) {
  $list = @(Get-Process -Name $name)
  foreach ($p in $list) {
    $out.processes += [pscustomobject]@{ name = $name; pid = $p.Id; window = [int64]$p.MainWindowHandle; title = [string]$p.MainWindowTitle }
  }
}
$out.install = @()
$keys = @('HKCU:\\Software\\Tencent\\WeChat','HKLM:\\SOFTWARE\\Tencent\\WeChat','HKLM:\\SOFTWARE\\WOW6432Node\\Tencent\\WeChat','HKCU:\\Software\\Tencent\\Weixin')
foreach ($key in $keys) {
  $item = Get-ItemProperty -Path $key
  if ($item -ne $null -and $item.InstallPath) { $out.install += [pscustomobject]@{ key = $key; path = [string]$item.InstallPath; version = [string]$item.Version } }
}
$out.versions = @{}
foreach ($candidate in @('C:\\Program Files\\Tencent\\WeChat\\WeChat.exe','C:\\Program Files (x86)\\Tencent\\WeChat\\WeChat.exe','C:\\Program Files\\Tencent\\Weixin\\Weixin.exe','C:\\Program Files (x86)\\Tencent\\Weixin\\Weixin.exe')) {
  if (Test-Path -LiteralPath $candidate) {
    $info = (Get-Item -LiteralPath $candidate).VersionInfo
    $out.versions[$candidate] = [string]$info.FileVersion
  }
}
$out | ConvertTo-Json -Depth 4 -Compress
`

const CANDIDATES = [
  { exePath: 'C:\\Program Files\\Tencent\\WeChat\\WeChat.exe', family: 'wechat3' },
  { exePath: 'C:\\Program Files (x86)\\Tencent\\WeChat\\WeChat.exe', family: 'wechat3' },
  { exePath: 'C:\\Program Files\\Tencent\\Weixin\\Weixin.exe', family: 'weixin4' },
  { exePath: 'C:\\Program Files (x86)\\Tencent\\Weixin\\Weixin.exe', family: 'weixin4' },
]

function exists(path) {
  try { return statSync(path).isFile() } catch { return false }
}

function normalizeVersion(raw) {
  const text = String(raw ?? '').trim()
  const match = /^(\d+\.\d+\.\d+\.\d+)/.exec(text)
  if (match) return match[1]
  const loose = /^(\d+\.\d+(?:\.\d+)?)/.exec(text)
  return loose ? loose[1] : ''
}

function strategyFor(family, version) {
  if (family === 'wechat3') {
    return {
      strategy: 'wcferry-dll',
      reason: `WeChat 3.9.x 有公开的 hook DLL（按版本发），用 native/wechat-inject.exe 注入后即可全功能`,
      alternatives: [],
    }
  }
  if (family === 'weixin4') {
    return {
      strategy: 'unsupported',
      reason: `Weixin ${version || '4.x'} 目前没有公开可用的 hook DLL；它的界面是 Qt 自绘（实测 UIA 只暴露 24 个节点，没有 List/Edit），
所以既不能注入、也不能用 UI Automation 读会话。`,
      alternatives: [
        '装一个微信 3.9.x（可与 4.x 共存，装到别的目录），用它的 WeChat.exe 走注入这条路',
        '走官方通道：公众号 / 企业微信 / 微信客服（本插件 kind=official / wecom 已支持）',
      ],
    }
  }
  return { strategy: 'none', reason: '没有找到微信客户端', alternatives: ['先安装微信（3.9.x 才能注入）'] }
}

const wantJson = process.argv.includes('--json')

const probe = await powershellJson(PROBE)

// 1) 找安装位置：注册表优先，其次常见路径
const found = []
for (const candidate of CANDIDATES) {
  if (exists(candidate.exePath)) found.push({ ...candidate, source: 'common-path' })
}
for (const entry of (probe?.install ?? [])) {
  const path = String(entry.path ?? '')
  if (!path) continue
  for (const exe of ['WeChat.exe', 'Weixin.exe']) {
    const full = join(path, exe)
    if (!exists(full)) continue
    const family = exe === 'WeChat.exe' ? 'wechat3' : 'weixin4'
    if (!found.some((item) => item.exePath.toLowerCase() === full.toLowerCase())) {
      found.push({ exePath: full, family, source: `registry:${entry.key}` })
    }
  }
}

// 2) 取版本：注册表版本 → 文件版本
const versionMap = probe?.versions ?? {}
for (const item of found) {
  const fromFile = normalizeVersion(versionMap[item.exePath])
  item.version = fromFile || normalizeVersion(item.family === 'wechat3' ? '3.9' : '4')
}
// 3.9.x 用注册表里的版本兜底（老客户端注册表有 Version）
for (const item of found) {
  if (item.version) continue
  const hit = (probe?.install ?? []).find((entry) => String(entry.path ?? '').toLowerCase().startsWith(dirname(item.exePath).toLowerCase()))
  if (hit) item.version = normalizeVersion(hit.version)
}

const processes = (probe?.processes ?? []).map((p) => ({
  name: String(p.name ?? ''),
  pid: Number(p.pid) || 0,
  window: Number(p.window) || 0,
  title: String(p.title ?? ''),
}))

// 4) 选一个候选：3.9.x 优先（能注入），否则 4.x
const pick = found.find((item) => item.family === 'wechat3') ?? found.find((item) => item.family === 'weixin4') ?? null
const verdict = pick ? strategyFor(pick.family, pick.version) : strategyFor(null, '')

const myProcesses = pick ? processes.filter((p) => p.name.toLowerCase() === (pick.family === 'wechat3' ? 'wechat' : 'weixin')) : []

const result = {
  ok: true,
  found: Boolean(pick),
  family: pick ? pick.family : null,
  exePath: pick ? pick.exePath : '',
  installSource: pick ? pick.source : '',
  version: pick ? pick.version : '',
  arch: pick ? readPeArch(pick.exePath) : 'unknown',
  processName: pick ? (pick.family === 'wechat3' ? 'WeChat.exe' : 'Weixin.exe') : '',
  running: myProcesses.length > 0,
  pids: myProcesses.map((p) => p.pid),
  windowVisible: myProcesses.some((p) => p.window !== 0),
  others: found.filter((item) => !pick || item.exePath !== pick.exePath).map((item) => ({ family: item.family, version: item.version, exePath: item.exePath })),
  ...verdict,
}

if (wantJson) {
  console.log(JSON.stringify(result))
  process.exit(result.found ? 0 : 3)
}

const line = (label, value) => console.log(`  ${label.padEnd(12)} ${value}`)
console.log('\n微信客户端探测\n')
line('安装', result.found ? '是' : '否')
if (result.found) {
  line('家族', result.family === 'wechat3' ? 'WeChat 3.9.x（可注入）' : 'Weixin 4.x（无可用 hook）')
  line('版本', result.version)
  line('架构', result.arch)
  line('路径', result.exePath)
  line('进程', result.running ? `${result.pids.join(', ')}（窗口${result.windowVisible ? '可见' : '不可见'}）` : '未运行')
}
line('判定', result.strategy)
console.log(`\n${result.reason}\n`)
if (result.alternatives.length > 0) {
  console.log('可行路线：')
  for (const item of result.alternatives) console.log(`  · ${item}`)
  console.log('')
}
if (result.others.length > 0) {
  console.log('其它客户端：')
  for (const item of result.others) console.log(`  · ${item.family} ${item.version} — ${item.exePath}`)
  console.log('')
}
process.exit(result.found ? 0 : 3)
