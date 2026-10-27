#!/usr/bin/env node
/**
 * test-hook-gateway.mjs —— gateway/hook-gateway.mjs 的自测（不需要微信、不占固定端口）。
 *
 * 覆盖 mock 驱动的完整契约：
 *   GET /health、GET /messages（游标增量）、POST /send、POST /mock/push、GET /mock/out、
 *   secret 校验（401）、坏 JSON（400）、未知路由（404）。
 *
 * 用法: node scripts/test-hook-gateway.mjs
 */
import { createGateway } from '../gateway/hook-gateway.mjs'
import assert from 'node:assert/strict'

let failures = 0
const ok = (label) => console.log(`  ok   ${label}`)
const bad = (label, error) => { failures += 1; console.error(`  FAIL ${label}\n       ${error?.message ?? error}`) }
const check = async (label, fn) => {
  try { await fn(); ok(label) } catch (error) { bad(label, error) }
}

const options = parseOptions({ driver: 'mock', port: 0, host: '127.0.0.1', secret: 'sekret', limit: 50, verbose: false })
function parseOptions(over) {
  return {
    driver: 'mock', port: 0, host: '127.0.0.1', secret: '', limit: 50,
    wcfBase: 'http://127.0.0.1:9999', getPath: '/{method}', sendPath: '/{method}',
    getMethod: 'get_msg', sendMethod: 'send_text', argStyle: 'args',
    getCmd: '', sendCmd: '', chatCacheMs: 30000, verbose: false, ...over,
  }
}

const { server } = createGateway(options)
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const auth = { 'x-wechat-secret': options.secret }

const call = async (path, init = {}) => {
  const response = await fetch(`${base}${path}`, init)
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : undefined }
}

console.log('\nhook-gateway 契约测试\n')

await check('GET /health 报告驱动名', async () => {
  const result = await call('/health')
  assert.equal(result.status, 200)
  assert.equal(result.body.driver, 'mock')
})

await check('未带 secret 的 /messages 返回 401', async () => {
  const result = await call('/messages')
  assert.equal(result.status, 401)
})

await check('POST /mock/push 造一条入站', async () => {
  const result = await call('/mock/push', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chatId: 'wxid_a', chatName: '阿黄', senderName: '阿黄', text: '在吗' }),
  })
  assert.equal(result.status, 200)
  assert.equal(result.body.message.text, '在吗')
})

await check('GET /messages 带游标返回增量 + 新游标', async () => {
  const first = await call('/messages?cursor=&limit=10', { headers: auth })
  assert.equal(first.status, 200)
  assert.equal(first.body.messages.length, 1)
  assert.equal(first.body.messages[0].chatId, 'wxid_a')
  assert.equal(first.body.messages[0].id, 'mock-1')
  const cursor = first.body.cursor
  assert.ok(cursor)

  const second = await call(`/messages?cursor=${encodeURIComponent(cursor)}&limit=10`, { headers: auth })
  assert.equal(second.body.messages.length, 0, '同一游标不应重复返回')

  await call('/mock/push', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chatId: 'room@chatroom', kind: 'group', senderId: 'wxid_b', senderName: '小B', text: '大家好' }),
  })
  const third = await call(`/messages?cursor=${encodeURIComponent(cursor)}&limit=10`, { headers: auth })
  assert.equal(third.body.messages.length, 1)
  assert.equal(third.body.messages[0].kind, 'group')
  assert.equal(third.body.messages[0].chatId, 'room@chatroom')
  assert.equal(third.body.messages[0].senderId, 'wxid_b')
})

await check('POST /send 记录出站并回 id', async () => {
  const result = await call('/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ chatId: 'wxid_a', text: '在的' }),
  })
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.ok(result.body.id)
})

await check('GET /mock/out 能看到刚发的那条', async () => {
  const result = await call('/mock/out')
  assert.equal(result.body.messages[0].text, '在的')
  assert.equal(result.body.messages[0].chatId, 'wxid_a')
})

await check('POST /send 缺字段返回 400', async () => {
  const result = await call('/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ chatId: 'wxid_a' }),
  })
  assert.equal(result.status, 400)
})

await check('坏 JSON 返回 400', async () => {
  const result = await call('/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: '{not json',
  })
  assert.equal(result.status, 400)
})

await check('未知路由返回 404', async () => {
  const result = await call('/nope', { headers: auth })
  assert.equal(result.status, 404)
})

await check('limit 上限被夹到 200', async () => {
  const result = await call('/messages?limit=99999', { headers: auth })
  assert.equal(result.status, 200)
})

server.close()
console.log(failures === 0 ? '\n全部通过 ✅\n' : `\n${failures} 项失败 ❌\n`)
process.exit(failures === 0 ? 0 : 1)
