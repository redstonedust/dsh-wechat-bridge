/**
 * 本地网关桩：接收插件投递出去的微信消息，逐行追加到日志文件。
 * 用于端到端验证「webhook 入站 → agent 回复 → 出站投递」，不连任何真实微信。
 *
 * 用法：
 *   node scripts/recv.mjs [port] [logFile]
 *   node scripts/recv.mjs 8787
 *   node scripts/recv.mjs 8787 .recv.log
 */
import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const port = Number(process.argv[2] ?? 8787)
const rawLog = process.argv[3]
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const logFile = rawLog
  ? (isAbsolute(rawLog) ? rawLog : resolve(process.cwd(), rawLog))
  : join(root, '.recv.log')

const server = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    if (req.method === 'POST') {
      const line = `${new Date().toISOString()} ${req.url} ${body}`
      try {
        appendFileSync(logFile, `${line}\n`, 'utf8')
      } catch (error) {
        console.error('stub: append failed:', error?.message ?? error)
      }
      console.log('recv:', body.slice(0, 300))
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
})

server.on('error', (error) => {
  console.error(`stub: cannot listen on ${port}: ${error?.message ?? error}`)
  process.exit(1)
})

server.listen(port, '127.0.0.1', () => {
  console.log(`gateway stub listening on http://127.0.0.1:${port}/send -> ${logFile}`)
})
