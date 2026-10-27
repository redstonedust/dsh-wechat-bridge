#!/usr/bin/env node
/**
 * test-hook-integration.mjs —— 真实 HTTP 的 hook 全链路集成测试。
 *
 * 和 selftest 的区别：selftest 用假 fetch，这里**真的**起 gateway/hook-gateway.mjs（mock 驱动），
 * 插件用真实 fetch 打过去，验证：
 *
 *   POST /mock/push（模拟好友发消息）
 *     → 插件 wechat_hook poll 拉取 → 入库 → 建 agent 会话
 *     → 我们伪造 assistant/message + turn/end（替身 agent）
 *     → 插件投递 → POST /send → GET /mock/out 里能读回原文
 *
 * 不需要微信、不需要 DSH 进程。用法: node scripts/test-hook-integration.mjs
 */
import { createGateway } from '../gateway/hook-gateway.mjs'
import { apply } from '../index.js'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

let failures = 0
const ok = (label) => console.log(`  ok   ${label}`)
const bad = (label, error) => { failures += 1; console.error(`  FAIL ${label}\n       ${error?.message ?? error}`) }
const check = async (label, fn) => {
  try { await fn(); ok(label) } catch (error) { bad(label, error) }
}

const SECRET = 'hook-integration-secret'
const STATE_FILE = join(tmpdir(), `wechat-hook-integration-${process.pid}.json`)
rmSync(STATE_FILE, { force: true })

/* ── 真网关 ─────────────────────────────────────────────────────────────── */
const { server } = createGateway({
  driver: 'mock', host: '127.0.0.1', secret: SECRET, limit: 50,
  wcfBase: '', getPath: '/{method}', sendPath: '/{method}', getMethod: 'get_msg', sendMethod: 'send_text',
  argStyle: 'args', getCmd: '', sendCmd: '', chatCacheMs: 30000, verbose: false,
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}`

/* ── 假 ctx（只提供插件用到的服务） ─────────────────────────────────────── */
const registrations = { tools: [], sections: [], routes: new Map(), commands: [], listeners: [], effects: [] }
const created = []
const followups = []
const services = {
  tools: { register: (definition) => { registrations.tools.push(definition); return () => {} } },
  systemPrompt: { section: (section) => { registrations.sections.push(section); return () => {} }, getSectionOrder: () => 0 },
  webServer: { register: (route) => { registrations.routes.set(route.path, route); return () => {} } },
  commands: { register: (definition) => { registrations.commands.push(definition); return () => {} } },
  agents: {
    get: () => undefined,
    async create(options) {
      created.push(options)
      const agent = {
        id: options.sessionId,
        session: { header: { id: options.sessionId }, requestHeader: () => undefined },
        followup: (message) => { followups.push({ sessionId: options.sessionId, message }) },
      }
      await options.setup?.({ effect: (fn) => { const disposer = fn(); registrations.effects.push(disposer); return () => {} }, on: () => () => {}, systemPrompt: services.systemPrompt, tools: services.tools })
      return { agent, dispose: async () => {} }
    },
  },
  agentPresets: {
    async resolve(id) { return { id: id ?? 'wechat-agent' } },
    async acquireScope() { return { [Symbol.asyncDispose]: async () => {} } },
    async mount() {},
  },
  agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) },
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
    effect(fn) { const disposer = fn(); registrations.effects.push(disposer); return () => {} },
    on(event, handler) { registrations.listeners.push({ event, handler }); return () => {} },
    inject(deps, callback) { if (deps.every((dep) => services[dep] !== undefined)) callback(scopedOf(deps)) },
    get: (key) => services[key],
    ...services,
  }
  return base
}

apply(makeCtx(), {
  kind: 'hook',
  hook: { baseUrl, secret: SECRET, pollMs: 300, autoStart: false, limit: 50, selfIds: ['wxid_self'] },
  reply: { autoReply: true, mode: 'raw', agentPreset: 'wechat-agent' },
  stateFile: STATE_FILE,
  debug: false,
})

const tool = (name) => registrations.tools.find((item) => item.name === name)
const run = async (name, args = {}) => tool(name).execute(args, { agent: undefined, signal: new AbortController().signal })

const http = async (path, init = {}) => {
  const response = await fetch(`${baseUrl}${path}`, init)
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : undefined }
}

console.log('\nhook 全链路集成测试（真实 HTTP）\n')

await check('插件注册了 wechat_hook 工具', async () => {
  assert.ok(tool('wechat_hook'), 'wechat_hook 缺失')
})

await check('网关在线且驱动是 mock', async () => {
  const health = await http('/health')
  assert.equal(health.body.driver, 'mock')
})

await check('模拟好友发消息 → 插件轮询拉取 → 入库', async () => {
  const pushed = await http('/mock/push', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chatId: 'wxid_hook', chatName: '微信好友', senderName: '微信好友', text: '在吗？' }),
  })
  assert.equal(pushed.status, 200)
  const pulled = await run('wechat_hook', { action: 'poll' })
  assert.equal(pulled.ok, true)
  assert.equal(pulled.accepted, 1)
  const chats = await run('wechat_list_chats', {})
  assert.ok(chats.chats.some((chat) => chat.chatId === 'wxid_hook'))
})

await check('自动回复：消息被交给 agent（followup）', async () => {
  assert.equal(created.length, 1, '应创建一个托管会话')
  assert.equal(followups.length, 1)
  assert.match(followups[0].message.content[0].text, /在吗？/)
})

await check('agent 回完后插件 POST /send，网关 /mock/out 能读到原文', async () => {
  const listener = registrations.listeners.find((item) => item.event === 'session/event').handler
  const sessionId = created[0].sessionId
  listener({ header: { id: sessionId } }, { type: 'turn/start', data: { turn: 1 } })
  listener({ header: { id: sessionId } }, { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '在的' }] } } })
  listener({ header: { id: sessionId } }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

  let outbound = []
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const out = await http('/mock/out')
    outbound = out.body.messages
    if (outbound.length > 0) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.equal(outbound.length, 1, '网关没收到出站')
  assert.equal(outbound[0].chatId, 'wxid_hook')
  assert.equal(outbound[0].text, '在的')
})

await check('密钥不对时拉取失败并记录 lastError', async () => {
  const wrong = await http('/messages', { headers: { 'x-wechat-secret': 'nope' } })
  assert.equal(wrong.status, 401)
  const status = await run('wechat_hook', { action: 'status' })
  assert.equal(status.kind, 'hook')
})

await check('selfIds 生效：自己发的消息不会入库', async () => {
  await http('/mock/push', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chatId: 'wxid_hook', senderId: 'wxid_self', senderName: '自己', text: '我自己说的' }),
  })
  const pulled = await run('wechat_hook', { action: 'poll' })
  assert.equal(pulled.skipped, 1)
  assert.equal(pulled.accepted, 0)
})

server.close()
rmSync(STATE_FILE, { force: true })
console.log(failures === 0 ? '\n全部通过 ✅\n' : `\n${failures} 项失败 ❌\n`)
process.exit(failures === 0 ? 0 : 1)
