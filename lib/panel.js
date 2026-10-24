/**
 * dsh-wechat-bridge · 统一管理面板后端。
 *
 * 把原来散在 scripts/ 里的三件事收进一个面板：
 *   check.ps1                    → POST <api>/selftest（一键体检）
 *   scenario-a-local-gateway.ps1 → POST <api>/console + 内置网关桩（入站/出站自测）
 *   scenario-b/c-*.ps1           → PUT  <api>/config（切 kind、开关自动回复、写凭据）
 *
 * 约定：
 *   - 只注册不扫描，路由由调用方 ctx.effect 持有，插件卸载即失效。
 *   - 不写用户的 profile patch：面板改的值落到
 *     ~/.dsh/wechat-bridge/config.override.json，apply 时合并进配置，
 *     重启后仍生效，也不会破坏人家手写的 YAML。
 *   - 能热改的字段（sendUrl/secret/自动回复/预设/名单…）直接改 runtime；
 *     绑死的只提示需要重载。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const OVERRIDE_FILE = join(homedir(), '.dsh', 'wechat-bridge', 'config.override.json')

const MAX_BODY = 256 * 1024
const EVENT_LIMIT = 120
const DELIVERY_LIMIT = 40

/** 面板可写、写了立即生效的字段（点路径）。 */
const HOT_KEYS = new Set([
  'kind',
  'gateway.sendUrl',
  'gateway.sharedSecret',
  'gateway.appId',
  'gateway.appSecret',
  'gateway.token',
  'gateway.wecomWebhook',
  'reply.autoReply',
  'reply.mode',
  'reply.prefix',
  'reply.suffix',
  'reply.agentPreset',
  'reply.fallbackPreset',
  'reply.maxReplyChars',
  'reply.truncateSuffix',
  'reply.fallbackText',
  'reply.allowedChatIds',
  'reply.selfNames',
  'reply.idleSessionMs',
  'history.maxMessages',
  'debug',
])

/** 面板可写、但要重载插件才完整的字段。 */
const RESTART_KEYS = new Set(['webhookPath', 'persona.file', 'persona.inject', 'persona.scope', 'stateFile'])

/* ─────────────────────────── 小工具 ─────────────────────────── */

function ensureDir(dir) {
  if (!dir || existsSync(dir)) return
  mkdirSync(dir, { recursive: true })
}

export function readOverride(file = OVERRIDE_FILE) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function writeOverride(patch, file = OVERRIDE_FILE) {
  const merged = mergeDeep(readOverride(file), patch)
  ensureDir(dirname(file))
  writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
  return merged
}

export function clearOverride(file = OVERRIDE_FILE) {
  writeFileSync(file, '{}\n', 'utf8')
}

export function mergeDeep(base, over) {
  if (over === null || over === undefined) return base
  if (Array.isArray(base) || Array.isArray(over)) return over
  if (typeof base !== 'object' || typeof over !== 'object') return over
  const out = { ...base }
  for (const [key, value] of Object.entries(over)) out[key] = mergeDeep(base[key], value)
  return out
}

/** 按点路径取值。 */
export function pickPath(object, dotted) {
  let node = object
  for (const key of dotted.split('.')) {
    if (node === null || node === undefined) return undefined
    node = node[key]
  }
  return node
}

/** 把对象摊平成点路径 → 值（数组整体算一个值）。 */
export function flatten(object, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(object ?? {})) {
    const path = prefix === '' ? key : `${prefix}.${key}`
    if (isPlainObject(value)) flatten(value, path, out)
    else out[path] = value
  }
  return out
}

/** 由点路径表重建嵌套对象。 */
export function unflatten(flat) {
  const out = {}
  for (const [key, value] of Object.entries(flat)) {
    const keys = key.split('.')
    let node = out
    for (let index = 0; index < keys.length - 1; index++) {
      const name = keys[index]
      if (!isPlainObject(node[name])) node[name] = {}
      node = node[name]
    }
    node[keys[keys.length - 1]] = value
  }
  return out
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res, status, body) {
  if (res.writableEnded) return
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

/** 管理接口只应答本机：经代理转发的请求一律拒绝。 */
function isLoopback(req) {
  if (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers['forwarded']) return false
  const remote = String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '')
  return remote === '127.0.0.1' || remote === '::1'
}

function toStringList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean)
  if (typeof value === 'string') return value.split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean)
  return []
}

/* ─────────────────────────── 面板主体 ─────────────────────────── */

/**
 * 建面板：注册全部管理路由 + 内置网关桩，返回句柄。
 *
 * @param {object} options
 * @param {object} options.server          webServer 服务
 * @param {string} options.base            管理接口前缀，默认 /wechat
 * @param {object} options.runtime         可写运行态（index.js 提供）
 * @param {() => object} options.snapshot  实时快照
 * @param {object} options.hooks           面板动作回调
 * @param {string} [options.overrideFile]  覆盖值文件（默认 ~/.dsh/wechat-bridge/config.override.json；测试可指向临时文件）
 */
export function createPanel(options) {
  const { server, base, runtime, snapshot, hooks, overrideFile = OVERRIDE_FILE } = options
  const root = base.startsWith('/') ? base.replace(/\/+$/, '') : `/${base.replace(/\/+$/, '')}`
  const API = `${root}/api`

  const activity = {
    events: [],
    deliveries: [],
    stub: { server: undefined, running: false, port: 0, received: [], startedAt: 0 },
  }

  const pushEvent = (level, message, detail) => {
    activity.events.push({
      at: Date.now(),
      level: level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info',
      message: String(message ?? ''),
      ...(detail === undefined || detail === '' ? {} : { detail: String(detail).slice(0, 400) }),
    })
    if (activity.events.length > EVENT_LIMIT) activity.events.splice(0, activity.events.length - EVENT_LIMIT)
  }

  const recordDelivery = (record) => {
    activity.deliveries.push({ at: Date.now(), ...record })
    if (activity.deliveries.length > DELIVERY_LIMIT) {
      activity.deliveries.splice(0, activity.deliveries.length - DELIVERY_LIMIT)
    }
  }

  /* ── 内置网关桩：替代 scripts/recv.mjs ── */
  const stopStub = async () => {
    const stub = activity.stub
    const httpServer = stub.server
    stub.server = undefined
    stub.running = false
    if (!httpServer) return
    await new Promise((resolve) => httpServer.close(() => resolve()))
  }

  const startStub = async (rawPort) => {
    const port = Number(rawPort)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口需要是 1-65535 的整数')
    if (activity.stub.server && activity.stub.port === port) {
      return { running: true, port, url: `http://127.0.0.1:${port}/send` }
    }
    if (activity.stub.server) await stopStub()
    const httpServer = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        let payload
        try { payload = JSON.parse(body) } catch { payload = undefined }
        activity.stub.received.push({
          at: Date.now(),
          method: req.method ?? '',
          url: req.url ?? '',
          text: body.slice(0, 2000),
        })
        if (activity.stub.received.length > 100) activity.stub.received.shift()
        recordDelivery({
          phase: 'stub',
          ok: true,
          chatId: String(payload?.chatId ?? ''),
          text: String(payload?.text ?? '').slice(0, 500),
          detail: '网关桩收到一条投递',
        })
        pushEvent('info', '网关桩收到投递', String(payload?.chatId ?? ''))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
      })
    })
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(new Error(`端口 ${port} 无法监听：${error?.message ?? error}`))
      httpServer.once('error', onError)
      httpServer.listen(port, '127.0.0.1', () => {
        httpServer.off('error', onError)
        resolve()
      })
    })
    activity.stub.server = httpServer
    activity.stub.port = port
    activity.stub.running = true
    activity.stub.startedAt = Date.now()
    pushEvent('info', `网关桩已启动 127.0.0.1:${port}`)
    return { running: true, port, url: `http://127.0.0.1:${port}/send` }
  }

  /* ── 配置写入 ── */
  const applyConfigPatch = (patch) => {
    if (!isPlainObject(patch)) throw new Error('config 必须是对象')
    const flat = flatten(patch)
    const applied = []
    const restart = []
    const rejected = []
    const persist = {}
    for (const [key, value] of Object.entries(flat)) {
      if (HOT_KEYS.has(key)) {
        applyHot(key, value)
        applied.push(key)
        persist[key] = value
      } else if (RESTART_KEYS.has(key)) {
        restart.push(key)
        persist[key] = value
      } else {
        rejected.push(key)
      }
    }
    if (Object.keys(persist).length > 0) {
      writeOverride(unflatten(persist), overrideFile)
      runtime.override = readOverride(overrideFile)
    }
    return { applied, restart, rejected }
  }

  const applyHot = (key, value) => {
    switch (key) {
      case 'kind':
        runtime.conf.kind = value === 'official' || value === 'wecom' ? value : 'generic'
        return
      case 'gateway.sendUrl':
        runtime.conf.gateway.sendUrl = String(value ?? '')
        return
      case 'gateway.sharedSecret':
        runtime.conf.gateway.sharedSecret = String(value ?? '')
        return
      case 'gateway.appId':
        runtime.conf.gateway.appId = String(value ?? '')
        return
      case 'gateway.appSecret':
        runtime.conf.gateway.appSecret = String(value ?? '')
        return
      case 'gateway.token':
        runtime.conf.gateway.token = String(value ?? '')
        return
      case 'gateway.wecomWebhook':
        runtime.conf.gateway.wecomWebhook = String(value ?? '')
        return
      case 'reply.autoReply':
        runtime.setAutoReply(Boolean(value))
        return
      case 'reply.mode':
        runtime.conf.reply.mode = value === 'formatted' ? 'formatted' : 'raw'
        return
      case 'reply.prefix':
        runtime.conf.reply.prefix = String(value ?? '')
        return
      case 'reply.suffix':
        runtime.conf.reply.suffix = String(value ?? '')
        return
      case 'reply.agentPreset':
        runtime.conf.reply.agentPreset = String(value ?? '')
        return
      case 'reply.fallbackPreset':
        runtime.conf.reply.fallbackPreset = String(value ?? '')
        return
      case 'reply.maxReplyChars':
        runtime.conf.reply.maxReplyChars = Math.max(1, Number(value) || 1800)
        return
      case 'reply.truncateSuffix':
        runtime.conf.reply.truncateSuffix = String(value ?? '')
        return
      case 'reply.fallbackText':
        runtime.conf.reply.fallbackText = String(value ?? '')
        return
      case 'reply.allowedChatIds':
        runtime.conf.reply.allowedChatIds = toStringList(value)
        return
      case 'reply.selfNames':
        runtime.conf.reply.selfNames = toStringList(value)
        return
      case 'reply.idleSessionMs':
        runtime.conf.reply.idleSessionMs = Math.max(0, Number(value) || 0)
        return
      case 'history.maxMessages':
        runtime.conf.history.maxMessages = Math.max(20, Number(value) || 200)
        return
      case 'debug':
        runtime.conf.debug = Boolean(value)
        return
      default:
        return
    }
  }

  /* ── 路由 ── */
  const routes = []
  const route = (path, handler) => {
    routes.push(
      server.register({
        kind: 'exact',
        path,
        handler: async (req, res) => {
          if (!isLoopback(req)) {
            sendJson(res, 403, { ok: false, code: 'loopback-only', message: '管理接口只应答本机请求' })
            return
          }
          try {
            await handler(req, res)
          } catch (error) {
            pushEvent('error', `${path} 处理失败`, error?.message ?? String(error))
            try {
              sendJson(res, 500, { ok: false, code: 'panel-error', message: String(error?.message ?? error) })
            } catch { /* socket 可能已经关了 */ }
          }
        },
      }),
    )
  }

  const requireMethod = (req, res, method) => {
    if (req.method === method) return true
    sendJson(res, 405, { ok: false, code: 'invalid-request', message: `${method} only` })
    return false
  }

  const readJsonBody = async (req, res) => {
    const raw = await readBody(req)
    if (raw.trim() === '') return {}
    try {
      return JSON.parse(raw)
    } catch {
      sendJson(res, 400, { ok: false, code: 'invalid-json', message: '请求体不是合法 JSON' })
      return undefined
    }
  }

  route(`${API}/state`, async (req, res) => {
    if (!requireMethod(req, res, 'GET')) return
    sendJson(res, 200, {
      ...snapshot(),
      events: activity.events.slice(-60).reverse(),
      deliveries: activity.deliveries.slice(-20).reverse(),
      stub: {
        running: activity.stub.running,
        port: activity.stub.port,
        startedAt: activity.stub.startedAt,
        received: activity.stub.received.slice(-20).reverse(),
      },
    })
  })

  route(`${API}/chats`, async (req, res) => {
    if (!requireMethod(req, res, 'GET')) return
    const url = new URL(req.url ?? '/', 'http://localhost')
    const chatId = url.searchParams.get('chatId') ?? ''
    if (!chatId) {
      sendJson(res, 200, { ok: true, chats: hooks.listChats() })
      return
    }
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 50))
    sendJson(res, 200, { ok: true, chatId, ...hooks.readChat(chatId, limit) })
  })

  route(`${API}/config`, async (req, res) => {
    if (req.method === 'GET') {
      sendJson(res, 200, { ok: true, config: snapshot().config, override: readOverride(overrideFile) })
      return
    }
    if (!requireMethod(req, res, 'PUT')) return
    const body = await readJsonBody(req, res)
    if (body === undefined) return
    if (body.action === 'reset') {
      clearOverride(overrideFile)
      runtime.override = {}
      pushEvent('warn', '面板覆盖值已清空')
      sendJson(res, 200, { ok: true, reset: true, message: '覆盖值已清空，行配置重新成为权威；重载插件后完全生效。' })
      return
    }
    const outcome = applyConfigPatch(body.config ?? body)
    pushEvent('info', '面板写入配置', outcome.applied.join(', ') || '(仅重启项)')
    sendJson(res, 200, {
      ok: true,
      ...outcome,
      message: outcome.applied.length === 0 && outcome.restart.length === 0
        ? '没有可写字段被接受'
        : `已生效 ${outcome.applied.length} 项${outcome.restart.length > 0 ? `，${outcome.restart.length} 项需要重载插件` : ''}`,
    })
  })

  route(`${API}/console`, async (req, res) => {
    if (!requireMethod(req, res, 'POST')) return
    const body = await readJsonBody(req, res)
    if (body === undefined) return
    const action = String(body.action ?? '')
    try {
      if (action === 'inbound') {
        const outcome = await hooks.inbound(body)
        pushEvent(outcome.ok ? 'info' : 'warn', `入站自测${outcome.ok ? '已接受' : '被拒绝'}`, outcome.detail ?? '')
        sendJson(res, 200, outcome)
        return
      }
      if (action === 'outbound') {
        const outcome = await hooks.outbound(body)
        recordDelivery({
          phase: 'manual',
          ok: outcome.ok,
          chatId: String(body.chatId ?? ''),
          text: String(body.text ?? '').slice(0, 500),
          detail: outcome.detail ?? '',
        })
        pushEvent(outcome.ok ? 'info' : 'error', `测试投递${outcome.ok ? '成功' : '失败'}`, outcome.detail ?? '')
        sendJson(res, 200, outcome)
        return
      }
      if (action === 'stub-start') {
        const outcome = await startStub(body.port ?? 8787)
        sendJson(res, 200, { ok: true, ...outcome })
        return
      }
      if (action === 'stub-stop') {
        await stopStub()
        pushEvent('info', '网关桩已停止')
        sendJson(res, 200, { ok: true, running: false })
        return
      }
      sendJson(res, 400, { ok: false, code: 'unknown-action', message: `未知动作：${action || '(空)'}` })
    } catch (error) {
      const message = String(error?.message ?? error)
      pushEvent('error', `控制台动作失败（${action}）`, message)
      sendJson(res, 200, { ok: false, code: 'action-failed', message })
    }
  })

  route(`${API}/selftest`, async (req, res) => {
    if (!requireMethod(req, res, 'POST')) return
    const body = await readJsonBody(req, res)
    if (body === undefined) return
    const checks = []
    const add = (id, level, title, detail, fix) => checks.push({ id, level, title, detail: detail ?? '', ...(fix ? { fix } : {}) })

    const snap = snapshot()
    add('plugin', 'ok', '插件已激活', `${snap.config.kind} · ${snap.config.webhookPath} · 自动回复${snap.autoReply ? '开' : '关'}`)

    add(
      'agent-services',
      snap.agentServices ? 'ok' : 'error',
      snap.agentServices ? 'agent 服务已接线' : 'agent 服务缺失',
      snap.agentServices ? `可用预设 ${snap.presets.length} 个` : '当前 profile 没有 agents/agentPresets，自动回复建不了会话',
      snap.agentServices ? '' : '确认 profile 里有 @deepseek-ai/dsh-agent 与 agent-preset-registry',
    )

    const presetId = snap.config.agentPreset
    const found = snap.presets.find((preset) => preset.id === presetId)
    add(
      'preset',
      found && !found.broken ? 'ok' : found ? 'warn' : 'error',
      found ? `预设 ${presetId} 已注册${found.broken ? '（加载失败）' : ''}` : `预设 ${presetId} 未注册`,
      found ? `${found.name ?? presetId}${found.broken ? ` · ${found.broken}` : ''}` : '自动回复会在 agentPresets.resolve 处失败',
      found && !found.broken ? '' : '在「设置 → 自动回复预设」换一个，或重装本插件',
    )

    add(
      'persona',
      snap.persona.chars > 0 ? 'ok' : 'warn',
      snap.persona.chars > 0 ? '人格 markdown 可读' : '人格 markdown 未加载',
      `${snap.persona.file} · ${snap.persona.chars} 字符`,
      snap.persona.chars > 0 ? '' : '检查 persona.file，或确认人格由 preset 注入',
    )

    const sendUrl = snap.config.gateway.sendUrl
    const needsSendUrl = snap.config.kind === 'generic'
    add(
      'gateway',
      needsSendUrl && !sendUrl ? 'error' : 'ok',
      needsSendUrl ? (sendUrl ? '出站网关已配置' : '出站网关未配置') : `${snap.config.kind} 出站不需要 sendUrl`,
      needsSendUrl ? (sendUrl || 'sendUrl 为空时 deliver() 直接失败') : '',
      needsSendUrl && !sendUrl ? '在「设置 → 出站网关」填地址，或用内置网关桩' : '',
    )

    const inbound = await hooks.selftestInbound()
    add('inbound', inbound.ok ? 'ok' : 'error', inbound.ok ? '入站链路往返正常' : '入站链路往返失败', inbound.detail ?? '', inbound.ok ? '' : '看下 allowedChatIds 与 webhook 路由')

    const reach = await hooks.selftestGateway()
    add(
      'gateway-reach',
      reach.ok ? 'ok' : reach.skipped ? 'warn' : 'error',
      reach.skipped ? '网关可达性跳过' : reach.ok ? '网关可达' : '网关不可达',
      reach.detail ?? '',
      reach.ok ? '' : '起内置网关桩，再把 sendUrl 指到它',
    )

    const failed = checks.filter((check) => check.level === 'error').length
    pushEvent(failed === 0 ? 'info' : 'warn', `自检完成：${checks.length - failed}/${checks.length} 通过`)
    sendJson(res, 200, {
      ok: failed === 0,
      checks,
      summary: { total: checks.length, passed: checks.length - failed, failed },
      ranAt: Date.now(),
    })
  })

  route(`${API}/read`, async (req, res) => {
    if (!requireMethod(req, res, 'POST')) return
    const body = await readJsonBody(req, res)
    if (body === undefined) return
    const chatId = String(body.chatId ?? '').trim()
    if (!chatId) {
      sendJson(res, 400, { ok: false, code: 'invalid-request', message: '缺少 chatId' })
      return
    }
    const outcome = hooks.markRead(chatId, body.throughSeq)
    sendJson(res, 200, outcome)
  })

  route(`${API}/reset`, async (req, res) => {    if (!requireMethod(req, res, 'POST')) return
    const outcome = hooks.reset()
    pushEvent('warn', '本地缓存已清空', `会话 ${outcome.chats} 个`)
    sendJson(res, 200, { ok: true, ...outcome })
  })

  const dispose = async () => {
    for (const close of routes.splice(0)) {
      try { close() } catch { /* ignore */ }
    }
    await stopStub()
  }

  return { api: API, pushEvent, recordDelivery, dispose, activity }
}
