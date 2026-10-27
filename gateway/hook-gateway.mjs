#!/usr/bin/env node
/**
 * hook-gateway.mjs —— 个人微信 hook 与 DSH 插件之间的网关（零依赖，单文件）。
 *
 * 为什么需要它：
 *   个人微信没有公开 API，真实接入靠本机 hook 服务（WeChatFerry / Gewechat / 自建）。
 *   这个网关把各种 hook 的差异收敛成插件认的两个端点：
 *
 *     GET  /messages?cursor=&limit=   拉增量消息
 *     POST /send                      发一条文本
 *     GET  /health                    探活（驱动是否就绪）
 *
 *   插件侧对应配置：
 *     kind: hook
 *     hook: { baseUrl: 'http://127.0.0.1:8788', secret: 'change-me', pollMs: 3000 }
 *
 * 驱动：
 *   mock —— 内置假微信。不需要装微信，用来端到端联调：
 *             POST /mock/push  {"chatId","senderName","text"}   造一条入站
 *             GET  /mock/out                                     看插件发出来的消息
 *   wcf  —— WeChatFerry 的 HTTP 封装（POST <base>/<method>，body {"args":[...]}）。
 *             默认方法名 get_msg / send_text，可用参数覆盖。
 *             不同 wcf-http 实现路径不一：用 --get-path / --send-path / --arg-style 适配。
 *   exec —— 直接调本地命令（示例：你自己的 python/bridge 脚本），约定 stdout 输出 JSON。
 *             --get-cmd "python bridge.py get {{cursor}} {{limit}}"
 *             --send-cmd "python bridge.py send {{chatId}} {{text}}"
 *             子命令里 {{...}} 会被替换成对应字段（已做 JSON/命令转义）。
 *
 * 用法：
 *   node gateway/hook-gateway.mjs --driver mock --port 8788 --secret change-me
 *   node gateway/hook-gateway.mjs --driver wcf --port 8788 --secret change-me --wcf-base http://127.0.0.1:9999
 *   node gateway/hook-gateway.mjs --driver exec --get-cmd "..." --send-cmd "..."
 *
 * 安全：默认只监听 127.0.0.1；配置了 --secret 时所有 /messages、/send 请求必须带 X-WeChat-Secret。
 */

import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const MAX_BODY = 1024 * 1024
const DEFAULT_LIMIT = 50

/* ── 参数解析 ───────────────────────────────────────────────────────────── */
function parseArgs(argv) {
  const options = {
    driver: 'mock',
    port: 8788,
    host: '127.0.0.1',
    secret: '',
    limit: DEFAULT_LIMIT,
    wcfBase: 'http://127.0.0.1:9999',
    getPath: '/{method}',
    sendPath: '/{method}',
    getMethod: 'get_msg',
    sendMethod: 'send_text',
    argStyle: 'args',
    getCmd: '',
    sendCmd: '',
    chatCacheMs: 30000,
    verbose: false,
  }
  const map = {
    '--driver': 'driver',
    '--port': 'port',
    '--host': 'host',
    '--secret': 'secret',
    '--limit': 'limit',
    '--wcf-base': 'wcfBase',
    '--get-path': 'getPath',
    '--send-path': 'sendPath',
    '--get-method': 'getMethod',
    '--send-method': 'sendMethod',
    '--arg-style': 'argStyle',
    '--get-cmd': 'getCmd',
    '--send-cmd': 'sendCmd',
    '--chat-cache-ms': 'chatCacheMs',
  }
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--verbose' || token === '-v') { options.verbose = true; continue }
    if (token === '--help' || token === '-h') { options.help = true; continue }
    const key = map[token]
    if (!key) throw new Error(`未知参数：${token}（--help 看用法）`)
    const value = argv[index + 1]
    if (value === undefined) throw new Error(`${token} 需要一个值`)
    index += 1
    if (key === 'port' || key === 'limit' || key === 'chatCacheMs') options[key] = Number(value)
    else options[key] = value
  }
  return options
}

const HELP = `
hook-gateway —— 个人微信 hook → DSH 插件的适配网关

  node gateway/hook-gateway.mjs --driver mock --port 8788 --secret change-me
  node gateway/hook-gateway.mjs --driver wcf  --port 8788 --secret change-me --wcf-base http://127.0.0.1:9999
  node gateway/hook-gateway.mjs --driver exec --get-cmd "python bridge.py get {{cursor}} {{limit}}" --send-cmd "python bridge.py send {{chatId}} {{text}}"

端点
  GET  /health                      {"ok":true,"driver":"mock"}
  GET  /messages?cursor=&limit=     {"ok":true,"cursor":"…","messages":[{id,chatId,kind,senderId,senderName,text,time}]}
  POST /send                        {"chatId":"…","text":"…"} → {"ok":true,"id":"…"}
  POST /mock/push                   （仅 mock）{"chatId","senderName","text"} 造一条入站
  GET  /mock/out                    （仅 mock）查看插件发出来的消息

参数
  --driver mock|wcf|exec      默认 mock
  --port / --host             默认 8788 / 127.0.0.1
  --secret                    配置后所有 /messages /send 必须带 X-WeChat-Secret
  --wcf-base                  WeChatFerry HTTP 基地址
  --get-path / --send-path    路径模板，{method} 会被替换（默认 /{method}）
  --get-method / --send-method 默认 get_msg / send_text
  --arg-style args|params     POST body 形态：{"args":[…]} 或 {"params":{…}}
  --get-cmd / --send-cmd      exec 驱动的命令模板，{{cursor}} {{limit}} {{chatId}} {{text}} 会替换
  --limit                     单次默认条数（默认 50）
  -v, --verbose               打印每条请求
`

/* ── 工具函数 ───────────────────────────────────────────────────────────── */
const now = () => Date.now()

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function shellQuote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`
}

function template(value, fields) {
  let out = String(value)
  for (const [key, raw] of Object.entries(fields)) {
    out = out.split(`{{${key}}}`).join(String(raw ?? ''))
  }
  return out
}

function runCommand(command, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    execFile(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
      process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) { reject(new Error(`${error.message}${stderr ? ` :: ${String(stderr).slice(0, 300)}` : ''}`)); return }
        resolve(String(stdout))
      })
  })
}

/* ── 驱动：mock ─────────────────────────────────────────────────────────── */
function createMockDriver() {
  /** 序号即游标：单调递增，插件按 cursor 拉增量。 */
  let seq = 0
  const inbox = []   // 待插件拉走的入站消息
  const outbox = []  // 插件发出来的消息
  const pull = (cursor, limit) => {
    const from = cursor === '' || cursor === undefined ? 0 : Number(cursor)
    const start = Number.isFinite(from) ? Math.max(0, from) : 0
    const batch = inbox.filter((message) => message.seq > start).slice(0, limit)
    const next = batch.length > 0 ? batch[batch.length - 1].seq : start
    return { ok: true, cursor: String(next), messages: batch.map(({ seq: _seq, ...rest }) => rest) }
  }
  return {
    name: 'mock',
    async health() { return { ok: true, driver: 'mock', inbox: inbox.length, outbox: outbox.length } },
    pull,
    async send({ chatId, text, replyToMessageId }) {
      const record = { id: randomUUID(), chatId, text, replyToMessageId: replyToMessageId ?? null, at: now() }
      outbox.push(record)
      if (outbox.length > 500) outbox.shift()
      return { ok: true, id: record.id }
    },
    push(body) {
      seq += 1
      const message = {
        seq,
        id: `mock-${seq}`,
        chatId: String(body.chatId ?? body.from ?? 'wxid_mock'),
        chatName: String(body.chatName ?? body.fromName ?? body.chatId ?? 'mock'),
        kind: body.kind === 'group' ? 'group' : 'private',
        senderId: String(body.senderId ?? body.from ?? body.chatId ?? 'wxid_mock'),
        senderName: String(body.senderName ?? 'mock'),
        text: String(body.text ?? ''),
        time: now(),
      }
      inbox.push(message)
      if (inbox.length > 1000) inbox.shift()
      return message
    },
    outbox,
  }
}

/* ── 驱动：WeChatFerry HTTP ─────────────────────────────────────────────── */
function createWcfDriver(options) {
  const base = options.wcfBase.replace(/\/+$/, '')
  // 常见 wcferry get_msg 返回里，roomid 为群 id、sender 为发言人、content 为正文
  const call = async (method, args) => {
    const path = template(method === options.getMethod ? options.getPath : options.sendPath, { method })
    const url = `${base}${path.startsWith('/') ? path : `/${path}`}`
    const body = options.argStyle === 'params'
      ? { params: args }
      : { args: Array.isArray(args) ? args : [args] }
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`wcf ${method} HTTP ${response.status}: ${text.slice(0, 300)}`)
    if (text.trim() === '') return undefined
    try { return JSON.parse(text) } catch { return text }
  }

  /** 缓存群名/联系人名，避免每条消息都查一次。 */
  let names = new Map()
  let namesAt = 0
  const nameOf = async (wxid) => {
    if (now() - namesAt > options.chatCacheMs) {
      namesAt = now()
      try {
        const contacts = await call('get_contacts', [])
        const list = Array.isArray(contacts) ? contacts : (contacts?.data ?? []) 
        names = new Map(list.map((item) => [String(item.wxid ?? item.userName ?? ''), String(item.name ?? item.nick ?? '')]))
      } catch {
        names = new Map()
      }
    }
    return names.get(wxid) ?? wxid
  }

  let cursorSeq = 0
  return {
    name: 'wcf',
    async health() { return { ok: true, driver: 'wcf', base } },
    async pull(_cursor, limit) {
      const raw = await call(options.getMethod, [])
      const list = Array.isArray(raw) ? raw : (raw?.data ?? raw?.messages ?? [])
      const fresh = []
      for (const item of list) {
        const id = String(item.id ?? item.msgid ?? item.seq ?? '')
        if (!id) continue
        if (cursorSeq > 0 && Number(item.seq ?? 0) <= cursorSeq) continue
        cursorSeq = Math.max(cursorSeq, Number(item.seq ?? 0) || cursorSeq)
        const roomId = String(item.roomid ?? item.room_id ?? '')
        const senderId = String(item.sender ?? item.wxid ?? item.from ?? '')
        const isRoom = roomId !== '' && roomId !== 'null'
        fresh.push({
          id,
          chatId: isRoom ? roomId : senderId,
          chatName: isRoom ? await nameOf(roomId) : await nameOf(senderId),
          kind: isRoom ? 'group' : 'private',
          senderId,
          senderName: await nameOf(senderId),
          text: String(item.content ?? item.text ?? ''),
          time: Number(item.ts ?? item.time ?? 0) * (String(item.ts ?? '').length <= 10 ? 1000 : 1) || now(),
        })
        if (fresh.length >= limit) break
      }
      return { ok: true, cursor: String(cursorSeq), messages: fresh }
    },
    async send({ chatId, text }) {
      await call(options.sendMethod, [chatId, text])
      return { ok: true, id: `wcf-${randomUUID()}` }
    },
  }
}

/* ── 驱动：exec（把任何本地 hook 脚本包一层） ────────────────────────────── */
function createExecDriver(options) {
  if (!options.getCmd || !options.sendCmd) throw new Error('exec 驱动需要 --get-cmd 与 --send-cmd')
  return {
    name: 'exec',
    async health() { return { ok: true, driver: 'exec' } },
    async pull(cursor, limit) {
      const command = template(options.getCmd, { cursor: shellQuote(cursor ?? ''), limit })
      const stdout = await runCommand(command)
      const parsed = stdout.trim() ? JSON.parse(stdout) : {}
      const messages = Array.isArray(parsed) ? parsed : (parsed.messages ?? [])
      return { ok: true, cursor: String(parsed.cursor ?? cursor ?? ''), messages }
    },
    async send({ chatId, text }) {
      const command = template(options.sendCmd, { chatId: shellQuote(chatId), text: shellQuote(text) })
      const stdout = await runCommand(command)
      return { ok: true, id: stdout.trim().slice(0, 200) || `exec-${randomUUID()}` }
    },
  }
}

/* ── 服务 ───────────────────────────────────────────────────────────────── */
export function createGateway(options) {
  const driver = options.driver === 'wcf'
    ? createWcfDriver(options)
    : options.driver === 'exec'
      ? createExecDriver(options)
      : createMockDriver()

  const authorized = (req) => {
    if (!options.secret) return true
    return req.headers['x-wechat-secret'] === options.secret
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
    const route = `${req.method} ${url.pathname}`
    if (options.verbose) console.log(`[${new Date().toISOString()}] ${route}`)
    try {
      if (url.pathname === '/health' && req.method === 'GET') {
        json(res, 200, { ok: true, ...(await driver.health()) })
        return
      }
      if (url.pathname === '/messages' && req.method === 'GET') {
        if (!authorized(req)) { json(res, 401, { ok: false, error: 'bad secret' }); return }
        const cursor = url.searchParams.get('cursor') ?? ''
        const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') ?? options.limit) || options.limit))
        json(res, 200, await driver.pull(cursor, limit))
        return
      }
      if (url.pathname === '/send' && req.method === 'POST') {
        if (!authorized(req)) { json(res, 401, { ok: false, error: 'bad secret' }); return }
        const raw = await readBody(req)
        let body
        try { body = raw.trim() ? JSON.parse(raw) : {} } catch { json(res, 400, { ok: false, error: 'invalid json' }); return }
        const chatId = String(body.chatId ?? body.to ?? '')
        const text = String(body.text ?? '')
        if (!chatId || !text) { json(res, 400, { ok: false, error: 'chatId and text are required' }); return }
        const outcome = await driver.send({ chatId, text, replyToMessageId: body.replyToMessageId, atUserId: body.atUserId })
        json(res, 200, outcome)
        return
      }
      if (url.pathname === '/mock/push' && req.method === 'POST') {
        if (typeof driver.push !== 'function') { json(res, 404, { ok: false, error: 'mock driver only' }); return }
        const raw = await readBody(req)
        let body
        try { body = raw.trim() ? JSON.parse(raw) : {} } catch { json(res, 400, { ok: false, error: 'invalid json' }); return }
        json(res, 200, { ok: true, message: driver.push(body) })
        return
      }
      if (url.pathname === '/mock/out' && req.method === 'GET') {
        if (typeof driver.push !== 'function') { json(res, 404, { ok: false, error: 'mock driver only' }); return }
        json(res, 200, { ok: true, messages: driver.outbox.slice(-50).reverse() })
        return
      }
      json(res, 404, { ok: false, error: `unknown route ${route}` })
    } catch (error) {
      if (options.verbose) console.error('gateway error:', error)
      json(res, 500, { ok: false, error: String(error?.message ?? error).slice(0, 300) })
    }
  })

  return { server, driver }
}

/* ── 入口 ───────────────────────────────────────────────────────────────── */
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  let options
  try {
    options = parseArgs(process.argv)
  } catch (error) {
    console.error(error.message)
    process.exit(2)
  }
  if (options.help) { console.log(HELP); process.exit(0) }
  let gateway
  try {
    gateway = createGateway(options)
  } catch (error) {
    console.error(`启动失败：${error?.message ?? error}`)
    process.exit(1)
  }
  gateway.server.listen(options.port, options.host, () => {
    console.log(`hook-gateway [${gateway.driver.name}] listening on http://${options.host}:${options.port}`)
    console.log(`  插件配置：kind: hook / hook.baseUrl: http://${options.host}:${options.port}${options.secret ? ` / hook.secret: ${options.secret}` : ''}`)
    if (gateway.driver.name === 'mock') {
      console.log('  造一条入站： curl -X POST http://' + options.host + ':' + options.port + '/mock/push -H "content-type: application/json" -d "{\\"chatId\\":\\"wxid_demo\\",\\"text\\":\\"在吗\\"}"')
    }
  })
  gateway.server.on('error', (error) => {
    console.error(`监听失败：${error?.message ?? error}`)
    process.exit(1)
  })
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      console.log(`\n${signal} → 关闭`)
      gateway.server.close(() => process.exit(0))
    })
  }
}

export { createMockDriver, createWcfDriver, createExecDriver, parseArgs }
