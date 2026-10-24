/**
 * 读 DSH 的 session.v4.jsonl.zstd（多帧 zstd，逐次 append 各自成帧）。
 * Node 的 zstdDecompressSync / createZstdDecompress 只还原第一帧，所以这里按帧魔数切分后逐帧解压。
 *
 * 用法：
 *   node scripts/peek.mjs <session.v4.jsonl.zstd> [--types]
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

const buffer = readFileSync(process.argv[2])
const offsets = []
for (let i = 0; i + 4 <= buffer.length; i++) {
  if (buffer[i] === MAGIC[0] && buffer[i + 1] === MAGIC[1] && buffer[i + 2] === MAGIC[2] && buffer[i + 3] === MAGIC[3]) offsets.push(i)
}
const parts = []
for (let index = 0; index < offsets.length; index++) {
  const start = offsets[index]
  const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length
  try {
    parts.push(zstdDecompressSync(buffer.subarray(start, end)).toString('utf8'))
  } catch {
    // 帧边界被误判（魔数出现在帧内）时跳过这一段
  }
}
const lines = parts.join('').split('\n').filter((line) => line.trim())
console.log(`frames: ${offsets.length}  lines: ${lines.length}`)

const types = new Map()
for (const line of lines) {
  let record
  try { record = JSON.parse(line) } catch { continue }
  const type = record.type ?? record.event?.type ?? '?'
  types.set(type, (types.get(type) ?? 0) + 1)
  if (process.argv.includes('--types')) continue
  const data = record.data ?? record.event?.data ?? {}
  const content = data.message?.content
  let text = ''
  if (Array.isArray(content)) text = content.filter((b) => b && b.type === 'text').map((b) => b.text).join(' ')
  if (text || type === 'turn/start' || type === 'turn/end') {
    console.log(`[${type}] ${(text || JSON.stringify(data)).slice(0, 300)}`)
  }
}
if (process.argv.includes('--types')) console.log([...types.entries()])
