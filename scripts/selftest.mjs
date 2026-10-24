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
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

// 自检用独立状态文件，绝不碰真实 ~/.dsh/wechat-bridge/state.json
const STATE_FILE = join(tmpdir(), `wechat-bridge-selftest-${process.pid}.json`)
rmSync(STATE_FILE, { force: true })

const DSH_MODULES = 'file:///C:/Users/han/AppData/Local/Programs/DSH%20Desktop/resources/app/node_modules/@deepseek-ai/dsh-tools/lib/index.js'
const tools = await import(DSH_MODULES)

const { apply, name, inject } = await import(pathToFileURL(new URL('../index.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')).href)

let failures = 0
const ok = (label) => console.log(`  ✓ ${label}`)
const bad = (label, error) => {
  failures += 1
  console.error(`  ✗ ${label}\n    ${error?.stack ?? error}`)
}
const check = (label, fn) => {
  try {
    fn()
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
    async resolve(id) { return { id: id ?? 'standard' } },
    async acquireScope() { return { [Symbol.asyncDispose]: async () => {} } },
    async mount() {},
  },
  agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) },
  permissionPresets: { resolve() {}, set() {} },
  sessionTitle: { rename() {} },
}

// fetch 打桩
globalThis.fetch = async (url, init) => {
  sent.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined })
  return { ok: true, status: 200, text: async () => 'ok', json: async () => ({ errcode: 0 }) }
}

console.log(`\n[1] 激活 ${name}（inject=${JSON.stringify(inject)}）`)
const ctx = makeCtx(services)
check('apply() 不抛异常', () => apply(ctx, {
  gateway: { sendUrl: 'http://127.0.0.1:9999/send', sharedSecret: 'sekret' },
  reply: { autoReply: true, mode: 'raw', agentPreset: 'wechat-agent' },
  persona: { inject: true, scope: 'all' },
  stateFile: STATE_FILE,
  debug: false,
}))
check('注册了 12 个工具', () => assert.equal(registrations.tools.length, 12))
check('注册了 webhook 路由', () => assert.ok(webRoutes.has('/wechat/webhook')))
check('注册了状态路由', () => assert.ok(webRoutes.has('/wechat/webhook/status')))
check('注入了人格 md（全局 scope=all，且关闭模板插值）', () => {
  const persona = registrations.sections.find((s) => s.name === 'wechat-bridge/persona')
  assert.ok(persona, 'persona section missing')
  assert.ok(persona.text.length > 200, `persona too short: ${persona.text.length}`)
  assert.equal(persona.interpolate, false)
})
check('注册了 /wechat 命令', () => assert.equal(registrations.commands[0]?.name, 'wechat'))
check('监听了 session/event', () => assert.ok(registrations.listeners.some((l) => l.event === 'session/event')))

console.log('\n[2] 工具契约校验（用 harness 自己的校验器）')
for (const tool of registrations.tools) {
  check(`${tool.name}: 参数是合法 JSON Schema（object-rooted）`, () => {
    tools.assertSupportedJsonSchema(tool.parameters)
    assert.equal(tool.parameters.type, 'object')
  })
  check(`${tool.name}: 输出 schema 是合法 object-rooted 子集`, () => tools.assertObjectJsonSchema(tool.output.schema))
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
  check('缺 secret 时 401', () => assert.equal(unauthorized.statusCode, 401))

  const res = await deliverAck('/wechat/webhook', 'POST', { chatId: 'wxid_a', chatName: '阿黄', text: '在吗' }, { 'x-wechat-secret': 'sekret' })
  check('带 secret 时 200 且 accepted', () => {
    assert.equal(res.statusCode, 200)
    assert.equal(JSON.parse(res.body).accepted, true)
  })
  await new Promise((r) => setTimeout(r, 30))
  check('会话作用域又注入了一份人格（不污染其它会话）', () => {
    assert.equal(registrations.sections.filter((s) => s.name === 'wechat-bridge/persona').length, 2)
  })
  check('创建了 agent session 并 followup', () => {
    assert.equal(created.length, 1)
    assert.equal(followups.length, 1)
    assert.equal(created[0].meta.agentPreset, 'wechat-agent')
    assert.match(followups[0].content[0].text, /在吗/)
  })

  const statusRes = await deliverAck('/wechat/webhook/status', 'GET')
  check('状态路由报告入站 1', () => {
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
  check('turn 结束后原样投递回微信', () => {
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
  check('wechat_status 计数正确', () => {
    assert.equal(status.chats, 1)
    assert.equal(status.inbound, 1)
    assert.equal(status.outbound, 1)
  })

  const chats = await call('wechat_list_chats')
  check('wechat_list_chats 含 wxid_a', () => assert.equal(chats.chats[0].chatId, 'wxid_a'))

  const recent = await call('wechat_get_recent_messages', { chatId: 'wxid_a', limit: 10 })
  check('wechat_get_recent_messages 有进出两条', () => {
    assert.ok(recent.messages.length >= 2)
    assert.equal(recent.messages.at(-1).direction, 'out')
  })

  const unread = await call('wechat_get_unread_messages', { chatId: 'wxid_a' })
  check('未读 1 条且水位 0', () => {
    assert.equal(unread.unreadCount, 1)
    assert.equal(unread.readThroughSeq, 0)
  })

  const marked = await call('wechat_mark_read', { chatId: 'wxid_a', throughSeq: unread.messages[0].seq })
  check('mark_read 后未读清零', () => assert.equal(marked.unreadCount, 0))

  const sentOut = await call('wechat_send_message', { chatId: 'wxid_a', messages: ['第一句', '第二句'] })
  check('多段发送逐条投递', () => {
    assert.equal(sentOut.ok, true)
    assert.equal(sentOut.sent.length, 2)
    assert.equal(sent.filter((s) => s.body?.text === '第二句').length, 1)
  })

  await call('wechat_memory_append', { category: 'memberImpression', content: '爱用反问', target: '阿黄' })
  const mem = await call('wechat_memory_query', {})
  check('记忆写入/查询', () => assert.equal(mem.entries.length, 1))
  const removed = await call('wechat_memory_remove', { category: 'memberImpression', target: '阿黄' })
  check('记忆删除', () => assert.equal(removed.removed, 1))

  const members = await call('wechat_get_members', { chatId: 'wxid_a' })
  check('成员来自已知发言人', () => assert.ok(members.members.some((m) => m.userId === 'wxid_a')))

  const prompt = await call('wechat_get_prompt')
  check('get_prompt 带人格与工具清单', () => {
    assert.ok(prompt.persona.length > 200)
    assert.equal(prompt.tools.length, 12)
  })
})()

console.log('\n[5] 群聊白名单与 @ 过滤')
await (async () => {
  const res = await deliverAck('/wechat/webhook', 'POST', { chatId: 'room1', roomId: 'room1', kind: 'group', chatName: '测试群', text: '大家好', senderId: 'wxid_b', senderName: '小B' }, { 'x-wechat-secret': 'sekret' })
  check('群消息仍然入库', () => assert.equal(res.statusCode, 200))
  await new Promise((r) => setTimeout(r, 20))
  check('未配置 selfNames 时群消息也会唤醒 agent', () => assert.equal(created.length, 2))
})()

console.log('\n[6] 命令处理')
await (async () => {
  const command = registrations.commands[0]
  const offResult = await command.handler({ rawInput: 'off', agent: {}, attachments: [], signal: new AbortController().signal })
  check('/wechat off 关闭自动回复', () => assert.equal(offResult.kind, 'success'))
  const statusResult = await command.handler({ rawInput: 'status', agent: {}, attachments: [], signal: new AbortController().signal })
  check('/wechat status 返回摘要', () => assert.match(statusResult.text, /自动回复 关/))
})()

console.log('\n[7] 日志')
for (const line of logs) console.log(`  · ${line}`)

console.log(failures === 0 ? '\n全部通过 ✅\n' : `\n${failures} 项失败 ❌\n`)
process.exit(failures === 0 ? 0 : 1)
