/**
 * dsh-wechat-bridge —— 让 DSH 自动接入微信的 Host 插件。
 *
 * 组成：
 *   1. 入站网关：在 Host 的 webServer 上注册一个 webhook 路由，接收微信侧推送
 *      （通用 JSON 网关 / 微信公众平台「服务器配置」XML + 签名校验）。
 *   2. 出站网关：按配置把回复投递回微信（generic HTTP / official-account 客服消息 /
 *      wecom 群机器人）。
 *   3. 工具面：注册一组 wechat_* 工具，agent 自己决定看消息、回消息、记记忆。
 *   4. 自动回复：每个微信会话映射到一个独立的 DSH Agent Session（可用 preset 注入人格），
 *      收到消息→唤醒 agent→结束时把最终回复按 replyMode 原样/加前缀投递回微信。
 *   5. 人格：persona.file 指向一个 markdown，激活时读取并作为系统提示词前缀注入。
 *
 * 设计约束（与 harness 插件规范一致）：
 *   - 只注册、不扫描：所有副作用都在 apply 内用 ctx.effect / ctx.on 注册并返回清理器。
 *   - 不引入 @deepseek-ai/* 运行时依赖，纯 ctx 服务 + Node 内置模块，避免 profile 里的解析问题。
 *   - 状态（会话、消息、记忆）落在 stateFile，插件重载后仍在。
 */

import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { createPanel, mergeDeep, readOverride, OVERRIDE_FILE } from './lib/panel.js'

/** 插件行名。 */
export const name = 'wechat-bridge'

/** 硬依赖：工具注册表 + 系统提示词注册表。 */
export const inject = ['tools', 'systemPrompt']

const DEFAULT_STATE_DIR = join(homedir(), '.dsh', 'wechat-bridge')
const MAX_BODY_BYTES = 1024 * 1024
const TOKEN_REFRESH_MS = 7000 * 1000

/** 配置默认值。用户配置按深合并覆盖。 */
const DEFAULTS = {
  enabled: true,
  /**
   * 网关类型：
   *   generic  —— 自建网关推/收（webhook），插件被动
   *   official —— 微信公众平台（XML + 签名验签）
   *   wecom    —— 企业微信群机器人（只出站）
   *   hook     —— 个人微信 hook 服务：插件**主动轮询**收消息、主动 POST 发消息
   */
  kind: 'generic',
  webhookPath: '/wechat/webhook',
  gateway: {
    /** generic：出站投递地址，POST JSON。 */
    sendUrl: '',
    /** generic：入站校验密钥（请求头 X-WeChat-Secret）；留空则不校验。 */
    sharedSecret: '',
    /** official：公众号凭据。 */
    appId: '',
    appSecret: '',
    /** official：服务器配置里的 Token（签名校验用）。 */
    token: '',
    /** wecom：群机器人 webhook。 */
    wecomWebhook: '',
  },
  inject: {
    /** 注入器可执行文件；相对路径按插件包目录解析。.mjs/.js 会用当前 node 跑（便于自测）。 */
    injectorPath: './native/build/wechat-inject.exe',
    /** 目标进程名（不区分大小写）。 */
    processName: 'WeChat.exe',
    /** 可选：微信主程序路径；填了就先拉起再注入。 */
    wechatPath: '',
    /** 要注入的 hook DLL（例如 WeChatFerry 的 sdk.dll，必须与微信版本匹配）。 */
    hookDll: '',
    /** 注入器超时（毫秒）。 */
    timeoutMs: 15000,
    /** 注入成功后等 hook 服务可用的时长（毫秒）；0=不等。 */
    waitForServiceMs: 20000,
  },
  hook: {
    /** hook 服务基地址，例如 http://127.0.0.1:8788（gateway/hook-gateway.mjs 默认就是这个）。 */
    baseUrl: '',
    /** 与 hook 服务之间的共享密钥（请求头 X-WeChat-Secret）；留空不校验。 */
    secret: '',
    /** 轮询间隔（毫秒）。 */
    pollMs: 3000,
    /** 单次拉取条数上限。 */
    limit: 50,
    /** 起始游标；留空=从「现在」开始，避免把历史消息一次性灌进来。 */
    cursor: '',
    /** 单次 HTTP 超时（毫秒）。 */
    timeoutMs: 8000,
    /** 拉取路径（拼在 baseUrl 后面）。 */
    messagesPath: '/messages',
    /** 发送路径。 */
    sendPath: '/send',
    /** 机器人自己的 wxid / 昵称；来自这些 sender 的消息会被丢掉（防自问自答）。 */
    selfIds: [],
    /** 插件激活时自动开始轮询。 */
    autoStart: true,
    /** 连续失败多少次后自动暂停（0 = 永不暂停）。 */
    maxFailures: 5,
  },
  reply: {
    /** 自动回复总开关（关掉后仅保留工具面，由 agent 用工具主动回）。 */
    autoReply: true,
    /** raw=模型最终文本原样发出；formatted=加 prefix/suffix。 */
    mode: 'raw',
    prefix: '',
    suffix: '',
    /** 每个会话使用的 agent preset（人格 md 由该 preset 注入）。 */
    agentPreset: 'wechat-agent',
    /** preset 解析失败时的回落 preset；留空=直接失败并记 lastError。 */
    fallbackPreset: '',
    /** 模型路由；留空用默认模型。 */
    provider: '',
    model: '',
    /** 权限 preset；留空用默认。 */
    permissionPreset: '',
    /** 工作目录；留空用进程 cwd。 */
    workingDirectory: '',
    /** 只接受这些会话（wxid / 群 id）；空数组=不限制。 */
    allowedChatIds: [],
    /** 机器人在群里的名字，用于判断是否被 @。 */
    selfNames: [],
    /** 单条回复最大字符数（企业微信/公众号文本都有上限）。 */
    maxReplyChars: 1800,
    /** 超长时的截断后缀。 */
    truncateSuffix: '…（略）',
    /** agent 出错时的兜底文案，留空则不发。 */
    fallbackText: '',
    /** agent 空闲多久后回收会话（毫秒），0=不回收。 */
    idleSessionMs: 30 * 60 * 1000,
  },
  persona: {
    /** 人格 markdown 路径（相对路径按插件目录解析）。 */
    file: './persona/wechat-persona.md',
    /** 是否注入人格 md 到系统提示词。自动回复会话通常由 preset 注入，故默认关闭以免重复。 */
    inject: false,
    /** sessions=只注入本插件托管的微信会话；all=在插件 ctx 全局注册（影响全部会话）。 */
    scope: 'sessions',
  },
  history: {
    /** 每个会话保留的最近消息条数。 */
    maxMessages: 200,
  },
  /** 状态文件；留空= ~/.dsh/wechat-bridge/state.json。 */
  stateFile: '',
  /** 调试日志。 */
  debug: false,
}

/** 把用户配置深合并到默认值上。 */
function withDefaults(config) {
  const merge = (base, over) => {
    if (over === null || over === undefined) return base
    if (Array.isArray(base) || Array.isArray(over)) return over
    if (typeof base !== 'object' || typeof over !== 'object') return over
    const out = { ...base }
    for (const [key, value] of Object.entries(over)) out[key] = merge(base[key], value)
    return out
  }
  return merge(DEFAULTS, config ?? {})
}

/**
 * 把作者 DSL（property 级 `required: true`）编译成 harness 强制子集要求的 JSON Schema
 * （object 级 `required: [...]` 数组）。工具参数用作者 DSL 由 registry 编译，
 * 而 output.schema 是裸 JSON Schema，必须自己转。
 */
function compileSchema(node) {
  if (Array.isArray(node)) return node.map(compileSchema)
  if (node === null || typeof node !== 'object') return node
  const out = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === 'required' && value === true) continue
    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      const properties = {}
      const required = []
      for (const [prop, spec] of Object.entries(value)) {
        properties[prop] = compileSchema(spec)
        if (spec && spec.required === true) required.push(prop)
      }
      out.properties = properties
      if (required.length > 0) out.required = required
      continue
    }
    out[key] = compileSchema(value)
  }
  return out
}

/** 把作者 DSL 的参数表编译成 registry 期望的 JSON Schema（object-rooted）。 */
function compileParameters(spec) {
  const properties = {}
  const required = []
  for (const [key, value] of Object.entries(spec ?? {})) {
    properties[key] = compileSchema(value)
    if (value && value.required === true) required.push(key)
  }
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) }
}

/** 丢掉值为 undefined 的键：会话日志只接受 lossless JSON。 */
function withoutUndefined(record) {
  const out = {}
  for (const [key, value] of Object.entries(record)) if (value !== undefined) out[key] = value
  return out
}

/** 从 ContentBlock[] 里抽出纯文本。 */
function blocksToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('')
}

/** 深冻结一份 message，避免下游把它当成可变的、未规范化的输入。 */
function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key])
    Object.freeze(value)
  }
  return value
}

/**
 * 构造一条合法的 UserMessage。
 * 与 @deepseek-ai/dsh-llm 的 createUserMessage 等价：structuredClone 一份再深冻结，
 * id 是随机 UUID。手写对象也能用，但下游对“已识别且不可变”的消息假设更安全。
 */
function userMessage(text) {
  return deepFreeze(structuredClone({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }))
}

/** 幂等 mkdir。 */
function ensureDir(dir) {
  if (!dir || existsSync(dir)) return
  mkdirSync(dir, { recursive: true })
}

/** 读取 JSON 文件，失败返回 undefined。 */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** XML 单标签取值（微信推送的 CDATA 形式）。 */
function xmlValue(xml, tag) {
  const cdata = new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`).exec(xml)
  if (cdata) return cdata[1]
  const plain = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml)
  return plain ? plain[1] : ''
}

/** 读请求体（带上限）。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 回一个 JSON 响应。 */
function sendJson(res, status, body) {
  if (res.writableEnded) return
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

/** 回一个纯文本响应。 */
function sendText(res, status, text) {
  if (res.writableEnded) return
  res.statusCode = status
  res.setHeader('content-type', 'text/plain; charset=utf-8')
  res.end(text)
}

/**
 * 注入 Host。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 * @param {object} config 插件行配置。
 */
export function apply(ctx, config) {
  // 覆盖值文件：默认 ~/.dsh/wechat-bridge/config.override.json；
  // 自检/测试可以指到临时文件，绝不碰真实配置。
  const overrideFile = (() => {
    const wanted = config?.overrideFile
    if (!wanted || typeof wanted !== 'string') return OVERRIDE_FILE
    return isAbsolute(wanted) ? wanted : resolvePath(process.cwd(), wanted)
  })()
  // 面板写入的覆盖值压在最上层：行配置仍是权威，但面板改的能生效且不写坏 YAML。
  const override = readOverride(overrideFile)
  const cfg = withDefaults(mergeDeep(config ?? {}, override))
  /** 面板句柄：路由注册后才可用，供 hooks 上报事件（可能早于注册）。 */
  let panel
  const log = (level, message) => {
    const logger = ctx.logger
    if (logger && typeof logger[level] === 'function') logger[level](`wechat-bridge: ${message}`)
    else if (level === 'error') console.error(`wechat-bridge: ${message}`)
    if (level === 'warn' || level === 'error') panel?.pushEvent(level, message)
  }
  const debug = (message) => {
    if (cfg.debug) log('info', message)
  }
  /** 记下最近一次失败，并通过 /status、面板与 wechat_status 暴露，便于没有日志时定位。 */
  const recordError = (phase, error) => {
    const message = String(error?.message ?? error)
    state.lastError = { at: Date.now(), phase, message: message.slice(0, 400) }
    state.counters.errors += 1
    log('warn', `${phase}: ${message}`)
  }

  const pluginRoot = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

  // ── 状态 ────────────────────────────────────────────────────────────────
  const stateFile = cfg.stateFile
    ? (isAbsolute(cfg.stateFile) ? cfg.stateFile : resolvePath(process.cwd(), cfg.stateFile))
    : join(DEFAULT_STATE_DIR, 'state.json')

  const state = {
    chats: new Map(),       // chatId -> { chatId, name, kind, readThrough, members: [] }
    messages: new Map(),    // chatId -> Message[]
    memory: { topics: [], thoughts: [], impressions: [] },
    sessions: new Map(),    // chatId -> sessionId
    seq: 0,
    startedAt: Date.now(),
    counters: { inbound: 0, outbound: 0, replies: 0, errors: 0 },
    lastError: null,
    inject: null,
  }

  const restore = readJson(stateFile)
  if (restore && typeof restore === 'object') {
    try {
      for (const chat of restore.chats ?? []) state.chats.set(chat.chatId, chat)
      for (const [chatId, list] of Object.entries(restore.messages ?? {})) state.messages.set(chatId, list)
      for (const [chatId, sessionId] of Object.entries(restore.sessions ?? {})) state.sessions.set(chatId, sessionId)
      if (restore.memory && typeof restore.memory === 'object') state.memory = { ...state.memory, ...restore.memory }
      if (restore.lastError && typeof restore.lastError === 'object') state.lastError = restore.lastError
      if (restore.inject && typeof restore.inject === 'object') state.inject = restore.inject
      state.seq = Number.isSafeInteger(restore.seq) ? restore.seq : 0
    } catch (error) {
      log('warn', `state restore failed: ${error?.message ?? error}`)
    }
  }

  let persistTimer
  const persist = () => {
    if (persistTimer) return
    persistTimer = setTimeout(() => {
      persistTimer = undefined
      try {
        ensureDir(dirname(stateFile))
        writeFileSync(stateFile, JSON.stringify({
          seq: state.seq,
          chats: [...state.chats.values()],
          messages: Object.fromEntries(state.messages),
          sessions: Object.fromEntries(state.sessions),
          memory: state.memory,
          lastError: state.lastError,
          inject: state.inject,
        }, null, 0))
      } catch (error) {
        log('warn', `state persist failed: ${error?.message ?? error}`)
      }
    }, 250)
    if (typeof persistTimer.unref === 'function') persistTimer.unref()
  }

  // ── 人格 ────────────────────────────────────────────────────────────────
  let personaText = ''
  if (cfg.persona.file) {
    const file = isAbsolute(cfg.persona.file) ? cfg.persona.file : join(pluginRoot, cfg.persona.file)
    try {
      personaText = readFileSync(file, 'utf8').trim()
    } catch (error) {
      log('warn', `persona file unreadable (${file}): ${error?.message ?? error}`)
    }
  }

  /**
   * 把人格 md 注入到一个 agent 作用域的系统提示词。
   * 默认只注入本插件托管的微信会话；`persona.scope: 'all'` 才在插件 ctx 上全局注册
   * （那会影响 profile 里所有会话，除非你确实想这样）。
   */
  const injectPersona = (targetCtx) => {
    if (!cfg.persona.inject || !personaText) return () => {}
    return targetCtx.systemPrompt.section({
      name: 'wechat-bridge/persona',
      order: targetCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
      text: personaText,
      interpolate: false,
    })
  }

  if (cfg.persona.inject && cfg.persona.scope === 'all' && personaText) {
    ctx.effect(() => injectPersona(ctx), 'wechat-bridge.persona()')
    debug(`persona injected globally (${personaText.length} chars)`)
  }

  // ── 消息存取 ────────────────────────────────────────────────────────────
  const chatOf = (chatId, patch) => {
    let chat = state.chats.get(chatId)
    if (!chat) {
      chat = { chatId, name: chatId, kind: 'private', readThrough: 0, members: [] }
      state.chats.set(chatId, chat)
    }
    if (patch) Object.assign(chat, patch)
    return chat
  }

  const messagesOf = (chatId) => {
    let list = state.messages.get(chatId)
    if (!list) {
      list = []
      state.messages.set(chatId, list)
    }
    return list
  }

  const pushMessage = (chatId, message) => {
    const list = messagesOf(chatId)
    state.seq += 1
    const record = withoutUndefined({
      ...message,
      chatId,
      seq: state.seq,
      time: message.time ?? Date.now(),
    })
    list.push(record)
    const limit = Math.max(20, Number(cfg.history.maxMessages) || 200)
    if (list.length > limit) list.splice(0, list.length - limit)
    chatOf(chatId, { lastAt: record.time })
    persist()
    return record
  }

  const unreadOf = (chatId) => {
    const chat = chatOf(chatId)
    return messagesOf(chatId).filter((m) => m.seq > (chat.readThrough ?? 0) && m.direction === 'in')
  }

  // ── 出站投递 ────────────────────────────────────────────────────────────
  let tokenCache = { value: '', expiresAt: 0 }

  const officialToken = async () => {
    if (tokenCache.value && Date.now() < tokenCache.expiresAt) return tokenCache.value
    const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(cfg.gateway.appId)}&secret=${encodeURIComponent(cfg.gateway.appSecret)}`
    const response = await fetch(url)
    const payload = await response.json()
    if (!payload?.access_token) throw new Error(`official token failed: ${JSON.stringify(payload)}`)
    tokenCache = { value: payload.access_token, expiresAt: Date.now() + TOKEN_REFRESH_MS }
    return payload.access_token
  }

  /**
   * 把一条文本投递到微信侧。
   * @returns {Promise<{ ok: boolean, detail: string }>}
   */
  const deliver = async (chatId, text, meta = {}) => {
    if (!text) return { ok: false, detail: 'empty text' }
    const body = String(text).slice(0, Math.max(1, Number(cfg.reply.maxReplyChars) || 1800))
    try {
      if (cfg.kind === 'official') {
        const token = await officialToken()
        const response = await fetch(`https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${encodeURIComponent(token)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ touser: chatId, msgtype: 'text', text: { content: body } }),
        })
        const payload = await response.json().catch(() => ({}))
        const ok = payload?.errcode === 0
        if (!ok) log('warn', `official send rejected: ${JSON.stringify(payload)}`)
        return { ok, detail: ok ? 'sent' : JSON.stringify(payload) }
      }
      if (cfg.kind === 'wecom') {
        const response = await fetch(cfg.gateway.wecomWebhook, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ msgtype: 'text', text: { content: body } }),
        })
        const payload = await response.json().catch(() => ({}))
        const ok = payload?.errcode === 0
        return { ok, detail: ok ? 'sent' : JSON.stringify(payload) }
      }
      // hook：个人微信 hook 服务（主动 POST）
      if (cfg.kind === 'hook') {
        const base = String(cfg.hook.baseUrl ?? '').replace(/\/+$/, '')
        if (!base) return { ok: false, detail: 'hook.baseUrl is not configured' }
        const headers = { 'content-type': 'application/json' }
        if (cfg.hook.secret) headers['x-wechat-secret'] = cfg.hook.secret
        const response = await fetch(`${base}${cfg.hook.sendPath || '/send'}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            chatId,
            text: body,
            replyToMessageId: meta.replyToMessageId,
            atUserId: meta.atUserId,
            raw: cfg.reply.mode === 'raw',
          }),
          signal: AbortSignal.timeout(Math.max(1000, Number(cfg.hook.timeoutMs) || 8000)),
        })
        const detail = await response.text().catch(() => '')
        let payload
        try { payload = JSON.parse(detail) } catch { payload = undefined }
        const ok = response.ok && (payload === undefined || payload.ok !== false)
        if (!ok) log('warn', `hook send rejected: ${detail.slice(0, 300)}`)
        return { ok, detail: ok ? 'sent' : detail.slice(0, 300) || `HTTP ${response.status}` }
      }
      // generic：交给外部网关
      if (!cfg.gateway.sendUrl) return { ok: false, detail: 'gateway.sendUrl is not configured' }
      const headers = { 'content-type': 'application/json' }
      if (cfg.gateway.sharedSecret) headers['x-wechat-secret'] = cfg.gateway.sharedSecret
      const response = await fetch(cfg.gateway.sendUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          action: 'send',
          chatId,
          text: body,
          replyToMessageId: meta.replyToMessageId,
          atUserId: meta.atUserId,
          raw: cfg.reply.mode === 'raw',
        }),
      })
      const detail = await response.text().catch(() => '')
      return { ok: response.ok, detail: response.ok ? 'sent' : detail.slice(0, 300) }
    } catch (error) {
      state.counters.errors += 1
      log('warn', `deliver failed: ${error?.message ?? error}`)
      return { ok: false, detail: String(error?.message ?? error) }
    }
  }

  const replyText = (text) => {
    if (cfg.reply.mode === 'raw') return text
    return `${cfg.reply.prefix ?? ''}${text}${cfg.reply.suffix ?? ''}`
  }

  // ── 自动回复：微信会话 → DSH agent session ──────────────────────────────
  const relays = new Map()   // sessionId -> { chatId, turn, text, toolSent, pending, lastActive }
  let agentApi          // { ctx, agents, agentPresets, ... } 由可选注入填充
  let autoReplyOff = !cfg.reply.autoReply

  const resolveModel = (api) => {
    if (cfg.reply.provider && cfg.reply.model) {
      return { provider: cfg.reply.provider, model: cfg.reply.model }
    }
    const current = api?.agentDefaultModel?.currentSelection?.()
    return current ? { provider: current.provider, model: current.model } : { provider: '', model: '' }
  }

  /** 结束一个 turn 时把最终文本投递回微信。 */
  const flushTurn = async (sessionId) => {
    const relay = relays.get(sessionId)
    if (!relay) return
    relay.lastActive = Date.now()
    if (relay.toolSent || autoReplyOff) {
      relay.text = ''
      return
    }
    const raw = (relay.text ?? '').trim()
    relay.text = ''
    if (!raw) return
    const text = raw.length > cfg.reply.maxReplyChars
      ? raw.slice(0, Math.max(1, cfg.reply.maxReplyChars - (cfg.reply.truncateSuffix?.length ?? 0))) + (cfg.reply.truncateSuffix ?? '')
      : raw
    const outcome = await deliver(relay.chatId, replyText(text))
    if (outcome.ok) {
      state.counters.replies += 1
      state.counters.outbound += 1
      pushMessage(relay.chatId, { direction: 'out', text, senderId: 'agent', senderName: 'agent' })
    }
  }

  // 观测所有会话事件，按 sessionId 过滤出我们托管的会话。
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    const sessionId = session?.header?.id ?? session?.id
    const relay = relays.get(sessionId)
    if (!relay) return
    if (event.type === 'assistant/message') {
      const text = blocksToText(event.data?.message?.content)
      if (text && text.trim()) relay.text = text
      if (Number.isSafeInteger(event.data?.turn)) relay.turn = event.data.turn
      return
    }
    if (event.type === 'tool/result') {
      const toolName = event.data?.message?.name ?? ''
      if (typeof toolName === 'string' && toolName.startsWith('wechat_')) relay.toolSent = true
      return
    }
    if (event.type === 'turn/start') {
      relay.toolSent = false
      relay.text = ''
      relay.lastActive = Date.now()
      return
    }
    if (event.type === 'turn/end') {
      void flushTurn(sessionId)
    }
  }), 'wechat-bridge.sessionEvents()')

  /** 为一个微信会话确保存在 agent session。 */
  const ensureSession = async (chatId) => {
    const api = agentApi
    if (!api) throw new Error('agent services are not composed')
    const existing = state.sessions.get(chatId)
    if (existing) {
      const live = api.agents.get?.(existing)
      if (live) return { sessionId: existing, agent: live }
      relays.delete(existing)
      state.sessions.delete(chatId)
    }
    let preset
    try {
      preset = await api.agentPresets.resolve(cfg.reply.agentPreset || undefined)
    } catch (error) {
      recordError('agentPresets.resolve', error)
      if (!cfg.reply.fallbackPreset) throw error
      preset = await api.agentPresets.resolve(cfg.reply.fallbackPreset)
    }
    const scope = preset?.id ? await api.agentPresets.acquireScope(preset.id) : undefined
    const sessionId = `wechat-${randomUUID()}`
    const cwd = cfg.reply.workingDirectory || process.cwd()
    const model = resolveModel(api)
    const chat = chatOf(chatId)
    relays.set(sessionId, { chatId, turn: 0, text: '', toolSent: false, lastActive: Date.now() })
    try {
      if (cfg.reply.permissionPreset && api.permissionPresets?.resolve) {
        api.permissionPresets.resolve(cfg.reply.permissionPreset)
      }
      // 与 webhook 的实现保持同一顺序：先登记 workspace，让会话在 GUI 里可见、可 attach。
      let workspace
      if (api.workspaceRegistry?.create) {
        try {
          workspace = await api.workspaceRegistry.create(cwd)
        } catch (error) {
          debug(`workspace create failed: ${error?.message ?? error}`)
        }
      }
      const handle = await api.agents.create({
        sessionId,
        meta: { cwd: workspace?.path ?? cwd, ...(preset?.id ? { agentPreset: preset.id } : {}) },
        agentOptions: { ...model },
        setup: async (agentCtx) => {
          if (preset?.id) await api.agentPresets.mount(agentCtx, preset.id)
          // 只在本次会话的作用域里注入人格，不污染 profile 里的其它会话
          agentCtx.effect(() => injectPersona(agentCtx), 'wechat-bridge.sessionPersona()')
        },
      })
      if (cfg.reply.permissionPreset && api.permissionPresets?.set) {
        try { api.permissionPresets.set(handle.agent.session, cfg.reply.permissionPreset) } catch (error) { debug(`permission set failed: ${error?.message}`) }
      }
      if (workspace?.attachSession) {
        try { await workspace.attachSession(sessionId) } catch (error) { debug(`attachSession failed: ${error?.message}`) }
      }
      if (api.sessionTitle?.rename) {
        try { api.sessionTitle.rename(handle.agent.session, `微信 · ${chat.name || chatId}`) } catch (error) { debug(`title rename failed: ${error?.message}`) }
      }
      state.sessions.set(chatId, sessionId)
      persist()
      return { sessionId, agent: handle.agent }
    } catch (error) {
      relays.delete(sessionId)
      throw error
    } finally {
      scope?.[Symbol.asyncDispose]?.().catch?.(() => {})
    }
  }

  /** 入站消息 → agent 唤醒。 */
  const handoff = async (chatId, text, meta) => {
    if (autoReplyOff) return
    if (!agentApi) {
      debug('autoReply skipped: agent services unavailable')
      return
    }
    const names = (cfg.reply.selfNames ?? []).filter(Boolean)
    const chat = chatOf(chatId)
    if (chat.kind === 'group' && names.length > 0) {
      const mentioned = names.some((entry) => text.includes(`@${entry}`))
      if (!mentioned) {
        debug(`skip group message without @${names.join('/')}`)
        return
      }
    }
    try {
      const { sessionId, agent } = await ensureSession(chatId)
      const relay = relays.get(sessionId)
      if (relay) relay.lastActive = Date.now()
      const prompt = `[微信 ${chat.kind === 'group' ? '群聊' : '私聊'} · ${chat.name || chatId}]\n发送者：${meta.senderName || meta.senderId || '未知'}\n\n${text}`
      try {
        agent.followup(userMessage(prompt))
      } catch (error) {
        recordError(`followup(${chatId})`, error)
        if (cfg.reply.fallbackText) void deliver(chatId, cfg.reply.fallbackText)
      }
    } catch (error) {
      recordError(`handoff(${chatId})`, error)
      if (cfg.reply.fallbackText) void deliver(chatId, cfg.reply.fallbackText)
    }
  }

  // ── 面板快照 ────────────────────────────────────────────────────────────
  /** 预设名册：agentPresets.list() 是异步的，而快照必须同步，所以缓存 10s。 */
  const presets = { at: 0, list: [], error: '' }
  const refreshPresets = async () => {
    if (!agentApi?.agentPresets?.list) return
    try {
      const list = await agentApi.agentPresets.list()
      presets.list = (Array.isArray(list) ? list : []).map((preset) => withoutUndefined({
        id: String(preset?.id ?? ''),
        name: preset?.name === undefined ? undefined : String(preset.name),
        description: preset?.description === undefined ? undefined : String(preset.description),
        isDefault: preset?.isDefault === undefined ? undefined : Boolean(preset.isDefault),
        broken: preset?.broken === undefined ? undefined : String(preset.broken),
      }))
      presets.error = ''
    } catch (error) {
      presets.error = String(error?.message ?? error).slice(0, 300)
    }
    presets.at = Date.now()
  }

  /** 可选服务接线：agent 运行时。 */
  ctx.inject(['agents', 'agentPresets'], (scoped) => {
    agentApi = {
      agents: scoped.agents,
      agentPresets: scoped.agentPresets,
      agentDefaultModel: scoped.get('agentDefaultModel'),
      permissionPresets: scoped.get('permissionPresets'),
      sessionTitle: scoped.get('sessionTitle'),
      workspaceRegistry: scoped.get('workspaceRegistry'),
    }
    debug('agent services wired')
    void refreshPresets()
  })

  // ── 入站消息规范化 ──────────────────────────────────────────────────────
  const ingest = (inbound) => {
    const chatId = String(inbound.chatId ?? inbound.from ?? '').trim()
    if (!chatId) return undefined
    const allowed = (cfg.reply.allowedChatIds ?? []).filter(Boolean)
    if (allowed.length > 0 && !allowed.includes(chatId)) {
      debug(`rejected chat ${chatId} (not in allowedChatIds)`)
      return undefined
    }
    const text = String(inbound.text ?? '').trim()
    if (!text) return undefined
    const chat = chatOf(chatId, {
      name: String(inbound.chatName ?? inbound.name ?? chatId),
      kind: inbound.kind === 'group' ? 'group' : (inbound.kind ?? 'private'),
      ...(Array.isArray(inbound.members) ? { members: inbound.members } : {}),
    })
    const message = pushMessage(chatId, {
      direction: 'in',
      text,
      senderId: String(inbound.senderId ?? inbound.sender ?? chatId),
      senderName: String(inbound.senderName ?? inbound.sender ?? ''),
      messageId: inbound.messageId ? String(inbound.messageId) : undefined,
      time: Number.isSafeInteger(inbound.time) ? inbound.time : undefined,
    })
    state.counters.inbound += 1
    return { chatId, chat, message, text }
  }

  const dispatchInbound = (inbound) => {
    const accepted = ingest(inbound)
    if (!accepted) return false
    void handoff(accepted.chatId, accepted.text, {
      senderId: accepted.message.senderId,
      senderName: accepted.message.senderName,
      messageId: accepted.message.messageId,
    })
    return true
  }

  //  个人微信 hook：主动轮询 + 主动发送
  // ────────────────────────────────────────────────────────────────────────
  // 个人微信没有公开 API，只能靠一个本机 hook 服务（WeChatFerry / Gewechat / 自建）。
  // 约定：hook 服务提供 GET <messagesPath>?cursor=&limit= 与 POST <sendPath>。
  // 参考实现见 gateway/hook-gateway.mjs（含 mock 驱动，不需要微信也能联调）。
  const hookRuntime = {
    running: false,
    paused: false,
    timer: null,
    cursor: String(cfg.hook.cursor ?? ''),
    seen: new Set(),
    seenOrder: [],
    lastPollAt: 0,
    lastOkAt: 0,
    failures: 0,
    lastError: '',
    pulled: 0,
    startedAt: 0,
  }

  const hookReady = () => cfg.kind === 'hook' && Boolean(String(cfg.hook.baseUrl ?? '').trim())

  const rememberHookMessage = (id) => {
    if (!id) return false
    if (hookRuntime.seen.has(id)) return true
    hookRuntime.seen.add(id)
    hookRuntime.seenOrder.push(id)
    if (hookRuntime.seenOrder.length > 1000) {
      const dropped = hookRuntime.seenOrder.splice(0, hookRuntime.seenOrder.length - 1000)
      for (const old of dropped) hookRuntime.seen.delete(old)
    }
    return false
  }

  // ── 注入：把 hook DLL 送进微信进程 ──────────────────────────────────────
  // 个人微信的消息能力全部来自那个 DLL。注入器本体在 native/（win32，C 编译），
  // 插件只负责：找/拉起微信 → 调注入器 → 等 hook 服务起来 → 开始轮询。
  const injectorFile = () => {
    const raw = String(cfg.inject.injectorPath ?? '')
    if (!raw) return ''
    return isAbsolute(raw) ? raw : join(pluginRoot, raw.startsWith('./') ? raw.slice(2) : raw)
  }

  const injectStatus = () => ({
    configured: Boolean(injectorFile() && cfg.inject.hookDll),
    injectorPath: injectorFile(),
    injectorExists: Boolean(injectorFile()) && existsSync(injectorFile()),
    processName: cfg.inject.processName,
    wechatPath: cfg.inject.wechatPath,
    hookDll: cfg.inject.hookDll,
    hookDllExists: Boolean(cfg.inject.hookDll) && existsSync(cfg.inject.hookDll),
    ...(state.inject ? { last: state.inject } : {}),
  })

  const runFile = (file, args, timeoutMs) => new Promise((resolve, reject) => {
    const isScript = /\.(mjs|cjs|js)$/i.test(file)
    const command = isScript ? process.execPath : file
    const argv = isScript ? [file, ...args] : args
    execFile(command, argv, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && !stdout) { reject(error); return }
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), exitCode: error?.code ?? 0 })
    })
  })

  const injectWechat = async () => {
    const injector = injectorFile()
    if (!injector) return { ok: false, code: 'not-configured', message: 'inject.injectorPath 没配置' }
    if (!existsSync(injector)) return { ok: false, code: 'injector-missing', message: `找不到注入器：${injector}（先跑 native/build.ps1）` }
    if (!cfg.inject.hookDll) return { ok: false, code: 'dll-missing', message: 'inject.hookDll 没配置：那是与微信版本匹配的 hook DLL' }
    if (!existsSync(cfg.inject.hookDll)) return { ok: false, code: 'dll-missing', message: `找不到 DLL：${cfg.inject.hookDll}` }

    let launched = false
    if (cfg.inject.wechatPath) {
      try {
        const running = await runFile(process.platform === 'win32' ? 'tasklist' : 'ps', ['/FI', `IMAGENAME eq ${cfg.inject.processName}`], 8000).catch(() => undefined)
        const text = running ? running.stdout : ''
        if (!text || !text.toLowerCase().includes(String(cfg.inject.processName).toLowerCase())) {
          const child = spawn(cfg.inject.wechatPath, [], { detached: true, stdio: 'ignore', windowsHide: false })
          child.unref()
          launched = true
          await new Promise((resolve) => setTimeout(resolve, 4000))
        }
      } catch (error) {
        debug(`auto-launch failed: ${error?.message ?? error}`)
      }
    }

    let result
    try {
      const outcome = await runFile(injector, ['--process', cfg.inject.processName, '--dll', cfg.inject.hookDll, '--json', '--timeout', String(Number(cfg.inject.timeoutMs) || 15000)], (Number(cfg.inject.timeoutMs) || 15000) + 8000)
      const line = outcome.stdout.split('\n').map((item) => item.trim()).filter(Boolean).pop() ?? ''
      try {
        result = JSON.parse(line)
      } catch {
        result = { ok: false, code: 'bad-output', message: (line || outcome.stderr || '注入器没有输出').slice(0, 300) }
      }
    } catch (error) {
      result = { ok: false, code: 'injector-failed', message: String(error?.message ?? error).slice(0, 300) }
    }

    state.inject = { at: Date.now(), launched, ...result }
    if (result.ok) log('info', `已注入 ${cfg.inject.processName}（pid ${result.pid ?? '?'}）`)
    else log('warn', `注入失败（${result.code ?? 'unknown'}）：${result.message ?? ''}`)
    persist()

    let service = { ready: false }
    if (result.ok && Number(cfg.inject.waitForServiceMs) > 0 && cfg.hook.baseUrl) {
      const deadline = Date.now() + Number(cfg.inject.waitForServiceMs)
      const base = String(cfg.hook.baseUrl).replace(/\/+$/, '')
      while (Date.now() < deadline) {
        try {
          const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) })
          if (response.ok) { service = { ready: true }; break }
        } catch { /* 还没起来 */ }
        await new Promise((resolve) => setTimeout(resolve, 600))
      }
      if (service.ready && cfg.kind === 'hook') {
        if (!hookRuntime.running) startHook()
        service.started = true
      }
    }
    return { ...result, launched, service }
  }

  const hookStatus = () => ({
    kind: cfg.kind,
    configured: hookReady(),
    baseUrl: cfg.hook.baseUrl ?? '',
    secretSet: Boolean(cfg.hook.secret),
    running: hookRuntime.running,
    paused: hookRuntime.paused,
    cursor: hookRuntime.cursor,
    pollMs: Number(cfg.hook.pollMs) || 3000,
    lastPollAt: hookRuntime.lastPollAt,
    lastOkAt: hookRuntime.lastOkAt,
    failures: hookRuntime.failures,
    lastError: hookRuntime.lastError,
    pulled: hookRuntime.pulled,
    seen: hookRuntime.seen.size,
    startedAt: hookRuntime.startedAt,
  })

  /** 拉一次。成功返回 { ok, cursor, accepted, skipped, total }。 */
  const pollHookOnce = async () => {
    if (!hookReady()) return { ok: false, detail: 'kind!=hook 或 hook.baseUrl 未配置' }
    const base = String(cfg.hook.baseUrl).replace(/\/+$/, '')
    const query = new URLSearchParams()
    if (hookRuntime.cursor) query.set('cursor', hookRuntime.cursor)
    query.set('limit', String(Math.max(1, Math.min(200, Number(cfg.hook.limit) || 50))))
    const headers = {}
    if (cfg.hook.secret) headers['x-wechat-secret'] = cfg.hook.secret
    hookRuntime.lastPollAt = Date.now()

    let payload
    try {
      const response = await fetch(`${base}${cfg.hook.messagesPath || '/messages'}?${query.toString()}`, {
        headers,
        signal: AbortSignal.timeout(Math.max(1000, Number(cfg.hook.timeoutMs) || 8000)),
      })
      const text = await response.text()
      if (!response.ok) throw new Error(`HTTP ${response.status} ${text.slice(0, 200)}`)
      payload = text.trim() ? JSON.parse(text) : {}
    } catch (error) {
      hookRuntime.failures += 1
      hookRuntime.lastError = String(error?.message ?? error).slice(0, 300)
      state.counters.errors += 1
      log('warn', `hook poll failed (${hookRuntime.failures}): ${hookRuntime.lastError}`)
      const maxFailures = Number(cfg.hook.maxFailures) || 0
      if (maxFailures > 0 && hookRuntime.failures >= maxFailures) {
        hookRuntime.paused = true
        log('warn', `hook 轮询连续失败 ${hookRuntime.failures} 次，已暂停（到面板里点“继续/poll”或重启插件）`)
      }
      return { ok: false, detail: hookRuntime.lastError, failures: hookRuntime.failures }
    }

    hookRuntime.failures = 0
    hookRuntime.paused = false
    hookRuntime.lastOkAt = Date.now()
    hookRuntime.lastError = ''
    const list = Array.isArray(payload) ? payload : (Array.isArray(payload?.messages) ? payload.messages : [])
    const nextCursor = payload?.cursor ?? payload?.nextCursor
    const selfIds = new Set((cfg.hook.selfIds ?? []).map((item) => String(item)))
    let accepted = 0
    let skipped = 0
    for (const raw of list) {
      const id = raw?.id ?? raw?.messageId
      if (id !== undefined && rememberHookMessage(String(id))) { skipped += 1; continue }
      const senderId = String(raw?.senderId ?? raw?.sender ?? raw?.from ?? '')
      if (selfIds.size > 0 && selfIds.has(senderId)) { skipped += 1; continue }
      const ok = dispatchInbound({
        chatId: raw?.chatId ?? raw?.from ?? raw?.roomId ?? raw?.wxid,
        chatName: raw?.chatName ?? raw?.name ?? raw?.roomName,
        kind: raw?.kind ?? (raw?.roomId ? 'group' : 'private'),
        senderId,
        senderName: raw?.senderName ?? raw?.name,
        text: raw?.text ?? raw?.content,
        messageId: id,
        members: raw?.members,
        time: Number.isSafeInteger(raw?.time) ? raw.time : undefined,
      })
      if (ok) accepted += 1
      else skipped += 1
    }
    if (nextCursor !== undefined && nextCursor !== null) {
      hookRuntime.cursor = String(nextCursor)
      cfg.hook.cursor = hookRuntime.cursor
    }
    hookRuntime.pulled += accepted
    persist()
    debug(`hook poll: +${accepted} accepted / ${skipped} skipped, cursor=${hookRuntime.cursor}`)
    return { ok: true, cursor: hookRuntime.cursor, accepted, skipped, total: list.length }
  }

  const scheduleHook = (delay) => {
    if (hookRuntime.timer) { clearTimeout(hookRuntime.timer); hookRuntime.timer = null }
    if (!hookRuntime.running) return
    const wait = Math.max(300, Number(delay ?? cfg.hook.pollMs) || 3000)
    hookRuntime.timer = setTimeout(() => {
      hookRuntime.timer = null
      void (async () => {
        const result = await pollHookOnce()
        if (!hookRuntime.running) return
        if (result.ok) {
          scheduleHook(cfg.hook.pollMs)
        } else if (!hookRuntime.paused) {
          const backoff = Math.min(60000, (Number(cfg.hook.pollMs) || 3000) * 2 ** Math.min(hookRuntime.failures, 4))
          scheduleHook(backoff)
        }
      })()
    }, wait)
    if (typeof hookRuntime.timer.unref === 'function') hookRuntime.timer.unref()
  }

  const startHook = () => {
    if (!hookReady()) return { ok: false, detail: 'kind!=hook 或 hook.baseUrl 未配置' }
    // 暂停（连续失败到 maxFailures）时 running 仍为 true，但计时器已经停了：
    // 这里的 start 必须能把它救回来，否则面板上的「开始轮询」点了没反应。
    const resuming = hookRuntime.running && hookRuntime.paused
    if (hookRuntime.running && !resuming) return { ok: true, running: true, detail: '已在轮询' }
    hookRuntime.running = true
    hookRuntime.paused = false
    hookRuntime.failures = 0
    hookRuntime.lastError = ''
    if (!hookRuntime.startedAt) hookRuntime.startedAt = Date.now()
    scheduleHook(0)
    log('info', `${resuming ? '已恢复' : '已启动'} hook 轮询 → ${cfg.hook.baseUrl}`)
    return {
      ok: true,
      running: true,
      cursor: hookRuntime.cursor,
      ...(resuming ? { resumed: true, detail: '已恢复轮询' } : { detail: '已启动轮询' }),
    }
  }

  const stopHook = () => {
    hookRuntime.running = false
    if (hookRuntime.timer) { clearTimeout(hookRuntime.timer); hookRuntime.timer = null }
    return { ok: true, running: false }
  }

  const resetHookCursor = (cursor) => {
    hookRuntime.cursor = String(cursor ?? '')
    cfg.hook.cursor = hookRuntime.cursor
    hookRuntime.failures = 0
    hookRuntime.paused = false
    return { ok: true, cursor: hookRuntime.cursor }
  }

  ctx.effect(() => {
    if (cfg.kind === 'hook' && cfg.hook.autoStart && cfg.hook.baseUrl) startHook()
    return () => { stopHook() }
  }, 'wechat-bridge.hookPoller()')

  // ── HTTP 路由 ───────────────────────────────────────────────────────────
  const path = cfg.webhookPath.startsWith('/') ? cfg.webhookPath : `/${cfg.webhookPath}`
  /** 面板管理接口前缀：默认 /wechat/webhook → /wechat/api/*。 */
  const PANEL_BASE = path.endsWith('/webhook') ? path.slice(0, -'/webhook'.length) || '/' : path

  const chatSummary = () => [...state.chats.values()].map((chat) => ({
    chatId: chat.chatId,
    name: chat.name || chat.chatId,
    kind: chat.kind,
    unread: unreadOf(chat.chatId).length,
    messages: messagesOf(chat.chatId).length,
    lastAt: chat.lastAt ?? 0,
    readThrough: chat.readThrough ?? 0,
    sessionId: state.sessions.get(chat.chatId) ?? null,
    members: Array.isArray(chat.members) ? chat.members.length : 0,
  })).sort((left, right) => (right.lastAt ?? 0) - (left.lastAt ?? 0))

  const snapshot = () => {
    if (Date.now() - presets.at > 10000) void refreshPresets()
    const chats = chatSummary()
    return {
      ok: true,
      plugin: { name, activatedAt: state.startedAt, uptimeMs: Date.now() - state.startedAt },
      config: {
        kind: cfg.kind,
        webhookPath: path,
        apiBase: `${PANEL_BASE}/api`,
        enabled: cfg.enabled,
        agentPreset: cfg.reply.agentPreset,
        fallbackPreset: cfg.reply.fallbackPreset,
        mode: cfg.reply.mode,
        prefix: cfg.reply.prefix,
        suffix: cfg.reply.suffix,
        maxReplyChars: cfg.reply.maxReplyChars,
        fallbackText: cfg.reply.fallbackText,
        allowedChatIds: cfg.reply.allowedChatIds ?? [],
        selfNames: cfg.reply.selfNames ?? [],
        idleSessionMs: cfg.reply.idleSessionMs,
        maxMessages: cfg.history.maxMessages,
        debug: cfg.debug,
        // hook 配置同样只回「是否已设置」
        inject: {
          injectorPath: cfg.inject.injectorPath ?? '',
          processName: cfg.inject.processName ?? '',
          hookDll: cfg.inject.hookDll ?? '',
          hookDllSet: Boolean(cfg.inject.hookDll),
        },
        hook: {
          baseUrl: cfg.hook.baseUrl ?? '',
          secretSet: Boolean(cfg.hook.secret),
          pollMs: Number(cfg.hook.pollMs) || 3000,
          limit: Number(cfg.hook.limit) || 50,
          selfIds: cfg.hook.selfIds ?? [],
          autoStart: cfg.hook.autoStart !== false,
        },
        // 凭据只回「是否已设置」，绝不把明文送进浏览器
        gateway: {
          sendUrl: cfg.gateway.sendUrl,
          appId: cfg.gateway.appId,
          wecom: Boolean(cfg.gateway.wecomWebhook),
          sharedSecretSet: Boolean(cfg.gateway.sharedSecret),
          appSecretSet: Boolean(cfg.gateway.appSecret),
          tokenSet: Boolean(cfg.gateway.token),
        },
      },
      autoReply: !autoReplyOff,
      hook: hookStatus(),
      inject: injectStatus(),
      agentServices: Boolean(agentApi),
      presets: presets.list,
      presetsError: presets.error,
      persona: { file: cfg.persona.file ?? '', chars: personaText.length, inject: Boolean(cfg.persona.inject) },
      chats,
      counters: state.counters,
      lastError: state.lastError,
      sessions: state.sessions.size,
      memory: {
        topics: state.memory.topics.length,
        thoughts: state.memory.thoughts.length,
        impressions: state.memory.impressions.length,
      },
      override,
    }
  }

  // ── 面板动作 ────────────────────────────────────────────────────────────
  const hooks = {
    listChats: chatSummary,

    readChat: (chatId, limit) => {
      const chat = state.chats.get(chatId)
      const list = messagesOf(chatId).slice(-limit)
      return {
        chat: chat ? { chatId: chat.chatId, name: chat.name, kind: chat.kind, readThrough: chat.readThrough ?? 0, lastAt: chat.lastAt ?? 0 } : null,
        messages: list,
        unread: unreadOf(chatId).length,
      }
    },

    /** 标记已读到某个水位（面板里点「标记已读」）。 */
    markRead: (chatId, throughSeq) => {
      const chat = chatOf(chatId)
      const list = messagesOf(chatId)
      const lastInbound = list.filter((message) => message.direction === 'in').reduce((max, message) => Math.max(max, message.seq), 0)
      const wanted = Number.isFinite(Number(throughSeq)) && Number(throughSeq) > 0
        ? Math.min(Number(throughSeq), state.seq)
        : (lastInbound > 0 ? lastInbound : state.seq)
      chat.readThrough = Math.max(chat.readThrough ?? 0, wanted)
      persist()
      return { ok: true, chatId, readThroughSeq: chat.readThrough, unreadCount: unreadOf(chatId).length }
    },

    /** 入站自测：默认只走「校验 + 落库」，不唤醒 agent（避免真的往微信发消息）。 */
    inbound: async (body) => {
      const chatId = String(body?.chatId ?? '').trim() || 'wechat-selftest'
      const text = String(body?.text ?? '').trim() || '面板入站自测'
      const wake = body?.wake === true
      if (wake) {
        const accepted = dispatchInbound({
          chatId,
          chatName: chatId,
          kind: String(body?.kind ?? 'private'),
          text,
          senderId: 'panel',
          senderName: '面板自测',
        })
        return accepted
          ? { ok: true, chatId, detail: '已受理并唤醒 agent；回复结束时会投递回微信' }
          : { ok: false, chatId, detail: '未受理：chatId 被 allowedChatIds 拦截，或文本为空' }
      }
      const accepted = ingest({
        chatId,
        chatName: chatId,
        kind: String(body?.kind ?? 'private'),
        text,
        senderId: 'panel',
        senderName: '面板自测',
      })
      return accepted
        ? { ok: true, chatId, detail: `已落库（seq ${accepted.message.seq}），未唤醒 agent` }
        : { ok: false, chatId, detail: '未受理：chatId 被 allowedChatIds 拦截，或文本为空' }
    },

    /** 出站自测：真投递一条。 */
    outbound: async (body) => {
      const chatId = String(body?.chatId ?? '').trim()
      const text = String(body?.text ?? '').trim()
      if (!chatId) return { ok: false, detail: '缺少 chatId' }
      if (!text) return { ok: false, detail: '缺少 text' }
      const outcome = await deliver(chatId, replyText(text))
      if (outcome.ok) {
        state.counters.outbound += 1
        pushMessage(chatId, { direction: 'out', text, senderId: 'panel', senderName: 'panel' })
      }
      return { ok: outcome.ok, chatId, detail: outcome.detail }
    },

    /**
     * 入站链路体检：用临时会话走一遍真实的 ingest（含 allowedChatIds 过滤与落库），
     * 校验完立刻把临时会话从内存里擦掉，不留痕迹、不碰网络。
     */
    selftestInbound: async () => {
      const probeId = `wechat-probe-${randomUUID().slice(0, 8)}`
      try {
        const accepted = ingest({ chatId: probeId, chatName: probeId, kind: 'private', text: '入站链路自检', senderId: 'probe' })
        if (!accepted) {
          const blocked = (cfg.reply.allowedChatIds ?? []).filter(Boolean).length > 0
          return {
            ok: false,
            detail: blocked
              ? `被 allowedChatIds 拦截（当前白名单 ${cfg.reply.allowedChatIds.length} 项）`
              : 'ingest 拒绝了探针消息',
          }
        }
        return { ok: true, detail: `落库正常（seq ${accepted.message.seq}，临时会话已清理）` }
      } finally {
        state.chats.delete(probeId)
        state.messages.delete(probeId)
        persist()
      }
    },

    /** 网关可达性：拿到任何 HTTP 响应即为可达，网络层失败才算不可达。 */
    selftestGateway: async () => {
      const url = cfg.gateway.sendUrl
      if (!url) return { ok: false, skipped: true, detail: '未配置 gateway.sendUrl' }
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timer = controller === null ? null : setTimeout(() => controller.abort(), 4000)
      try {
        const headers = { 'content-type': 'application/json' }
        if (cfg.gateway.sharedSecret) headers['x-wechat-secret'] = cfg.gateway.sharedSecret
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ action: 'probe', probe: true }),
          signal: controller === null ? undefined : controller.signal,
        })
        return {
          ok: true,
          detail: `HTTP ${response.status}（探针不带 chatId/text，网关应忽略；4xx/5xx 也算可达）`,
        }
      } catch (error) {
        const aborted = controller !== null && controller.signal.aborted
        return { ok: false, detail: aborted ? '4 秒超时' : String(error?.message ?? error).slice(0, 300) }
      } finally {
        if (timer !== null) clearTimeout(timer)
      }
    },

    /* ── 个人微信 hook ── */
    hookStatus: () => hookStatus(),
    hookStart: () => startHook(),
    hookStop: () => stopHook(),
    hookPoll: () => pollHookOnce(),
    hookResetCursor: (cursor) => resetHookCursor(cursor),
    injectStatus: () => injectStatus(),
    injectWechat: () => injectWechat(),

    /** 清本地缓存（等同 /wechat reset），不动真实微信会话与 DSH session。 */
    reset: () => {
      const chats = state.chats.size
      state.chats.clear()
      state.messages.clear()
      state.sessions.clear()
      state.memory = { topics: [], thoughts: [], impressions: [] }
      state.lastError = null
      relays.clear()
      persist()
      return { chats }
    },
  }


  ctx.inject(['webServer'], (scoped) => {
    const server = scoped.webServer
    const STATUS_PATH = `${path}/status`

    scoped.effect(() => server.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? path, 'http://localhost')
          if (req.method === 'GET') {
            // 微信公众平台服务器配置：签名校验并回 echostr
            const signature = url.searchParams.get('signature') ?? ''
            const timestamp = url.searchParams.get('timestamp') ?? ''
            const nonce = url.searchParams.get('nonce') ?? ''
            const echostr = url.searchParams.get('echostr') ?? ''
            if (cfg.kind === 'official' && cfg.gateway.token) {
              const expected = createHash('sha1')
                .update([cfg.gateway.token, timestamp, nonce].sort().join(''))
                .digest('hex')
              if (expected !== signature) return sendText(res, 403, 'bad signature')
              return sendText(res, 200, echostr)
            }
            return sendJson(res, 200, { ok: true, path, kind: cfg.kind, chats: state.chats.size })
          }

          const body = await readBody(req)

          if (cfg.kind === 'official') {
            const signature = url.searchParams.get('signature') ?? ''
            const timestamp = url.searchParams.get('timestamp') ?? ''
            const nonce = url.searchParams.get('nonce') ?? ''
            if (cfg.gateway.token) {
              const expected = createHash('sha1')
                .update([cfg.gateway.token, timestamp, nonce].sort().join(''))
                .digest('hex')
              if (expected !== signature) return sendText(res, 403, 'bad signature')
            }
            const messageType = xmlValue(body, 'MsgType')
            const from = xmlValue(body, 'FromUserName')
            const content = xmlValue(body, 'Content')
            if (messageType === 'text' && from && content) {
              dispatchInbound({
                chatId: from,
                text: content,
                senderId: from,
                senderName: xmlValue(body, 'FromUserName'),
                messageId: xmlValue(body, 'MsgId'),
                kind: 'private',
              })
            } else {
              debug(`ignored official message type=${messageType || '?'}`)
            }
            // 公众号要求 5 秒内回 200；回复走客服消息接口异步发送。
            return sendText(res, 200, 'success')
          }

          if (cfg.gateway.sharedSecret) {
            const presented = req.headers['x-wechat-secret'] ?? ''
            if (presented !== cfg.gateway.sharedSecret) return sendJson(res, 401, { ok: false, error: 'bad secret' })
          }
          let payload
          try {
            payload = JSON.parse(body)
          } catch {
            return sendJson(res, 400, { ok: false, error: 'invalid json' })
          }
          const message = payload.message ?? payload
          const accepted = dispatchInbound({
            chatId: message.chatId ?? message.from ?? message.roomId,
            chatName: message.chatName ?? message.roomName ?? message.fromName,
            kind: message.kind ?? (message.roomId ? 'group' : 'private'),
            text: message.text ?? message.content,
            senderId: message.senderId ?? message.from,
            senderName: message.senderName ?? message.fromName,
            messageId: message.messageId ?? message.id,
            members: message.members,
            time: message.time,
          })
          return sendJson(res, accepted ? 200 : 202, { ok: true, accepted })
        } catch (error) {
          state.counters.errors += 1
          log('warn', `webhook failed: ${error?.message ?? error}`)
          return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }), 'wechat-bridge.route()')

    scoped.effect(() => server.register({
      kind: 'exact',
      path: STATUS_PATH,
      handler: async (_req, res) => {
        sendJson(res, 200, {
          ok: true,
          kind: cfg.kind,
          enabled: cfg.enabled,
          autoReply: !autoReplyOff,
          gateway: {
            sendUrl: cfg.gateway.sendUrl,
            secretRequired: Boolean(cfg.gateway.sharedSecret),
            appId: cfg.gateway.appId,
            wecom: Boolean(cfg.gateway.wecomWebhook),
          },
          agentPreset: cfg.reply.agentPreset,
          chats: [...state.chats.values()].map((chat) => ({
            chatId: chat.chatId,
            name: chat.name,
            kind: chat.kind,
            unread: unreadOf(chat.chatId).length,
            sessionId: state.sessions.get(chat.chatId) ?? null,
          })),
          counters: state.counters,
          lastError: state.lastError,
          inject: state.inject,
          persona: { injected: Boolean(personaText), chars: personaText.length },
        })
      },
    }), 'wechat-bridge.statusRoute()')

    // 统一管理面板：/api/state、/api/config、/api/console、/api/selftest、/api/chats、/api/reset
    scoped.effect(() => {
      const handle = createPanel({
        server,
        base: PANEL_BASE,
        runtime: {
          conf: cfg,
          override,
          setAutoReply: (value) => {
            autoReplyOff = !value
            cfg.reply.autoReply = value
          },
          /** 面板改完 hook 配置后让轮询器按新配置重来。 */
          restartHook: () => {
            stopHook()
            if (cfg.kind === 'hook' && cfg.hook.autoStart !== false && cfg.hook.baseUrl) startHook()
          },
        },
        snapshot,
        hooks,
        overrideFile,
      })
      panel = handle
      handle.pushEvent('info', '管理面板已挂载', `${handle.api}（${path}）`)
      void refreshPresets()
      return () => {
        panel = undefined
        void handle.dispose()
      }
    }, 'wechat-bridge.panel()')

    debug(`routes registered: ${path} panel: ${PANEL_BASE}/api`)
  })

  // ── 工具面 ──────────────────────────────────────────────────────────────
  const MSG_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
      seq: { type: 'integer', required: true },
      chatId: { type: 'string', required: true },
      direction: { type: 'string', required: true, enum: ['in', 'out'] },
      text: { type: 'string', required: true },
      senderId: { type: 'string' },
      senderName: { type: 'string' },
      messageId: { type: 'string' },
      time: { type: 'integer' },
    },
  }
  const MESSAGES_OUTPUT = {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean', required: true },
        chatId: { type: 'string', required: true },
        messages: { type: 'array', required: true, items: MSG_SCHEMA },
        unreadCount: { type: 'integer', required: true },
        readThroughSeq: { type: 'integer', required: true },
      },
    },
    render: (_args, value) => [{
      type: 'text',
      text: value.messages.length === 0
        ? `微信会话 ${value.chatId} 没有消息。`
        : `微信会话 ${value.chatId}：${value.messages.length} 条（未读 ${value.unreadCount}，已读水位 ${value.readThroughSeq}）\n` +
          value.messages.map((m) => `${m.direction === 'in' ? '←' : '→'} [${m.seq}] ${m.senderName || m.senderId || ''}: ${m.text}`).join('\n'),
    }],
  }

  const register = (definition) => ctx.effect(() => ctx.tools.register({
    ...definition,
    parameters: compileParameters(definition.parameters),
    output: { ...definition.output, schema: compileSchema(definition.output.schema) },
  }), `wechat-bridge.tool(${definition.name})`)

  register({
    name: 'wechat_status',
    description: '查看微信桥接状态：网关类型、路由、会话数、未读总数、计数器、人格是否已注入。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          kind: { type: 'string', required: true },
          autoReply: { type: 'boolean', required: true },
          chats: { type: 'integer', required: true },
          unread: { type: 'integer', required: true },
          sessions: { type: 'integer', required: true },
          personaChars: { type: 'integer', required: true },
          inbound: { type: 'integer', required: true },
          outbound: { type: 'integer', required: true },
          errors: { type: 'integer', required: true },
          lastError: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `微信桥接：${value.kind}｜自动回复 ${value.autoReply ? '开' : '关'}｜会话 ${value.chats}｜未读 ${value.unread}｜人格 ${value.personaChars} 字｜入站 ${value.inbound} 出站 ${value.outbound} 错误 ${value.errors}`,
      }],
    },
    execute: async () => {
      let unread = 0
      for (const chatId of state.chats.keys()) unread += unreadOf(chatId).length
      return {
        ok: true,
        kind: cfg.kind,
        autoReply: !autoReplyOff,
        chats: state.chats.size,
        unread,
        sessions: state.sessions.size,
        personaChars: personaText.length,
        inbound: state.counters.inbound,
        outbound: state.counters.outbound,
        errors: state.counters.errors,
        ...(state.lastError ? { lastError: `${state.lastError.phase}: ${state.lastError.message}` } : {}),
      }
    },
  })

  register({
    name: 'wechat_list_chats',
    description: '列出已知的微信会话（私聊/群），含未读数、最近消息时间与已托管的 agent 会话。',
    parameters: {
      limit: { type: 'integer', description: '最多返回多少个会话，默认 30，最大 100。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          chats: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                chatId: { type: 'string', required: true },
                name: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                unread: { type: 'integer', required: true },
                lastAt: { type: 'integer', required: true },
                sessionId: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.chats.length === 0
          ? '暂无微信会话记录。'
          : value.chats.map((c) => `${c.kind === 'group' ? '群' : '私'} ${c.name}(${c.chatId}) 未读 ${c.unread}`).join('\n'),
      }],
    },
    execute: async (args) => {
      const limit = Math.min(100, Math.max(1, Number(args?.limit) || 30))
      const chats = [...state.chats.values()]
        .sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0))
        .slice(0, limit)
        .map((chat) => ({
          chatId: chat.chatId,
          name: chat.name ?? chat.chatId,
          kind: chat.kind ?? 'private',
          unread: unreadOf(chat.chatId).length,
          lastAt: chat.lastAt ?? 0,
          ...(state.sessions.get(chat.chatId) ? { sessionId: state.sessions.get(chat.chatId) } : {}),
        }))
      return { ok: true, chats }
    },
  })

  register({
    name: 'wechat_get_unread_messages',
    description: '读取某个微信会话的未读入站消息（不自动标记已读；读完用 wechat_mark_read 提交水位）。',
    parameters: {
      chatId: { type: 'string', required: true, description: '会话 id（wxid 或群 id）。' },
      limit: { type: 'integer', description: '最多返回条数，默认 30，最大 100。' },
    },
    output: MESSAGES_OUTPUT,
    execute: async (args) => {
      const chatId = String(args?.chatId ?? '')
      const chat = chatOf(chatId)
      const unread = unreadOf(chatId)
      const limit = Math.min(100, Math.max(1, Number(args?.limit) || 30))
      return {
        ok: true,
        chatId,
        messages: unread.slice(-limit),
        unreadCount: unread.length,
        readThroughSeq: chat.readThrough ?? 0,
      }
    },
  })

  register({
    name: 'wechat_get_recent_messages',
    description: '读取某个微信会话的最近消息（含自己发出的），用于补看历史与上下文。',
    parameters: {
      chatId: { type: 'string', required: true, description: '会话 id。' },
      limit: { type: 'integer', description: '最多返回条数，默认 20，最大 100。' },
    },
    output: MESSAGES_OUTPUT,
    execute: async (args) => {
      const chatId = String(args?.chatId ?? '')
      const chat = chatOf(chatId)
      const limit = Math.min(100, Math.max(1, Number(args?.limit) || 20))
      const all = messagesOf(chatId)
      return {
        ok: true,
        chatId,
        messages: all.slice(-limit),
        unreadCount: unreadOf(chatId).length,
        readThroughSeq: chat.readThrough ?? 0,
      }
    },
  })

  register({
    name: 'wechat_send_message',
    description: '向微信会话发送文本。message 发一条，messages 数组分多条按顺序发出（更自然）。发送成功后本条 turn 不会再自动转发模型输出。',
    parameters: {
      chatId: { type: 'string', required: true, description: '会话 id。' },
      message: { type: 'string', description: '单条文本。' },
      messages: { type: 'array', description: '多条文本，按顺序逐条发送。', items: { type: 'string' } },
      replyToMessageId: { type: 'string', description: '要引用的入站消息 id（可选）。' },
      atUserId: { type: 'string', description: '要 @ 的成员 id（群聊可选）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          chatId: { type: 'string', required: true },
          sent: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                seq: { type: 'integer', required: true },
                text: { type: 'string', required: true },
                ok: { type: 'boolean', required: true },
              },
            },
          },
          detail: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `已向 ${value.chatId} 发送 ${value.sent.filter((s) => s.ok).length}/${value.sent.length} 条。`
          : `发送失败：${value.detail ?? 'unknown'}`,
      }],
    },
    execute: async (args, exec) => {
      const chatId = String(args?.chatId ?? '')
      const texts = []
      if (typeof args?.message === 'string' && args.message.trim()) texts.push(args.message)
      if (Array.isArray(args?.messages)) for (const item of args.messages) if (typeof item === 'string' && item.trim()) texts.push(item)
      if (texts.length === 0) return { ok: false, chatId, sent: [], detail: 'no text to send' }
      const sent = []
      let detail = ''
      let allOk = true
      for (const text of texts) {
        const outcome = await deliver(chatId, text, {
          replyToMessageId: args?.replyToMessageId,
          atUserId: args?.atUserId,
        })
        if (!outcome.ok) {
          allOk = false
          detail = outcome.detail
        }
        const record = pushMessage(chatId, {
          direction: 'out',
          text,
          senderId: 'self',
          senderName: 'self',
        })
        sent.push({ seq: record.seq, text, ok: outcome.ok })
        state.counters.outbound += outcome.ok ? 1 : 0
      }
      // 让自动转发跳过本轮，避免重复
      const sessionId = state.sessions.get(chatId)
      const relay = sessionId ? relays.get(sessionId) : undefined
      if (relay) relay.toolSent = true
      const agentSession = exec?.agent?.id
      if (!relay && agentSession) {
        const own = relays.get(agentSession)
        if (own) own.toolSent = true
      }
      return { ok: allOk, chatId, sent, detail }
    },
  })

  register({
    name: 'wechat_get_members',
    description: '查看某个微信群成员（由网关推送的成员列表；未推送则只包含已知发言人）。',
    parameters: {
      chatId: { type: 'string', required: true, description: '群 id。' },
      limit: { type: 'integer', description: '最多返回人数，默认 50。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          chatId: { type: 'string', required: true },
          members: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                userId: { type: 'string', required: true },
                name: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.members.length === 0
          ? `${value.chatId} 没有成员信息（网关未推送成员列表）。`
          : value.members.map((m) => `${m.name}(${m.userId})`).join('、'),
      }],
    },
    execute: async (args) => {
      const chatId = String(args?.chatId ?? '')
      const chat = chatOf(chatId)
      const limit = Math.min(200, Math.max(1, Number(args?.limit) || 50))
      const seen = new Map()
      for (const member of chat.members ?? []) {
        if (member?.userId) seen.set(String(member.userId), String(member.name ?? member.userId))
      }
      for (const message of messagesOf(chatId)) {
        if (message.direction !== 'in' || !message.senderId) continue
        if (!seen.has(message.senderId)) seen.set(message.senderId, message.senderName || message.senderId)
      }
      return { ok: true, chatId, members: [...seen.entries()].slice(0, limit).map(([userId, name]) => ({ userId, name })) }
    },
  })

  register({
    name: 'wechat_mark_read',
    description: '把某个微信会话标记为已读到指定水位（用未读/最近消息返回的 readThroughSeq 或消息 seq）。',
    parameters: {
      chatId: { type: 'string', required: true, description: '会话 id。' },
      throughSeq: { type: 'integer', description: '已读水位；省略则读到该会话最新一条。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          chatId: { type: 'string', required: true },
          throughSeq: { type: 'integer', required: true },
          unreadCount: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `${value.chatId} 已读到 ${value.throughSeq}，剩余未读 ${value.unreadCount}。` }],
    },
    execute: async (args) => {
      const chatId = String(args?.chatId ?? '')
      const chat = chatOf(chatId)
      const list = messagesOf(chatId)
      const fallback = list.length > 0 ? list[list.length - 1].seq : 0
      const throughSeq = Number.isSafeInteger(args?.throughSeq) ? Number(args.throughSeq) : fallback
      chat.readThrough = Math.max(chat.readThrough ?? 0, throughSeq)
      persist()
      return { ok: true, chatId, throughSeq: chat.readThrough, unreadCount: unreadOf(chatId).length }
    },
  })

  register({
    name: 'wechat_memory_append',
    description: '记录一条轻量记忆：进行中的话题（activeTopic）/想说未说的话（pendingThought）/对某人的印象（memberImpression）。',
    parameters: {
      category: { type: 'string', required: true, enum: ['activeTopic', 'pendingThought', 'memberImpression'], description: '记忆类别。' },
      content: { type: 'string', required: true, description: '记忆内容。' },
      target: { type: 'string', description: 'memberImpression 时的对象名字。' },
      chatId: { type: 'string', description: '关联会话 id（可选）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          category: { type: 'string', required: true },
          count: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `已记录 ${value.category} 记忆，共 ${value.count} 条。` }],
    },
    execute: async (args) => {
      const category = String(args?.category ?? '')
      const bucket = category === 'pendingThought' ? state.memory.thoughts
        : category === 'memberImpression' ? state.memory.impressions
          : state.memory.topics
      bucket.push({
        id: randomUUID(),
        content: String(args?.content ?? ''),
        ...(args?.target ? { target: String(args.target) } : {}),
        ...(args?.chatId ? { chatId: String(args.chatId) } : {}),
        time: Date.now(),
      })
      if (bucket.length > 50) bucket.splice(0, bucket.length - 50)
      persist()
      return { ok: true, category, count: bucket.length }
    },
  })

  register({
    name: 'wechat_memory_query',
    description: '查看当前记忆：话题、想说未说的话、成员印象。',
    parameters: {
      category: { type: 'string', enum: ['activeTopic', 'pendingThought', 'memberImpression'], description: '只看某一类。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                category: { type: 'string', required: true },
                content: { type: 'string', required: true },
                target: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.entries.length === 0
          ? '暂无记忆。'
          : value.entries.map((e) => `[${e.category}] ${e.content}${e.target ? `（${e.target}）` : ''}`).join('\n'),
      }],
    },
    execute: async (args) => {
      const wanted = args?.category
      const entries = []
      if (!wanted || wanted === 'activeTopic') for (const item of state.memory.topics) entries.push({ category: 'activeTopic', content: item.content })
      if (!wanted || wanted === 'pendingThought') for (const item of state.memory.thoughts) entries.push({ category: 'pendingThought', content: item.content })
      if (!wanted || wanted === 'memberImpression') {
        for (const item of state.memory.impressions) {
          entries.push({ category: 'memberImpression', content: item.content, ...(item.target ? { target: item.target } : {}) })
        }
      }
      return { ok: true, entries }
    },
  })

  register({
    name: 'wechat_memory_remove',
    description: '删除记忆：按内容匹配删话题/想法，按 target 删成员印象。',
    parameters: {
      category: { type: 'string', required: true, enum: ['activeTopic', 'pendingThought', 'memberImpression'], description: '记忆类别。' },
      content: { type: 'string', description: '要删除的话题/想法原文。' },
      target: { type: 'string', description: '要删除的成员印象对象。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          removed: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `已删除 ${value.removed} 条记忆。` }],
    },
    execute: async (args) => {
      const category = String(args?.category ?? '')
      let removed = 0
      if (category === 'memberImpression') {
        const target = String(args?.target ?? '')
        const before = state.memory.impressions.length
        state.memory.impressions = target
          ? state.memory.impressions.filter((item) => item.target !== target)
          : []
        removed = before - state.memory.impressions.length
      } else {
        const bucket = category === 'pendingThought' ? state.memory.thoughts : state.memory.topics
        const content = String(args?.content ?? '')
        const before = bucket.length
        const kept = content ? bucket.filter((item) => item.content !== content) : []
        if (category === 'pendingThought') state.memory.thoughts = kept
        else state.memory.topics = kept
        removed = before - kept.length
      }
      persist()
      return { ok: true, removed }
    },
  })


  register({
    name: 'wechat_diagnose',
    description: '自检自动回复链路：用一个探针会话真正走一遍「建 agent 会话 → 投递消息」并回报失败原因（排查“会话建了但没起 turn”）。只建一个以 wechat-probe- 开头的会话，不影响真实微信会话。',
    parameters: {
      text: { type: 'string', description: '探针消息正文，默认一句自检话术。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          agentServices: { type: 'boolean', required: true },
          preset: { type: 'string', required: true },
          sessionId: { type: 'string' },
          error: { type: 'string' },
          liveAgents: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `链路正常：agent 服务可用，preset=${value.preset}，探针会话 ${value.sessionId ?? '(已存在)'}，当前存活 agent ${value.liveAgents} 个。`
          : `链路失败：agentServices=${value.agentServices} preset=${value.preset} session=${value.sessionId ?? '(无)'}\n错误：${value.error ?? 'unknown'}`,
      }],
    },
    execute: async (args) => {
      const chatId = `wechat-probe-${randomUUID().slice(0, 8)}`
      const text = String(args?.text ?? '自检：确认链路可用，只回一句即可。')
      let liveAgents = 0
      try {
        liveAgents = agentApi?.agents?.list?.().length ?? 0
      } catch { /* ignore */ }
      if (!agentApi) {
        return { ok: false, agentServices: false, preset: cfg.reply.agentPreset, liveAgents, error: 'agents/agentPresets services are not composed in this profile' }
      }
      let sessionId
      try {
        const ensured = await ensureSession(chatId)
        sessionId = ensured.sessionId
        ensured.agent.followup(userMessage(text))
        return { ok: true, agentServices: true, preset: cfg.reply.agentPreset, sessionId, liveAgents }
      } catch (error) {
        recordError('diagnose', error)
        return { ok: false, agentServices: true, preset: cfg.reply.agentPreset, ...(sessionId ? { sessionId } : {}), liveAgents, error: String(error?.message ?? error).slice(0, 400) }
      }
    },
  })

  register({
    name: 'wechat_hook',
    description: '个人微信 hook 的运行控制：status=看状态，start/stop=开关主动轮询，poll=立刻拉一次，reset-cursor=把游标归零（下次从最新开始）。只在 kind=hook 时有意义。',
    parameters: {
      action: { type: 'string', required: true, enum: ['status', 'start', 'stop', 'poll', 'reset-cursor', 'inject'], description: '要做的动作；inject=把 hook DLL 注入微信进程（需要 native 注入器与匹配的 DLL）。' },
      cursor: { type: 'string', description: 'reset-cursor 时可指定新游标；省略=从最新开始。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          action: { type: 'string', required: true },
          kind: { type: 'string', required: true },
          running: { type: 'boolean', required: true },
          paused: { type: 'boolean', required: true },
          cursor: { type: 'string' },
          accepted: { type: 'integer' },
          skipped: { type: 'integer' },
          failures: { type: 'integer' },
          lastError: { type: 'string' },
          detail: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? [
            `hook ${value.kind}｜轮询 ${value.running ? '运行中' : '已停止'}${value.paused ? '（已暂停）' : ''}`,
            value.cursor ? `游标 ${value.cursor}` : '',
            value.accepted === undefined ? '' : `本次 +${value.accepted} 条 / 跳过 ${value.skipped}`,
            value.lastError ? `最近错误：${value.lastError}` : '',
          ].filter(Boolean).join('｜')
          : `hook 动作 ${value.action} 失败：${value.detail ?? value.lastError ?? 'unknown'}`,
      }],
    },
    execute: async (args) => {
      const action = String(args?.action ?? 'status')
      const base = { action, kind: cfg.kind, running: hookRuntime.running, paused: hookRuntime.paused }
      if (action === 'status') {
        const status = hookStatus()
        return {
          ok: true,
          ...base,
          running: status.running,
          paused: status.paused,
          cursor: status.cursor,
          failures: status.failures,
          ...(status.lastError ? { lastError: status.lastError } : {}),
          ...(status.configured ? {} : { detail: 'kind!=hook 或 hook.baseUrl 未配置' }),
        }
      }
      if (action === 'start') {
        const outcome = startHook()
        return { ok: outcome.ok !== false, ...base, running: hookRuntime.running, ...(outcome.cursor ? { cursor: outcome.cursor } : {}), ...(outcome.detail ? { detail: outcome.detail } : {}) }
      }
      if (action === 'stop') {
        stopHook()
        return { ok: true, ...base, running: false }
      }
      if (action === 'inject') {
        const outcome = await injectWechat()
        return {
          ok: outcome.ok === true,
          ...base,
          running: hookRuntime.running,
          ...(outcome.pid ? { detail: `已注入 pid ${outcome.pid}` } : {}),
          ...(outcome.ok ? {} : { detail: `${outcome.code ?? 'error'}: ${outcome.message ?? ''}`.slice(0, 300) }),
        }
      }
      if (action === 'reset-cursor') {
        const outcome = resetHookCursor(args?.cursor)
        return { ok: true, ...base, cursor: outcome.cursor }
      }
      const outcome = await pollHookOnce()
      return {
        ok: outcome.ok !== false,
        ...base,
        ...(outcome.cursor ? { cursor: outcome.cursor } : {}),
        ...(Number.isInteger(outcome.accepted) ? { accepted: outcome.accepted } : {}),
        ...(Number.isInteger(outcome.skipped) ? { skipped: outcome.skipped } : {}),
        ...(Number.isInteger(outcome.failures) ? { failures: outcome.failures } : {}),
        ...(outcome.detail ? { detail: outcome.detail } : {}),
      }
    },
  })

  register({
    name: 'wechat_get_prompt',
    description: '查看当前微信桥接的人格提示词、网关配置摘要、可用工具与已知会话，用于进入角色或刷新状态。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          persona: { type: 'string', required: true },
          kind: { type: 'string', required: true },
          autoReply: { type: 'boolean', required: true },
          chats: { type: 'integer', required: true },
          tools: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `【人格】\n${value.persona || '（未注入人格 md）'}\n\n【网关】${value.kind}｜自动回复 ${value.autoReply ? '开' : '关'}｜会话 ${value.chats}\n【工具】${value.tools.join('、')}`,
      }],
    },
    execute: async () => ({
      ok: true,
      persona: personaText,
      kind: cfg.kind,
      autoReply: !autoReplyOff,
      chats: state.chats.size,
      tools: ['wechat_status', 'wechat_hook', 'wechat_diagnose', 'wechat_list_chats', 'wechat_get_unread_messages', 'wechat_get_recent_messages', 'wechat_send_message', 'wechat_get_members', 'wechat_mark_read', 'wechat_memory_append', 'wechat_memory_query', 'wechat_memory_remove', 'wechat_get_prompt'],
    }),
  })

  // ── 人命令：/wechat on|off|status ──────────────────────────────────────
  ctx.inject(['commands'], (scoped) => {
    scoped.effect(() => scoped.commands.register({
      name: 'wechat',
      description: '微信桥接开关与状态：/wechat [on|off|status|reset]',
      input: { hint: 'on | off | status | reset' },
      async handler(invocation) {
        const action = String(invocation?.rawInput ?? '').trim().toLowerCase()
        if (action === 'on') {
          autoReplyOff = false
          return { kind: 'success', text: '微信自动回复已开启。' }
        }
        if (action === 'off') {
          autoReplyOff = true
          return { kind: 'success', text: '微信自动回复已关闭（工具面仍可用）。' }
        }
        if (action === 'reset') {
          // 清掉本地缓存的会话/消息/记忆与会话映射；不会动真实的微信会话，也不会删 DSH 里已有的 session。
          const chats = state.chats.size
          state.chats.clear()
          state.messages.clear()
          state.sessions.clear()
          state.memory = { topics: [], thoughts: [], impressions: [] }
          state.lastError = null
          relays.clear()
          persist()
          return { kind: 'success', text: `已清空本地微信缓存（${chats} 个会话）。` }
        }
        let unread = 0
        for (const chatId of state.chats.keys()) unread += unreadOf(chatId).length
        return {
          kind: 'success',
          text: `微信桥接 ${cfg.kind}｜自动回复 ${autoReplyOff ? '关' : '开'}｜会话 ${state.chats.size}｜未读 ${unread}｜会话池 ${state.sessions.size}`,
        }
      },
    }), 'wechat-bridge.command()')
  })

  // ── 会话回收 ────────────────────────────────────────────────────────────
  const idleMs = Number(cfg.reply.idleSessionMs) || 0
  if (idleMs > 0 && typeof setInterval === 'function') {
    const timer = setInterval(() => {
      const now = Date.now()
      for (const [sessionId, relay] of relays) {
        if (now - (relay.lastActive ?? 0) < idleMs) continue
        relays.delete(sessionId)
        for (const [chatId, mapped] of state.sessions) if (mapped === sessionId) state.sessions.delete(chatId)
      }
      persist()
    }, Math.min(idleMs, 60000))
    if (typeof timer.unref === 'function') timer.unref()
    ctx.effect(() => () => clearInterval(timer), 'wechat-bridge.idleTimer()')
  }

  persist()
  debug(`activated: kind=${cfg.kind} path=${path} autoReply=${!autoReplyOff}`)
}
