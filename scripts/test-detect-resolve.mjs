#!/usr/bin/env node
/**
 * test-detect-resolve.mjs —— 「版本适配」这一层的测试：客户端探测 + DLL 解析。
 *
 * detect：真跑 native/detect-wechat.mjs（本机有微信就跑真判定，没微信就断言 client-missing 那条）。
 * resolve：用临时目录造 5 种情况——清单精确命中、清单前缀、文件名带版本、哈希不符、无匹配。
 *
 * 用法: node scripts/test-detect-resolve.mjs
 */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const detectScript = join(root, 'native', 'detect-wechat.mjs')
const resolveScript = join(root, 'native', 'resolve-hook-dll.mjs')

let failures = 0
const ok = (label) => console.log(`  ok   ${label}`)
const bad = (label, error) => { failures += 1; console.error(`  FAIL ${label}\n       ${error?.message ?? error}`) }
const check = async (label, fn) => {
  try { await fn(); ok(label) } catch (error) { bad(label, error) }
}
const run = (script, args) => new Promise((done) => {
  execFile(process.execPath, [script, ...args], { timeout: 40000 }, (error, stdout, stderr) => {
    done({ code: error?.code ?? 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
  })
})
const lastJson = (text) => {
  const line = String(text).split('\n').map((item) => item.trim()).filter(Boolean).pop() ?? ''
  return JSON.parse(line)
}

console.log('\n版本适配层测试\n')

/* ── 1) 客户端探测 ─────────────────────────────────────────────────────── */
await check('detect: 输出合法 JSON 且字段齐全', async () => {
  const result = await run(detectScript, ['--json'])
  const data = lastJson(result.stdout)
  for (const key of ['ok', 'found', 'family', 'version', 'arch', 'strategy', 'reason']) {
    assert.ok(Object.hasOwn(data, key), `缺少字段 ${key}`)
  }
  assert.ok(['wechat3', 'weixin4', null].includes(data.family))
  assert.ok(['wcferry-dll', 'unsupported', 'none'].includes(data.strategy))
})

await check('detect: 判定与家族一致（4.x 必须 unsupported 且给替代方案）', async () => {
  const data = lastJson((await run(detectScript, ['--json'])).stdout)
  if (data.family === 'weixin4') {
    assert.equal(data.strategy, 'unsupported')
    assert.ok(Array.isArray(data.alternatives) && data.alternatives.length >= 1, '4.x 必须给出替代路线')
  }
  if (data.family === 'wechat3') {
    assert.equal(data.strategy, 'wcferry-dll')
  }
  if (data.found === false) {
    assert.equal(data.strategy, 'none')
  }
})

/* ── 2) DLL 解析 ───────────────────────────────────────────────────────── */
const dir = join(tmpdir(), `wechat-hook-dlls-${process.pid}`)
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
const sha256 = (text) => createHash('sha256').update(Buffer.from(text)).digest('hex')

writeFileSync(join(dir, 'sdk-3.9.12.17.dll'), 'fixture-exact', 'utf8')
writeFileSync(join(dir, 'sdk-3.9.12.dll'), 'fixture-prefix', 'utf8')
writeFileSync(join(dir, 'legacy.dll'), 'fixture-catalog', 'utf8')
writeFileSync(join(dir, 'hook-catalog.json'), JSON.stringify({
  '3.9.12.17': { file: 'sdk-3.9.12.17.dll', sha256: sha256('fixture-exact'), note: 'exact' },
  '3.9.11.*': { file: 'sdk-3.9.12.dll', note: 'prefix' },
  '3.9.10.27': { file: 'legacy.dll', sha256: sha256('something-else'), note: 'bad-hash' },
  'x.y': { file: 'legacy.dll', note: 'catalog-only' },
}, null, 2))

await check('resolve: 清单精确命中 + 哈希校验通过', async () => {
  const data = lastJson((await run(resolveScript, ['--version', '3.9.12.17', '--dir', dir, '--json'])).stdout)
  assert.equal(data.ok, true)
  assert.equal(data.matchedBy, 'catalog:3.9.12.17')
  assert.equal(data.hashOk, true)
})

await check('resolve: 同前缀版本命中', async () => {
  const data = lastJson((await run(resolveScript, ['--version', '3.9.11.5', '--dir', dir, '--json'])).stdout)
  assert.equal(data.ok, true)
  assert.equal(data.matchedBy, 'catalog-prefix:3.9.11.*')
})

await check('resolve: 文件名带版本兜底', async () => {
  const data = lastJson((await run(resolveScript, ['--version', '3.9.12.99', '--dir', dir, '--json'])).stdout)
  assert.equal(data.ok, true)
  assert.match(data.matchedBy, /filename:/)
})

await check('resolve: 哈希不符时拒绝', async () => {
  const data = lastJson((await run(resolveScript, ['--version', '3.9.10.27', '--dir', dir, '--json'])).stdout)
  assert.equal(data.ok, false)
  assert.equal(data.code, 'hash-mismatch')
})

await check('resolve: 没有匹配时说清该放什么', async () => {
  const data = lastJson((await run(resolveScript, ['--version', '4.2.0.9', '--dir', dir, '--json'])).stdout)
  assert.equal(data.ok, false)
  assert.equal(data.code, 'no-match')
  assert.match(String(data.expected), /sdk-4\.2\.0\.9\.dll/)
})

await check('resolve: --list 列出目录', async () => {
  const data = lastJson((await run(resolveScript, ['--list', '--dir', dir, '--json'])).stdout)
  assert.equal(data.ok, true)
  assert.ok(data.files.length >= 3)
})

rmSync(dir, { recursive: true, force: true })
console.log(failures === 0 ? '\n全部通过 ✅\n' : `\n${failures} 项失败 ❌\n`)
process.exit(failures === 0 ? 0 : 1)
