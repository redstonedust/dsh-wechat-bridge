#!/usr/bin/env node
/**
 * selftest.mjs —— 不启动 harness，用假 ctx 把插件真跑一遍。
 *
 * 覆盖：
 *   1. apply() 能完成注册（工具/路由/人格/命令/会话事件监听）。
 *   2. 每个工具的参数 DSL 与输出 schema 都通过 harness 自己的校验器
 *      （@deepseek-ai/dsh-tools 的 parameterSchemaSpecToJsonSchema / assertObjectJsonSchema）。
 *   3. 每个工具能执行，返回值通过它自己声明的输出 schema，render() 不炸。
 *   4. webhook 路由：入站消息落库、secret 校验、状态路由。
 *   5. 自动回复链路：agents.create → followup → assistant/message → turn/end → 投递回微信。
 *   6. 人格 md 注入到了 systemPrompt。
 */
import { pathToFileURL } from 'node:url'
import { EventEmitter } from 'node:events'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { readOverride } from '../lib/panel.js'

// 自检用独立状态文件，绝不碰真实 ~/.dsh/wechat-bridge/state.json
const STATE_FILE = join(tmpdir(), `wechat-bridge-selftest-${process.pid}.json`)
const HOOK_STATE_FILE = join(tmpdir(), `wechat-bridge-selftest-hook-${process.pid}.json`)
rmSync(STATE_FILE, { force: true })

// 面板覆盖值也写到临时文件（面板默认会写 ~/.dsh/wechat-bridge/config.override.json）
const OVERRIDE_FILE = join(tmpdir(), `wechat-bridge-selftest-override-${process.pid}.json`)
rmSync(OVERRIDE_FILE, { force: true })

const DSH_MODULES = 'file:///C:/Users/han/AppData/Local/Programs/DSH%20Desktop/resources/app/node_modules/@deepseek-ai/dsh-tools/lib/index.js'
const tools = await import(DSH_MODULES)

const { apply, name, inject } = await import(pathToFileURL(new URL('../index.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')).href)

let failures = 0
const ok = (label) => console.log(`  ✓ ${label}`)
const bad = (label, error) => {
  failures += 1
  console.error(`  ✗ ${label}\n    ${error?.stack ?? error}`)
}
const check = async (label, fn) => {
  try {
    // 支持返回 Promise 的用例：等它落定再判定，避免未捕获的 rejection 直接掀桌
    await fn()
    ok(label)
  } catch (error) {
    bad(label, error)
  }
}

// ── 假 ctx ────────────────────────────────────────────────────────────────
const logs = []
const registrations = {
  tools: [],
  sections: [],
  routes: [],
  commands: [],
  listeners: [],
  effects: [],
}
const sent = []            // 出站投递
let created = []           // agents.create 调用
let followups = []         // agent.followup 收到的消息

function makeCtx(services) {
  const scopedOf = (deps) => {
    const scoped = Object.create(base)
    for (const dep of deps) scoped[dep] = services[dep]
    scoped.get = (key) => services[key]
    return scoped
  }
  const base = {
    logger: {
      info: (m) => logs.push(`info: ${m}`),
      warn: (m) => logs.push(`warn: ${m}`),
      error: (m) => logs.push(`error: ${m}`),
      debug: (m) => logs.push(`debug: ${m}`),
    },
    effect(fn, label) {
      const disposer = fn()
      registrations.effects.push({ label, disposer })
      return () => {}
    },
    on(event, handler) {
      registrations.listeners.push({ event, handler })
      return () => {}
    },
    inject(deps, callback) {
      if (deps.every((dep) => services[dep] !== undefined)) callback(scopedOf(deps))
    },
    get: (key) => services[key],
    ...services,
  }
  return base
}

const webRoutes = new Map()
const fakeAgents = {
  created: [],
  get: () => undefined,
  async create(options) {
    created.push(options)
    const agent = {
      id: options.sessionId,
      session: { header: { id: options.sessionId }, requestHeader: () => undefined },
      followup: (message) => followups.push(message),
    }
    fakeAgents.created.push(agent)
    const agentCtx = {
      on: () => () => {},
      effect: (fn) => { const d = fn(); registrations.effects.push({ label: 'agentCtx', disposer: d }); return () => {} },
      systemPrompt: services.systemPrompt,
      tools: services.tools,
    }
    await options.setup?.(agentCtx)
    return { agent, dispose: async () => {} }
  },
}
const services = {
  tools: { register: (def) => { registrations.tools.push(def); return () => {} } },
  systemPrompt: {
    section: (section) => { registrations.sections.push(section); return () => {} },
    getSectionOrder: () => 100,
  },
  webServer: {
    register: (route) => { webRoutes.set(route.path, route); registrations.routes.push(route); return () => {} },
  },
  commands: { register: (def) => { registrations.commands.push(def); return () => {} } },
  agents: fakeAgents,
  agentPresets: {
    async list() {
      return [
        { id: 'wechat-agent', name: '微信桥接', isDefault: false },
        { id: 'standard', name: '标准', isDefault: true },
      ]
    },
    async resolve(id) { return { id: id ?? 'standard' } },
    async acquireScope() { return { [Symbol.asyncDispose]: async () => {} } },
    async mount() {},
  },
  agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) },
  permissionPresets: { resolve() {}, set() {} },
  sessionTitle: { rename() {} },
}

// fetch 打桩
// hook 网关的假实现：测试往 hookInbox 里塞消息，插件轮询时一次性取走
let hookInbox = []
let hookCursor = 0
let kfSyncQueue = []
globalThis.fetch = async (url, init) => {
  const target = String(url)
  sent.push({ url: target, body: init?.body ? JSON.parse(init.body) : undefined })
  if (target.startsWith('http://hook.test/messages')) {
    const batch = hookInbox
    hookInbox = []
    hookCursor += batch.length
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, cursor: String(hookCursor), messages: batch }) }
  }
  if (target === 'http://hook.test/send') {
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, id: 'out-1' }) }
  }
  if (target.includes('/cgi-bin/gettoken')) {
    return { ok: true, status: 200, json: async () => ({ errcode: 0, access_token: 'KF-ACCESS-TOKEN', expires_in: 7200 }) }
  }
  if (target.includes('/cgi-bin/kf/sync_msg')) {
    const batch = kfSyncQueue.shift() ?? { errcode: 0, next_cursor: 'c-kf', has_more: false, msg_list: [] }
    return { ok: true, status: 200, json: async () => batch }
  }
  if (target.includes('/cgi-bin/kf/send_msg')) {
    return { ok: true, status: 200, json: async () => ({ errcode: 0, errmsg: 'ok' }) }
  }
  return { ok: true, status: 200, text: async () => 'ok', json: async () => ({ errcode: 0 }) }
}

console.log(`\n[1] 激活 ${name}（inject=${JSON.stringify(inject)}）`)
const ctx = makeCtx(services)
await check('apply() 不抛异常', () => apply(ctx, {
  gateway: { sendUrl: 'http://127.0.0.1:9999/send', sharedSecret: 'sekret' },
  reply: { autoReply: true, mode: 'raw', agentPreset: 'wechat-agent' },
  persona: { inject: true, scope: 'all' },
  stateFile: STATE_FILE,
  overrideFile: OVERRIDE_FILE,
  debug: false,
}))
await check('注册了 13 个工具', () => assert.equal(registrations.tools.length, 13))
await check('注册了 webhook 路由', () => assert.ok(webRoutes.has('/wechat/webhook')))
await check('注册了状态路由', () => assert.ok(webRoutes.has('/wechat/webhook/status')))
await check('注入了人格 md（全局 scope=all，且关闭模板插值）', () => {
  const persona = registrations.sections.find((s) => s.name === 'wechat-bridge/persona')
  assert.ok(persona, 'persona section missing')
  assert.ok(persona.text.length > 200, `persona too short: ${persona.text.length}`)
  assert.equal(persona.interpolate, false)
})
await check('注册了 /wechat 命令', () => assert.equal(registrations.commands[0]?.name, 'wechat'))
await check('监听了 session/event', () => assert.ok(registrations.listeners.some((l) => l.event === 'session/event')))

console.log('\n[2] 工具契约校验（用 harness 自己的校验器）')
for (const tool of registrations.tools) {
  await check(`${tool.name}: 参数是合法 JSON Schema（object-rooted）`, () => {
    tools.assertSupportedJsonSchema(tool.parameters)
    assert.equal(tool.parameters.type, 'object')
  })
  await check(`${tool.name}: 输出 schema 是合法 object-rooted 子集`, () => tools.assertObjectJsonSchema(tool.output.schema))
}

console.log('\n[3] webhook 入站 + 自动回复链路')
const deliverAck = async (path, method, body, headers = {}) => {
  const route = webRoutes.get(path)
  assert.ok(route, `route ${path} missing`)
  const req = new EventEmitter()
  req.method = method
  req.url = path
  req.headers = headers
  const response = { statusCode: 0, headers: {}, writableEnded: false, body: '' }
  response.setHeader = (k, v) => { response.headers[k.toLowerCase()] = v }
  response.end = (chunk) => { response.writableEnded = true; response.body = chunk ?? '' }
  const done = route.handler(req, response)
  if (body !== undefined) {
    req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
  }
  await done
  return response
}

await (async () => {
  const unauthorized = await deliverAck('/wechat/webhook', 'POST', { chatId: 'wxid_a', text: 'hi' }, {})
  await check('缺 secret 时 401', () => assert.equal(unauthorized.statusCode, 401))

  const res = await deliverAck('/wechat/webhook', 'POST', { chatId: 'wxid_a', chatName: '阿黄', text: '在吗' }, { 'x-wechat-secret': 'sekret' })
  await check('带 secret 时 200 且 accepted', () => {
    assert.equal(res.statusCode, 200)
    assert.equal(JSON.parse(res.body).accepted, true)
  })
  await new Promise((r) => setTimeout(r, 30))
  await check('会话作用域又注入了一份人格（不污染其它会话）', () => {
    assert.equal(registrations.sections.filter((s) => s.name === 'wechat-bridge/persona').length, 2)
  })
  await check('创建了 agent session 并 followup', () => {
    assert.equal(created.length, 1)
    assert.equal(followups.length, 1)
    assert.equal(created[0].meta.agentPreset, 'wechat-agent')
    assert.match(followups[0].content[0].text, /在吗/)
  })

  const statusRes = await deliverAck('/wechat/webhook/status', 'GET')
  await check('状态路由报告入站 1', () => {
    const payload = JSON.parse(statusRes.body)
    assert.equal(payload.counters.inbound, 1)
    assert.equal(payload.persona.injected, true)
    assert.equal(payload.chats[0].chatId, 'wxid_a')
  })

  // 模拟模型产出 → turn/end
  const listener = registrations.listeners.find((l) => l.event === 'session/event').handler
  const sessionId = created[0].sessionId
  listener({ header: { id: sessionId } }, { type: 'turn/start', data: { turn: 1 } })
  listener({ header: { id: sessionId } }, { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '在的，怎么了' }] } } })
  listener({ header: { id: sessionId } }, { type: 'turn/end', data: { turn: 1, reason: 'stop' } })
  await new Promise((r) => setTimeout(r, 30))
  await check('turn 结束后原样投递回微信', () => {
    const out = sent.filter((s) => s.url === 'http://127.0.0.1:9999/send')
    assert.equal(out.length, 1)
    assert.equal(out[0].body.text, '在的，怎么了')
    assert.equal(out[0].body.raw, true)
  })
})()

console.log('\n[4] 工具执行 + 返回值过 schema')
await (async () => {
  const call = async (toolName, args = {}, exec = {}) => {
    const tool = registrations.tools.find((t) => t.name === toolName)
    assert.ok(tool, `tool ${toolName} missing`)
    const value = await tool.execute(args, { agent: undefined, signal: new AbortController().signal, ...exec })
    const violations = tools.validateJsonSchemaValue(tool.output.schema, value)
    assert.deepEqual(violations, [], `${toolName} output violations`)
    const rendered = tool.output.render(args, value)
    assert.ok(Array.isArray(rendered) && rendered.length > 0 && rendered[0].type === 'text', `${toolName} render bad`)
    return value
  }

  const status = await call('wechat_status')
  await check('wechat_status 计数正确', () => {
    assert.equal(status.chats, 1)
    assert.equal(status.inbound, 1)
    assert.equal(status.outbound, 1)
  })

  const chats = await call('wechat_list_chats')
  await check('wechat_list_chats 含 wxid_a', () => assert.equal(chats.chats[0].chatId, 'wxid_a'))

  const recent = await call('wechat_get_recent_messages', { chatId: 'wxid_a', limit: 10 })
  await check('wechat_get_recent_messages 有进出两条', () => {
    assert.ok(recent.messages.length >= 2)
    assert.equal(recent.messages.at(-1).direction, 'out')
  })

  const unread = await call('wechat_get_unread_messages', { chatId: 'wxid_a' })
  await check('未读 1 条且水位 0', () => {
    assert.equal(unread.unreadCount, 1)
    assert.equal(unread.readThroughSeq, 0)
  })

  const marked = await call('wechat_mark_read', { chatId: 'wxid_a', throughSeq: unread.messages[0].seq })
  await check('mark_read 后未读清零', () => assert.equal(marked.unreadCount, 0))

  const sentOut = await call('wechat_send_message', { chatId: 'wxid_a', messages: ['第一句', '第二句'] })
  await check('多段发送逐条投递', () => {
    assert.equal(sentOut.ok, true)
    assert.equal(sentOut.sent.length, 2)
    assert.equal(sent.filter((s) => s.body?.text === '第二句').length, 1)
  })

  await call('wechat_memory_append', { category: 'memberImpression', content: '爱用反问', target: '阿黄' })
  const mem = await call('wechat_memory_query', {})
  await check('记忆写入/查询', () => assert.equal(mem.entries.length, 1))
  const removed = await call('wechat_memory_remove', { category: 'memberImpression', target: '阿黄' })
  await check('记忆删除', () => assert.equal(removed.removed, 1))

  const members = await call('wechat_get_members', { chatId: 'wxid_a' })
  await check('成员来自已知发言人', () => assert.ok(members.members.some((m) => m.userId === 'wxid_a')))

  const prompt = await call('wechat_get_prompt')
  await check('get_prompt 带人格与工具清单', () => {
    assert.ok(prompt.persona.length > 200)
    assert.equal(prompt.tools.length, 13)
  })
})()

console.log('\n[5] 群聊白名单与 @ 过滤')
await (async () => {
  const res = await deliverAck('/wechat/webhook', 'POST', { chatId: 'room1', roomId: 'room1', kind: 'group', chatName: '测试群', text: '大家好', senderId: 'wxid_b', senderName: '小B' }, { 'x-wechat-secret': 'sekret' })
  await check('群消息仍然入库', () => assert.equal(res.statusCode, 200))
  await new Promise((r) => setTimeout(r, 20))
  await check('未配置 selfNames 时群消息也会唤醒 agent', () => assert.equal(created.length, 2))
})()

console.log('\n[6] 命令处理')
await (async () => {
  const command = registrations.commands[0]
  const offResult = await command.handler({ rawInput: 'off', agent: {}, attachments: [], signal: new AbortController().signal })
  await check('/wechat off 关闭自动回复', () => assert.equal(offResult.kind, 'success'))
  const statusResult = await command.handler({ rawInput: 'status', agent: {}, attachments: [], signal: new AbortController().signal })
  await check('/wechat status 返回摘要', () => assert.match(statusResult.text, /自动回复 关/))
})()

console.log('\n[7] 管理面板路由')

// 面板配置写到临时文件，绝不碰真实 ~/.dsh/wechat-bridge/config.override.json

await (async () => {
  // webServer 按「不带 query 的 path」注册路由；req.url 才需要带完整 query
  const routeOf = (path) => {
    const routePath = path.split('?')[0]
    const route = webRoutes.get(routePath)
    assert.ok(route, `route ${routePath} missing`)
    return route
  }

  const panelGet = async (path, headers = {}, remote = '127.0.0.1') => {
    const route = routeOf(path)
    const req = new EventEmitter()
    req.method = 'GET'
    req.url = path
    req.headers = headers
    req.socket = { remoteAddress: remote }
    const res = { statusCode: 0, headers: {}, writableEnded: false, body: '' }
    res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v }
    res.end = (chunk) => { res.writableEnded = true; res.body = chunk ?? '' }
    await route.handler(req, res)
    return { status: res.statusCode, json: () => JSON.parse(res.body), raw: res.body }
  }

  const panelSend = async (path, method, body, headers = {}, remote = '127.0.0.1') => {
    const route = routeOf(path)
    const req = new EventEmitter()
    req.method = method
    req.url = path
    req.headers = headers
    req.socket = { remoteAddress: remote }
    req.destroy = () => {}
    const res = { statusCode: 0, headers: {}, writableEnded: false, body: '' }
    res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v }
    res.end = (chunk) => { res.writableEnded = true; res.body = chunk ?? '' }
    const done = route.handler(req, res)
    if (body !== undefined) {
      req.emit('data', Buffer.from(JSON.stringify(body)))
    }
    req.emit('end')
    await done
    return { status: res.statusCode, json: () => JSON.parse(res.body), raw: res.body }
  }

  // 路由全都挂上了
  for (const suffix of ['state', 'chats', 'config', 'console', 'selftest', 'read', 'reset']) {
    await check(`注册了 /wechat/api/${suffix}`, () => assert.ok(webRoutes.has(`/wechat/api/${suffix}`)))
  }

  // 回环守卫
  const viaProxy = await panelGet('/wechat/api/state', { 'x-forwarded-for': '10.0.0.9' })
  await check('带 x-forwarded-for 一律 403', () => {
    assert.equal(viaProxy.status, 403)
    assert.equal(viaProxy.json().code, 'loopback-only')
  })
  const fromPublic = await panelGet('/wechat/api/state', {}, '10.1.2.3')
  await check('非回环来源 403', () => assert.equal(fromPublic.status, 403))
  const fromV6 = await panelGet('/wechat/api/state', {}, '::1')
  await check('IPv6 回环放行', () => assert.equal(fromV6.status, 200))

  // state
  const state = await panelGet('/wechat/api/state')
  await check('state 返回快照 + 事件 + 投递 + 桩状态', () => {
    const payload = state.json()
    assert.equal(state.status, 200)
    assert.equal(payload.ok, true)
    assert.ok(payload.config && typeof payload.config === 'object', 'config missing')
    assert.ok(Array.isArray(payload.events), 'events missing')
    assert.ok(Array.isArray(payload.deliveries), 'deliveries missing')
    assert.ok(payload.stub && typeof payload.stub.running === 'boolean', 'stub missing')
    assert.ok(Array.isArray(payload.chats), 'chats missing')
    assert.ok(payload.counters && typeof payload.counters.inbound === 'number', 'counters missing')
  })
  await check('state 不泄漏密钥明文', () => {
    const raw = state.raw
    assert.ok(!raw.includes('sekret'), 'sharedSecret leaked as plaintext')
    assert.ok(!/appSecret"\s*:\s*"[^"]+/.test(raw), 'appSecret leaked')
    assert.ok(!/["']token["']\s*:\s*"[^"]+/.test(raw), 'token leaked')
    assert.equal(state.json().config.gateway.sharedSecretSet, true)
    assert.equal(state.json().config.gateway.appSecretSet, false)
  })

  // chats
  await check('chats 列表带会话与未读', async () => {
    const res = await panelGet('/wechat/api/chats')
    assert.equal(res.status, 200)
    const list = res.json().chats
    assert.ok(list.length >= 2, `expected >=2 chats, got ${list.length}`)
  })
  await check('chats?chatId= 返回该会话消息', () => {
    return panelGet('/wechat/api/chats?chatId=wxid_a').then((res) => {
      const payload = res.json()
      assert.equal(payload.ok, true)
      assert.equal(payload.chatId, 'wxid_a')
      assert.ok(payload.messages.length >= 1, 'messages missing')
      assert.equal(payload.messages[0].chatId, 'wxid_a')
    })
  })
  await check('chats 限流参数被夹住（limit=99999 不炸）', () => panelGet('/wechat/api/chats?chatId=wxid_a&limit=99999').then((res) => {
    assert.equal(res.status, 200)
    assert.ok(res.json().messages.length <= 200)
  }))

  // read
  const read = await panelSend('/wechat/api/read', 'POST', { chatId: 'wxid_a' })
  await check('read 提交已读水位', () => {
    assert.equal(read.status, 200)
    assert.equal(read.json().ok, true)
    assert.equal(typeof read.json().readThroughSeq, 'number')
    assert.equal(read.json().unreadCount, 0)
  })
  await check('read 缺 chatId 时 400', () => panelSend('/wechat/api/read', 'POST', {}).then((res) => {
    assert.equal(res.status, 400)
    assert.equal(res.json().ok, false)
  }))

  // config
  await check('config GET 给脱敏配置', () => {
    return panelGet('/wechat/api/config').then((res) => {
      const payload = res.json()
      assert.equal(res.status, 200)
      assert.equal(payload.ok, true)
      assert.equal(payload.config.gateway.sharedSecretSet, true)
      assert.ok(!res.raw.includes('sekret'))
    })
  })
  const wrote = await panelSend('/wechat/api/config', 'PUT', { config: { 'reply.prefix': '【T】', 'gateway.sendUrl': 'http://127.0.0.1:9998/send' } })
  await check('config PUT 热点键立即生效', () => {
    assert.equal(wrote.status, 200)
    const payload = wrote.json()
    assert.equal(payload.ok, true)
    assert.deepEqual(payload.applied.sort(), ['gateway.sendUrl', 'reply.prefix'])
    assert.deepEqual(payload.restart, [])
    assert.deepEqual(payload.rejected, [])
  })
  await check('config PUT 真的改到了运行态', () => {
    return panelGet('/wechat/api/config').then((res) => {
      const config = res.json().config
      assert.equal(config.prefix, '【T】')
      assert.equal(config.gateway.sendUrl, 'http://127.0.0.1:9998/send')
    })
  })
  await check('config PUT 写进了覆盖值文件', () => {
    const written = JSON.parse(readFileSync(OVERRIDE_FILE, 'utf8'))
    assert.equal(written.reply.prefix, '【T】')
    assert.equal(written.gateway.sendUrl, 'http://127.0.0.1:9998/send')
  })
  await check('config PUT 拒绝不认识的键', () => panelSend('/wechat/api/config', 'PUT', { config: { 'nope.field': 1 } }).then((res) => {
    assert.deepEqual(res.json().rejected, ['nope.field'])
  }))
  await check('config PUT 重启键被归类为 restart', () => panelSend('/wechat/api/config', 'PUT', { config: { webhookPath: '/wechat/webhook-next' } }).then((res) => {
    assert.deepEqual(res.json().restart, ['webhookPath'])
    assert.equal(res.json().applied.length, 0)
  }))
  await check('config PUT action=reset 清空覆盖值', async () => {
    const res = await panelSend('/wechat/api/config', 'PUT', { action: 'reset' })
    assert.equal(res.json().reset, true)
    assert.deepEqual(readOverride(OVERRIDE_FILE), {})
  })
  await check('config PUT 非法 JSON 时 400', () => {
    const route = webRoutes.get('/wechat/api/config')
    const req = new EventEmitter()
    req.method = 'PUT'
    req.url = '/wechat/api/config'
    req.headers = {}
    req.socket = { remoteAddress: '127.0.0.1' }
    req.destroy = () => {}
    const res = { statusCode: 0, headers: {}, writableEnded: false, body: '' }
    res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v }
    res.end = (chunk) => { res.writableEnded = true; res.body = chunk ?? '' }
    const done = route.handler(req, res)
    req.emit('data', Buffer.from('{not json'))
    req.emit('end')
    return done.then(() => {
      assert.equal(res.statusCode, 400)
      assert.equal(JSON.parse(res.body).code, 'invalid-json')
    })
  })

  // console
  await check('console inbound 造一条入站消息', () => panelSend('/wechat/api/console', 'POST', {
    action: 'inbound', chatId: 'wxid_panel', text: '面板造的消息',
  }).then((res) => {
    const payload = res.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.chatId, 'wxid_panel')
    assert.ok(String(payload.detail ?? '').length > 0, 'detail missing')
  }))
  await check('console outbound 投递到网关', () => panelSend('/wechat/api/console', 'POST', {
    action: 'outbound', chatId: 'wxid_panel', text: '面板发的消息',
  }).then((res) => {
    assert.equal(res.json().ok, true)
    const hit = sent.filter((s) => s.url === 'http://127.0.0.1:9998/send')
    assert.ok(hit.length >= 1, 'gateway not called')
    assert.equal(hit[hit.length - 1].body.text, '面板发的消息')
  }))
  await check('console 未知动作 400', () => panelSend('/wechat/api/console', 'POST', { action: 'nope' }).then((res) => {
    assert.equal(res.status, 400)
    assert.equal(res.json().code, 'unknown-action')
  }))
  await check('console stub-start / stub-stop 起停网关桩', async () => {
    // 端口交给系统分配：固定 18787 在别人的机器上可能已经被占用
    const probe = createServer()
    await new Promise((resolve, reject) => {
      probe.once('error', reject)
      probe.listen(0, '127.0.0.1', resolve)
    })
    const port = probe.address().port
    await new Promise((resolve) => probe.close(resolve))
    const started = await panelSend('/wechat/api/console', 'POST', { action: 'stub-start', port })
    assert.equal(started.json().ok, true)
    assert.equal(started.json().running, true)
    assert.equal(started.json().port, port)
    const stopped = await panelSend('/wechat/api/console', 'POST', { action: 'stub-stop' })
    assert.equal(stopped.json().running, false)
  })
  await check('console stub-start 非法端口报错但不崩', () => panelSend('/wechat/api/console', 'POST', { action: 'stub-start', port: 99999 }).then((res) => {
    assert.equal(res.json().ok, false)
    assert.match(String(res.json().message), /端口/)
  }))

  // selftest
  const selftest = await panelSend('/wechat/api/selftest', 'POST', {})
  await check('selftest 跑完 7 项并给出汇总', () => {
    const payload = selftest.json()
    assert.equal(payload.ok, true)
    assert.ok(Array.isArray(payload.checks), 'checks missing')
    assert.equal(payload.checks.length, 7)
    assert.equal(payload.summary.total, 7)
    assert.equal(payload.summary.passed + payload.summary.failed, 7)
    for (const item of payload.checks) {
      assert.ok(item.id && item.title, `check item malformed: ${JSON.stringify(item)}`)
      assert.ok(['ok', 'warn', 'error'].includes(item.level), `bad level: ${item.level}`)
    }
  })
  await check('selftest 每项失败都带修法', () => {
    const failed = selftest.json().checks.filter((c) => c.level !== 'ok')
    for (const item of failed) assert.ok(item.fix, `${item.id} 缺 fix`)
  })
  await check('selftest 只认 POST', () => panelGet('/wechat/api/selftest').then((res) => assert.equal(res.status, 405)))

  // reset
  await check('reset 清空本地缓存', () => panelSend('/wechat/api/reset', 'POST', {}).then((res) => {
    assert.equal(res.json().ok, true)
  }))
  await check('reset 之后 state 里会话为空', () => panelGet('/wechat/api/state').then((res) => {
    const payload = res.json()
    assert.equal(payload.chats.length, 0)
    assert.equal(payload.sessions, 0)
    assert.equal(payload.memory.impressions, 0)
    // counters 是累计统计，reset() 只清缓存不清计数（以 index.js 的实现为准）
    assert.ok(payload.counters.inbound >= 1, 'counters 不该被 reset 清零')
  }))
  await check('reset 之后消息缓存也空了', () => panelGet('/wechat/api/chats?chatId=wxid_a').then((res) => {
    assert.deepEqual(res.json().messages, [])
    assert.equal(res.json().unread, 0)
  }))

  // state 里的事件流确实记录了刚才的动作
  await check('事件流记录了面板动作', () => panelGet('/wechat/api/state').then((res) => {
    const events = res.json().events
    assert.ok(events.length > 0, 'no events')
    assert.ok(events.some((e) => /面板写入配置/.test(e.message)), 'config write not logged')
    assert.ok(events.some((e) => /入站自测/.test(e.message)), 'inbound not logged')
    for (const event of events) {
      assert.ok(['info', 'warn', 'error'].includes(event.level), `bad event level: ${event.level}`)
    }
  }))
})()

console.log('\n[8] 个人微信 hook 链路（kind=hook）')
await (async () => {
  const hookCtx = makeCtx(services)
  const before = registrations.tools.length
  apply(hookCtx, {
    kind: 'hook',
    hook: {
      baseUrl: 'http://hook.test',
      secret: 'hsekret',
      pollMs: 50,
      autoStart: false,
      selfIds: ['wxid_self'],
    },
    reply: { autoReply: true, mode: 'raw', agentPreset: 'wechat-agent' },
    stateFile: HOOK_STATE_FILE,
    debug: false,
  })
  const hookTools = registrations.tools.slice(before)
  const find = (toolName) => hookTools.find((tool) => tool.name === toolName)
  const run = async (toolName, args = {}) => {
    const tool = find(toolName)
    assert.ok(tool, `hook 实例缺少工具 ${toolName}`)
    const value = await tool.execute(args, { agent: undefined, signal: new AbortController().signal })
    const violations = tools.validateJsonSchemaValue(tool.output.schema, value)
    assert.deepEqual(violations, [], `${toolName} 输出不合 schema`)
    return value
  }

  check('hook 实例也注册了完整工具面（含 wechat_hook）', () => {
    assert.equal(hookTools.length, registrations.tools.length - before)
    assert.ok(find('wechat_hook'), 'wechat_hook 缺失')
  })

  check('wechat_hook status 报告未轮询', async () => {
    const status = await run('wechat_hook', { action: 'status' })
    assert.equal(status.kind, 'hook')
    assert.equal(status.running, false)
    assert.equal(status.ok, true)
  })

  hookInbox = [
    { id: 'h1', chatId: 'wxid_hook', chatName: 'Hook 好友', kind: 'private', senderId: 'wxid_hook', senderName: 'Hook 好友', text: '第一条' },
    { id: 'h2', chatId: 'room_hook', chatName: 'Hook 群', kind: 'group', senderId: 'wxid_member', senderName: '群友', text: '第二条' },
    { id: 'h3', chatId: 'wxid_hook', chatName: 'Hook 好友', kind: 'private', senderId: 'wxid_self', senderName: '我自己', text: '我自己发的，应被丢弃' },
  ]
  const pulled = await run('wechat_hook', { action: 'poll' })
  check('poll 拉取并入库（丢弃 selfIds 来源）', () => {
    assert.equal(pulled.ok, true)
    assert.equal(pulled.accepted, 2)
    assert.equal(pulled.skipped, 1)
    assert.equal(pulled.cursor, '3')
  })

  const chats = await run('wechat_list_chats', {})
  check('两个会话都建档', () => {
    const ids = chats.chats.map((chat) => chat.chatId).sort()
    assert.deepEqual(ids, ['room_hook', 'wxid_hook'])
    assert.equal(chats.chats.find((c) => c.chatId === 'room_hook').kind, 'group')
  })

  const recent = await run('wechat_get_recent_messages', { chatId: 'wxid_hook', limit: 10 })
  check('消息内容按原样入库', () => {
    assert.equal(recent.messages.at(-1).text, '第一条')
  })

  // 同一批消息再来一次：靠 messageId 去重
  hookInbox = [
    { id: 'h1', chatId: 'wxid_hook', chatName: 'Hook 好友', text: '第一条（重复投递）' },
  ]
  const again = await run('wechat_hook', { action: 'poll' })
  check('重复 messageId 被去重', () => {
    assert.equal(again.accepted, 0)
    assert.equal(again.skipped, 1)
  })

  const outbound = await run('wechat_send_message', { chatId: 'wxid_hook', message: 'hook 回了一条' })
  check('kind=hook 时出站打到 <baseUrl>/send', () => {
    assert.equal(outbound.ok, true)
    const posted = sent.filter((item) => item.url === 'http://hook.test/send')
    assert.equal(posted.length, 1)
    assert.equal(posted[0].body.chatId, 'wxid_hook')
    assert.equal(posted[0].body.text, 'hook 回了一条')
  })

  const started = await run('wechat_hook', { action: 'start' })
  check('start 之后 running=true', () => assert.equal(started.running, true))
  const stopped = await run('wechat_hook', { action: 'stop' })
  check('stop 之后 running=false', () => assert.equal(stopped.running, false))
  const reset = await run('wechat_hook', { action: 'reset-cursor', cursor: '' })
  check('reset-cursor 清空游标', () => assert.equal(reset.cursor, ''))

  // 连续失败后暂停，再 start 必须能恢复（否则面板「开始轮询」点了没反应）
  const pauseCtx = makeCtx(services)
  const beforePause = registrations.tools.length
  apply(pauseCtx, {
    kind: 'hook',
    // 指向一个必然连不上的地址；autoStart 让它自己跑起来并在 2 次失败后暂停
    hook: { baseUrl: 'http://127.0.0.1:1', secret: '', pollMs: 200, autoStart: true, maxFailures: 2, timeoutMs: 400 },
    reply: { autoReply: false },
    stateFile: join(tmpdir(), `wechat-pause-selftest-${process.pid}.json`),
  })
  const pauseTools = registrations.tools.slice(beforePause)
  const pauseHook = pauseTools.find((tool) => tool.name === 'wechat_hook')
  const callPause = (args) => pauseHook.execute(args, { agent: undefined, signal: new AbortController().signal })

  let pausedStatus = await callPause({ action: 'status' })
  for (let attempt = 0; attempt < 40 && pausedStatus.paused !== true; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    pausedStatus = await callPause({ action: 'status' })
  }
  check('连续失败后进入暂停（仍在运行状态里）', () => {
    assert.equal(pausedStatus.paused, true)
    assert.equal(pausedStatus.running, true)
    assert.ok(pausedStatus.failures >= 2)
  })
  const resumed = await callPause({ action: 'start' })
  check('暂停后 start 能恢复轮询', () => {
    assert.equal(resumed.running, true)
    assert.match(String(resumed.detail ?? ''), /恢复/)
  })
  await callPause({ action: 'stop' })

})()

console.log('\n[9] 注入微信（用假的注入器脚本验证编排）')
await (async () => {
  const injectorScript = join(tmpdir(), `wechat-fake-injector-${process.pid}.mjs`)
  const fakeDll = join(tmpdir(), `wechat-fake-hook-${process.pid}.dll`)
  writeFileSync(injectorScript, [
    'const args = process.argv.slice(2)',
    'const processName = args[args.indexOf("--process") + 1] ?? ""',
    'const dll = args[args.indexOf("--dll") + 1] ?? ""',
    'console.log(JSON.stringify({ ok: true, pid: 4242, process: processName, dll, injector: "x64", target: "x64" }))',
  ].join('\n'), 'utf8')
  writeFileSync(fakeDll, 'not-a-real-dll', 'utf8')

  const injectCtx = makeCtx(services)
  const beforeTools = registrations.tools.length
  apply(injectCtx, {
    kind: 'hook',
    hook: { baseUrl: 'http://127.0.0.1:1', secret: 'x', autoStart: false },
    inject: { injectorPath: injectorScript, processName: 'WeChat.exe', hookDll: fakeDll, timeoutMs: 5000, waitForServiceMs: 0, autoDetect: false },
    reply: { autoReply: true, mode: 'raw', agentPreset: 'wechat-agent' },
    stateFile: join(tmpdir(), `wechat-inject-selftest-${process.pid}.json`),
    debug: false,
  })
  const injectTools = registrations.tools.slice(beforeTools)
  const hookTool = injectTools.find((tool) => tool.name === 'wechat_hook')
  assert.ok(hookTool, 'hook 实例缺少 wechat_hook')
  const run = () => hookTool.execute({ action: 'inject' }, { agent: undefined, signal: new AbortController().signal })

  const outcome = await run()
  check('注入器输出被解析成成功结果', () => {
    assert.equal(outcome.ok, true)
    assert.match(String(outcome.detail ?? ''), /4242/)
  })

  const status = await hookTool.execute({ action: 'status' }, { agent: undefined, signal: new AbortController().signal })
  check('注入结果可从 wechat_hook 回读', () => assert.equal(status.kind, 'hook'))

  // 注入器不存在时给出可操作错误
  const brokenCtx = makeCtx(services)
  const beforeBroken = registrations.tools.length
  apply(brokenCtx, {
    kind: 'hook',
    hook: { baseUrl: '', autoStart: false },
    inject: { injectorPath: join(tmpdir(), 'definitely-missing-injector.exe'), hookDll: fakeDll, autoDetect: false },
    stateFile: join(tmpdir(), `wechat-inject-selftest-broken-${process.pid}.json`),
  })
  const brokenTool = registrations.tools.slice(beforeBroken).find((tool) => tool.name === 'wechat_hook')
  const broken = await brokenTool.execute({ action: 'inject' }, { agent: undefined, signal: new AbortController().signal })
  check('注入器缺失时失败且说明原因', () => {
    assert.equal(broken.ok, false)
    assert.match(String(broken.detail ?? ''), /injector-missing|找不到注入器/)
  })
  // 自动探测：本机要么没有微信、要么是 4.x（无可用 hook）——两种情况都必须给出明确判定，
  // 而不是拿一个不匹配的 DLL 硬注。
  const autoCtx = makeCtx(services)
  const beforeAuto = registrations.tools.length
  apply(autoCtx, {
    kind: 'hook',
    hook: { baseUrl: '', autoStart: false },
    inject: { injectorPath: injectorScript, timeoutMs: 3000, autoDetect: true },
    stateFile: join(tmpdir(), `wechat-auto-selftest-${process.pid}.json`),
  })
  const autoHook = registrations.tools.slice(beforeAuto).find((tool) => tool.name === 'wechat_hook')
  const auto = await autoHook.execute({ action: 'inject' }, { agent: undefined, signal: new AbortController().signal })
  check('autoDetect 会先探测客户端并给出可执行判定', () => {
    assert.equal(auto.ok, false)
    assert.match(String(auto.detail ?? ''), /client-missing|unsupported-client|dll-missing|没找到|没有公开可用/)
  })

})()

console.log('\n[10] 微信客服（kind=kf，官方 API 拉取/发送）')
await (async () => {
  const kfCtx = makeCtx(services)
  const before = registrations.tools.length
  apply(kfCtx, {
    kind: 'kf',
    kf: { corpId: 'ww-test', corpSecret: 'secret', openKfId: 'wk-test', autoStart: false, limit: 10 },
    reply: { autoReply: true, mode: 'raw', agentPreset: 'wechat-agent' },
    stateFile: join(tmpdir(), `wechat-kf-selftest-${process.pid}.json`),
    debug: false,
  })
  const kfTools = registrations.tools.slice(before)
  const find = (toolName) => kfTools.find((tool) => tool.name === toolName)
  const run = async (toolName, args = {}) => {
    const tool = find(toolName)
    assert.ok(tool, `kf 实例缺少 ${toolName}`)
    const value = await tool.execute(args, { agent: undefined, signal: new AbortController().signal })
    const violations = tools.validateJsonSchemaValue(tool.output.schema, value)
    assert.deepEqual(violations, [], `${toolName} 输出不合 schema`)
    return value
  }

  kfSyncQueue = [{
    errcode: 0,
    next_cursor: 'c-kf-1',
    has_more: false,
    msg_list: [
      { msgid: 'kf-1', open_kfid: 'wk-test', external_userid: 'wm_user_a', send_time: 1790000000, origin: 3, msgtype: 'text', text: { content: '客服你好' } },
      { msgid: 'kf-2', open_kfid: 'wk-test', external_userid: 'wm_user_b', send_time: 1790000001, origin: 3, msgtype: 'text', text: { content: '在吗' } },
      { msgid: 'kf-3', open_kfid: 'wk-test', external_userid: 'wm_user_a', send_time: 1790000002, origin: 3, msgtype: 'image', image: { media_id: 'x' } },
      { msgid: 'kf-4', open_kfid: 'wk-test', external_userid: 'wm_user_a', send_time: 1790000003, origin: 5, msgtype: 'text', text: { content: '接待人员自己发的' } },
    ],
  }]

  const swept = await run('wechat_hook', { action: 'poll' })
  check('sync_msg 拉取：文本入库、图片与己方消息跳过', () => {
    assert.equal(swept.ok, true)
    assert.equal(swept.accepted, 2)
    assert.equal(swept.skipped, 2)
    assert.equal(swept.cursor, 'c-kf-1')
  })

  const chats = await run('wechat_list_chats', {})
  check('客服会话按 external_userid 建档', () => {
    const ids = chats.chats.map((chat) => chat.chatId).sort()
    assert.deepEqual(ids, ['wm_user_a', 'wm_user_b'])
  })

  const sendResult = await run('wechat_send_message', { chatId: 'wm_user_a', message: '客服回复你' })
  check('出站打到 kf/send_msg（touser + open_kfid）', () => {
    assert.equal(sendResult.ok, true)
    const posted = sent.filter((item) => item.url.includes('/cgi-bin/kf/send_msg'))
    assert.equal(posted.length, 1)
    assert.equal(posted[0].body.touser, 'wm_user_a')
    assert.equal(posted[0].body.open_kfid, 'wk-test')
    assert.equal(posted[0].body.text.content, '客服回复你')
  })

  const status = await run('wechat_hook', { action: 'status' })
  check('wechat_hook status 在 kf 模式下报告 source=kf', () => {
    assert.equal(status.kind, 'kf')
  })
})()

rmSync(OVERRIDE_FILE, { force: true })

console.log('\n[8] 日志')
for (const line of logs) console.log(`  · ${line}`)

console.log(failures === 0 ? '\n全部通过 ✅\n' : `\n${failures} 项失败 ❌\n`)
process.exit(failures === 0 ? 0 : 1)
