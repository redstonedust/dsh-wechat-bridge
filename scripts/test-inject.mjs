#!/usr/bin/env node
/**
 * test-inject.mjs —— 插件侧「注入微信」编排 against **真实注入器**（native/build/wechat-inject.exe）。
 *
 * 和 native/test-inject.ps1 的分工：
 *   - native/test-inject.ps1 测注入器本体（C 代码、JSON 契约、退出码）。
 *   - 这个测试测**插件的编排**：spawn 注入器 → 解析 JSON → 落盘 last → 回读状态；
 *     顺带证明「点一下按钮就注入」这条链路在真实二进制上成立。
 *
 * 没有产物（没跑过 native/build.ps1）时自动跳过，退出码 0 —— 不给没装 gcc 的环境添堵。
 *
 * 用法: node scripts/test-inject.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const injector = join(root, 'native', 'build', 'wechat-inject.exe')
const payload = join(root, 'native', 'build', 'test-payload.dll')
const target = join(root, 'native', 'build', 'test-target.exe')
const markerDir = join(root, 'native', 'build', 'selftest-tmp')

let failures = 0
const ok = (label) => console.log(`  ok   ${label}`)
const bad = (label, error) => { failures += 1; console.error(`  FAIL ${label}\n       ${error?.message ?? error}`) }
const skip = (label) => console.log(`  skip ${label}`)
const check = async (label, fn) => {
  try { await fn(); ok(label) } catch (error) { bad(label, error) }
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

if (![injector, payload, target].every((file) => existsSync(file))) {
  console.log('\n跳过：没有 native/build 产物（先跑 native/build.ps1）\n')
  process.exit(0)
}
mkdirSync(markerDir, { recursive: true })

/* ── 极简假 ctx：只提供插件注入路径会用到的服务 ───────────────────────── */
const tools = []
const services = {
  tools: { register: (definition) => { tools.push(definition); return () => {} } },
  systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 },
  webServer: { register: () => () => {} },
  commands: { register: () => () => {} },
  agents: {
    get: () => undefined,
    async create(options) {
      const agent = { id: options.sessionId, session: { header: { id: options.sessionId } }, followup: () => {} }
      await options.setup?.({ effect: (fn) => fn(), on: () => () => {}, systemPrompt: services.systemPrompt, tools: services.tools })
      return { agent, dispose: async () => {} }
    },
  },
  agentPresets: { async resolve(id) { return { id: id ?? 'wechat-agent' } }, async acquireScope() { return { [Symbol.asyncDispose]: async () => {} } }, async mount() {} },
  agentDefaultModel: { currentSelection: () => ({ provider: 'x', model: 'y' }) },
  permissionPresets: { resolve() {}, set() {} },
  sessionTitle: { rename() {} },
}

const makeCtx = () => {
  const scopedOf = (deps) => {
    const scoped = Object.create(base)
    for (const dep of deps) scoped[dep] = services[dep]
    scoped.get = (key) => services[key]
    return scoped
  }
  const base = {
    logger: { info: () => {}, warn: (m) => console.error('   warn:', m), error: (m) => console.error('   err:', m), debug: () => {} },
    effect(fn) { const disposer = fn(); return () => {} },
    on() { return () => {} },
    inject(deps, callback) { if (deps.every((dep) => services[dep] !== undefined)) callback(scopedOf(deps)) },
    get: (key) => services[key],
    ...services,
  }
  return base
}

const stateFile = join(tmpdir(), `wechat-inject-test-${process.pid}.json`)
rmSync(stateFile, { force: true })

apply(makeCtx(), {
  kind: 'hook',
  hook: { baseUrl: '', autoStart: false },
  inject: { injectorPath: injector, processName: 'test-target.exe', hookDll: payload, timeoutMs: 10000, waitForServiceMs: 0 },
  reply: { autoReply: true, mode: 'raw', agentPreset: 'wechat-agent' },
  stateFile,
  debug: false,
})

const tool = tools.find((item) => item.name === 'wechat_hook')
const run = (args) => tool.execute(args, { agent: undefined, signal: new AbortController().signal })

console.log('\n插件侧注入编排（真实 wechat-inject.exe）\n')

if (!tool) {
  console.error('  FAIL 没有拿到 wechat_hook 工具（插件的服务注册方式变了？）')
  process.exit(1)
}

let targetProcess
try {
  targetProcess = spawn(target, [], {
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, TEMP: markerDir, TMP: markerDir },
  })
  await sleep(800)

  await check('注入到真实靶子进程（解析 JSON 里的 pid）', async () => {
    const outcome = await run({ action: 'inject' })
    assert.equal(outcome.ok, true, `注入失败：${outcome.detail ?? ''}`)
    assert.match(String(outcome.detail ?? ''), new RegExp(String(targetProcess.pid)), '返回的 pid 应是靶子进程')
  })

  await check('靶子进程里出现 marker（DLL 真的被加载）', async () => {
    const marker = join(markerDir, `wechat-inject-selftest-${targetProcess.pid}.txt`)
    let found = false
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (existsSync(marker)) { found = true; break }
      await sleep(100)
    }
    assert.ok(found, `没看到 marker：${marker}`)
  })

  await check('注入结果落盘并可回读（wechat_hook status）', async () => {
    const status = await run({ action: 'status' })
    assert.equal(status.kind, 'hook')
    assert.equal(status.ok, true)
  })

  await check('目标进程不存在时给出可操作错误', async () => {
    // 再起一个插件实例，指向不存在的进程名
    const before = tools.length
    apply(makeCtx(), {
      kind: 'hook',
      hook: { baseUrl: '', autoStart: false },
      inject: { injectorPath: injector, processName: 'definitely-not-running.exe', hookDll: payload, timeoutMs: 8000 },
      stateFile: join(tmpdir(), `wechat-inject-test-missing-${process.pid}.json`),
      debug: false,
    })
    const missingTool = tools.slice(before).find((item) => item.name === 'wechat_hook')
    const outcome = await missingTool.execute({ action: 'inject' }, { agent: undefined, signal: new AbortController().signal })
    assert.equal(outcome.ok, false)
    assert.match(String(outcome.detail ?? ''), /process-not-found|找不到/)
  })
} finally {
  if (targetProcess && !targetProcess.killed) targetProcess.kill()
  rmSync(stateFile, { force: true })
}

console.log(failures === 0 ? '\n全部通过 ✅\n' : `\n${failures} 项失败 ❌\n`)
process.exit(failures === 0 ? 0 : 1)
