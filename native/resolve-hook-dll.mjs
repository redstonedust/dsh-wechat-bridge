#!/usr/bin/env node
/**
 * resolve-hook-dll.mjs —— 按微信版本挑出**匹配的** hook DLL。
 *
 * 这是「适配性」的核心：hook DLL 与微信版本强绑定，版本不对注进去微信就崩。
 * 本脚本不去猜、不去编 URL，只做三件事：
 *   1. 在本地仓库目录（默认 native/hook-dlls/）里按命名/清单匹配版本；
 *   2. 匹配到就校验 sha256（清单里写了才校验）；
 *   3. 没匹配到就明确告诉你「缺哪个版本的文件、该放成什么名字」。
 *
 * 匹配优先级：
 *   hook-catalog.json 里 version 精确键
 *     → 同 major.minor.patch（3.9.12.*）
 *       → 同 major.minor（3.9.*）
 *         → 通配 "*"（你要自己保证兼容）
 *
 * 目录约定（任选其一）：
 *   native/hook-dlls/sdk-3.9.12.17.dll         ← 文件名里带版本
 *   native/hook-dlls/<任意>.dll + hook-catalog.json:
 *        { "3.9.12.17": { "file": "sdk.dll", "sha256": "…", "note": "wcferry" } }
 *
 * 用法：
 *   node native/resolve-hook-dll.mjs --version 3.9.12.17 --json
 *   node native/resolve-hook-dll.mjs --version 3.9.12.17 --dir D:\\hook-dlls
 *   node native/resolve-hook-dll.mjs --list
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = argv.indexOf(name)
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : fallback
}
const flag = (name) => argv.includes(name)

const wantJson = flag('--json')
const version = String(arg('--version', '')).trim()
const dirArg = arg('--dir', '')
const dllDir = dirArg ? (isAbsolute(dirArg) ? dirArg : resolve(process.cwd(), dirArg)) : join(here, 'hook-dlls')
const catalogPath = join(dllDir, 'hook-catalog.json')

const sha256 = (file) => {
  const hash = createHash('sha256')
  hash.update(readFileSync(file))
  return hash.digest('hex')
}

const out = (payload, code) => {
  if (wantJson) console.log(JSON.stringify(payload))
  else {
    if (payload.ok) {
      console.log(`\n匹配到 hook DLL\n`)
      console.log(`  版本    ${payload.version}`)
      console.log(`  匹配    ${payload.matchedBy}`)
      console.log(`  文件    ${payload.dllPath}`)
      console.log(`  大小    ${payload.size} bytes`)
      console.log(`  哈希    ${payload.hashOk === undefined ? '(清单未登记 sha256)' : payload.hashOk ? 'OK' : '不匹配'}`)
      if (payload.note) console.log(`  备注    ${payload.note}`)
      console.log('')
    } else {
      console.log(`\n没有可用的 hook DLL（${payload.code}）\n`)
      console.log(`  ${payload.message}`)
      if (payload.expected) console.log(`  期望文件  ${payload.expected}`)
      if (payload.available?.length) {
        console.log('  目录里现有：')
        for (const item of payload.available) console.log(`    · ${item}`)
      }
      console.log('')
    }
  }
  process.exit(code ?? (payload.ok ? 0 : 4))
}

/* ── 目录 ───────────────────────────────────────────────────────────────── */
if (!existsSync(dllDir)) {
  out({ ok: false, code: 'no-dir', message: `目录不存在：${dllDir}（建一个，把 hook DLL 放进去）`, dllPath: '', version }, 4)
}
const entries = readdirSync(dllDir).filter((name) => /\.dll$/i.test(name))
let catalog = {}
if (existsSync(catalogPath)) {
  try {
    catalog = JSON.parse(readFileSync(catalogPath, 'utf8'))
  } catch (error) {
    out({ ok: false, code: 'bad-catalog', message: `hook-catalog.json 不是合法 JSON：${error?.message ?? error}`, dllPath: '', version }, 4)
  }
}

if (flag('--list')) {
  const rows = entries.map((name) => {
    const full = join(dllDir, name)
    return { file: name, size: statSync(full).size }
  })
  if (wantJson) { console.log(JSON.stringify({ ok: true, dir: dllDir, files: rows, catalog })); process.exit(0) }
  console.log(`\n${dllDir}\n`)
  if (rows.length === 0) console.log('  （空目录）')
  for (const row of rows) console.log(`  ${row.file.padEnd(34)} ${row.size.toLocaleString()} bytes`)
  console.log('')
  process.exit(0)
}

if (!version) {
  out({ ok: false, code: 'bad-usage', message: '需要 --version <a.b.c.d>（或用 --list 看目录）', dllPath: '', version: '' }, 2)
}

/* ── 匹配 ───────────────────────────────────────────────────────────────── */
const parts = version.split('.').map((piece) => Number(piece) || 0)
const [major = 0, minor = 0, patch = 0] = parts

const catalogKeys = Object.keys(catalog)
const pickFromCatalog = (key) => {
  const entry = catalog[key]
  if (!entry) return undefined
  const file = String(entry.file ?? '').trim()
  if (!file) return undefined
  const full = isAbsolute(file) ? file : join(dllDir, file)
  if (!existsSync(full)) return undefined
  return { full, matchedBy: `catalog:${key}`, entry }
}

let hit = pickFromCatalog(version)
if (!hit) hit = pickFromCatalog(`${major}.${minor}.${patch}`)
if (!hit) {
  for (const key of catalogKeys) {
    const prefix = String(key)
    if (prefix.endsWith('.*') && version.startsWith(prefix.slice(0, -1))) {
      const candidate = pickFromCatalog(key)
      if (candidate) { hit = { ...candidate, matchedBy: `catalog-prefix:${key}` }; break }
    }
  }
}
if (!hit) {
  // 文件名带版本：sdk-3.9.12.17.dll / 3.9.12.17.dll
  const byName = entries.find((name) => name.includes(version))
    ?? entries.find((name) => name.startsWith(`${major}.${minor}.${patch}`))
    ?? entries.find((name) => new RegExp(`(^|[^0-9])${major}\\.${minor}\\.`).test(name))
  if (byName) hit = { full: join(dllDir, byName), matchedBy: `filename:${byName}`, entry: {} }
}
if (!hit) {
  for (const key of catalogKeys) {
    if (catalog[key]?.any === true) {
      const candidate = pickFromCatalog(key)
      if (candidate) { hit = { ...candidate, matchedBy: `catalog-any:${key}` }; break }
    }
  }
}

if (!hit) {
  out({
    ok: false,
    code: 'no-match',
    version,
    dllPath: '',
    message: `没有与 ${version} 匹配的 DLL。放一个 native/hook-dlls/sdk-${version}.dll，或在 hook-catalog.json 里登记它。`,
    expected: join(dllDir, `sdk-${version}.dll`),
    available: entries,
  }, 4)
}

const size = statSync(hit.full).size
const expectedHash = String(hit.entry?.sha256 ?? '').trim().toLowerCase()
let hashOk
if (expectedHash) hashOk = sha256(hit.full) === expectedHash

const payload = {
  ok: hashOk === false ? false : true,
  code: hashOk === false ? 'hash-mismatch' : 'ok',
  version,
  dllPath: hit.full,
  matchedBy: hit.matchedBy,
  size,
  ...(expectedHash ? { sha256: sha256(hit.full), expectedSha256: expectedHash, hashOk } : {}),
  ...(hit.entry?.note ? { note: String(hit.entry.note) } : {}),
  ...(hashOk === false ? { message: '文件 sha256 与清单不符，拒绝使用（可能被替换/下载不完整）' } : {}),
}
out(payload, payload.ok ? 0 : 5)
