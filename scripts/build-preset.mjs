#!/usr/bin/env node
/**
 * build-preset.mjs —— 把 persona/*.md + preset 定义渲染成 bundle patch（presets/wechat-agent.patch.yml）。
 *
 * 为什么需要生成：DSH 0.1.7+ 的 agent preset 是 loader 里的一条普通行
 * （@deepseek-ai/dsh-agent-preset），它的 config.plugins 必须是内联行列表，只能由 bundle patch 插入。
 * 人格正文写在 markdown 里、由本脚本渲染成 YAML 块标量，是唯一权威来源。
 *
 * 用法：
 *   node scripts/build-preset.mjs          # 生成/刷新
 *   node scripts/build-preset.mjs --check  # 只校验产物与源一致（不一致 exit 1）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const personaFile = path.join(root, 'persona', 'wechat-persona.md')
const outFile = path.join(root, 'presets', 'wechat-agent.patch.yml')

/** 块标量：把多行文本缩进到指定列。 */
function block(text, indent) {
  const pad = ' '.repeat(indent)
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\s+$/, '')
    .split('\n')
    .map((line) => (line.length === 0 ? '' : `${pad}${line}`))
    .join('\n')
}

function render() {
  const persona = fs.readFileSync(personaFile, 'utf8')
  const preset = {
    id: 'wechat-agent',
    name: '微信远程 Agent',
    description: '微信桥接专用：人格 md 注入 + wechat_* 工具；未调用发送工具时，本轮最终文本被原样发回微信。',
    order: 30,
  }
  const lines = []
  lines.push('# 本文件由 scripts/build-preset.mjs 生成，请勿手工编辑。')
  lines.push('# 源：persona/wechat-persona.md（人格正文）+ 本脚本内的 preset 元数据。')
  lines.push('# 作用：把 wechat-agent 作为一条 @deepseek-ai/dsh-agent-preset 行插入 profile，')
  lines.push('#       出现在 Web UI 的 agent 模式列表里；人格 md 渲染为 persona 行的 prefix。')
  lines.push('')
  lines.push('- insert:')
  lines.push(`    - id: preset-${preset.id}`)
  lines.push("      name: '@deepseek-ai/dsh-agent-preset'")
  lines.push('      config:')
  lines.push(`        id: ${preset.id}`)
  lines.push(`        name: ${preset.name}`)
  lines.push(`        description: ${preset.description}`)
  lines.push(`        order: ${preset.order}`)
  lines.push('        plugins:')
  lines.push('          - id: persona')
  lines.push("            name: '@deepseek-ai/dsh-persona'")
  lines.push('            config:')
  lines.push('              prefix: |-')
  lines.push(block(persona, 16))
  lines.push('          - id: tool-web')
  lines.push("            name: '@deepseek-ai/dsh-tool-web'")
  lines.push('          - id: tool-todo')
  lines.push("            name: '@deepseek-ai/dsh-tool-todo'")
  lines.push('            config:')
  lines.push('              allowParallelInProgress: true')
  lines.push('          - id: tool-ask-user')
  lines.push("            name: '@deepseek-ai/dsh-tool-ask-user'")
  lines.push('          - id: compaction')
  lines.push('            name: cordis:group')
  lines.push('            group: true')
  lines.push('            isolate:')
  lines.push('              compaction: true')
  lines.push('              toolResultPruner: true')
  lines.push('            config:')
  lines.push('              - id: compaction-basic')
  lines.push("                name: '@deepseek-ai/dsh-compaction-basic'")
  lines.push('              - id: command-compact')
  lines.push("                name: '@deepseek-ai/dsh-command-compact'")
  lines.push('              - id: tool-result-pruner')
  lines.push("                name: '@deepseek-ai/dsh-compaction-tool-result-pruner'")
  lines.push('                config:')
  lines.push('                  thresholdChars: 50000')
  lines.push('                  headChars: 45000')
  lines.push('                  tailChars: 2000')
  lines.push('')
  return lines.join('\n')
}

const output = render()
if (process.argv.includes('--check')) {
  const current = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : ''
  if (current !== output) {
    console.error(`stale: ${outFile} 与源不一致，请重新运行 node scripts/build-preset.mjs`)
    process.exit(1)
  }
  console.log('ok: preset patch is up to date')
} else {
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, output, 'utf8')
  console.log(`wrote ${outFile}`)
}
