/**
 * 面板的两种「不体面」失败模式，专门的回归测试：
 *
 *   A. 词典漏键 —— 手抖删掉一条翻译，界面上就会出现原始 key
 *      （`health.wechat.unverified` 这种），小白看不懂，等于白做。
 *   B. 数据异常 —— 快照缺字段、接口报错、lastError 有值时的渲染。
 *
 * 两种都只能在运行时发现，静态检查看不出来。用 SSR 直接渲染判定。
 *
 * 用法: node scripts/verify-client-states.mjs
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const profileRequire = createRequire(path.join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'desktop', 'index.cjs'));
const React = profileRequire('react');
const { renderToStaticMarkup } = profileRequire('react-dom/server');

let failures = 0;
const ok = (label) => console.log(`  ok   ${label}`);
const bad = (label, error) => {
  failures += 1;
  console.error(`  FAIL ${label}\n       ${error?.message ?? error}`);
};
const check = (label, fn) => {
  try {
    fn();
    ok(label);
  } catch (error) {
    bad(label, error);
  }
};

/* ── 装载 client.js ── */
const load = () => {
  let definition;
  const styleNodes = [];
  const documentStub = {
    head: { appendChild: (node) => styleNodes.push(node) },
    getElementById: () => null,
    createElement: (tag) => ({ tagName: tag, id: '', textContent: '' }),
  };
  const win = { __ModuleLoader__: { load: (v) => { definition = v; } } };
  new Function('window', 'document', readFileSync(path.join(root, 'client.js'), 'utf8'))(win, documentStub);
  return { definition, styleNodes };
};

const { definition } = load();
const mod = definition.factory((id) => {
  if (id === 'react') return React;
  throw new Error(`unexpected require: ${id}`);
});
const I = mod.__internals;
const dicts = I.dictionaries;

/* 组件通过模块级 translate 取词，必须走一遍 apply() 才会被注入。 */
const dictZh = dicts.zh;
const t = (key, params) => {
  let text = dictZh[key];
  if (text === undefined) return key;
  for (const [name, value] of Object.entries(params ?? {})) text = text.split(`{${name}}`).join(String(value));
  return text;
};
const fakeCtx = {
  effect: (fn) => fn(),
  locale: { register: () => () => {}, bind: () => t, subscribe: () => () => {} },
  slots: { inject: (name, fn) => fn(), register: () => () => {} },
};
mod.apply(fakeCtx);

/* 抓出所有用到的 key：直接从 source 里扫 t('...') / dict 引用不现实，
 * 改成「渲染出来的文本里不许出现形如 a.b.c 的原始 key」——更直接。 */
const RAW_KEY = /\b(?:health|panel|tab|overview|chats|console|settings|check|wizard|draft|field|btn|state|empty|error)\.[a-zA-Z][\w.]*\b/;
const RAW_KEY_ALLOW = [
  // 这些是真实配置键，本来就该显示给用户看
  'gateway.sendUrl', 'gateway.sharedSecret', 'gateway.appId', 'gateway.appSecret',
  'gateway.token', 'gateway.sendUrl', 'reply.autoReply', 'reply.prefix', 'reply.suffix',
  'reply.mode', 'reply.agentPreset', 'reply.selfNames', 'reply.allowedChatIds',
  'persona.file', 'persona.inject', 'history.maxMessages', 'debug', 'kind', 'webhookPath',
  'stateFile', 'stub.port', 'stub.running', 'api.base',
];
const leakOf = (html) => {
  const text = html.replace(/<[^>]+>/g, ' ');
  const hits = [];
  for (const match of text.matchAll(new RegExp(RAW_KEY.source, 'g'))) {
    const word = match[0];
    if (RAW_KEY_ALLOW.some((allowed) => word === allowed || word.startsWith(`${allowed}.`))) continue;
    hits.push(word);
  }
  return [...new Set(hits)];
};

/* ── 快照样本 ── */
const fixture = JSON.parse(readFileSync(path.join(root, 'scripts', 'fixtures', 'snapshot.json'), 'utf8'));

const tabs = [
  ['OverviewTab', () => React.createElement(I.OverviewTab, {
    snapshot: fixture, wizard: { step: 'stub', busy: false, error: '', completed: false, done: {} },
    onStubStart() {}, onPointAtStub() {}, onPing() {}, onWizardReset() {}, onStubStop() {},
  })],
  ['ChatsTab', () => React.createElement(I.ChatsTab, { snapshot: fixture, tick: 0, onRefresh() {} })],
  ['ConsoleTab', () => React.createElement(I.ConsoleTab, { snapshot: fixture, onRefresh() {} })],
  ['SettingsTab', () => React.createElement(I.SettingsTab, { snapshot: fixture, onSaved() {} })],
  ['CheckTab', () => React.createElement(I.CheckTab, { onRefresh() {} })],
];

/* 用指定语言渲染；client 的词典是通过 locale 注入的，SSR 里直接替换 t 太脆弱，
 * 改成拿两份词典做「键覆盖」检查 + 用中文渲染查原始 key 泄漏。 */
console.log('\n[A] 词典完整性');
check('zh / en 键数量一致', () => {
  const zh = Object.keys(dicts.zh).sort();
  const en = Object.keys(dicts.en).sort();
  if (zh.length !== en.length) throw new Error(`zh=${zh.length} en=${en.length}`);
});
check('zh 有、en 缺的键为零', () => {
  const missing = Object.keys(dicts.zh).filter((k) => !(k in dicts.en));
  if (missing.length) throw new Error(`en 缺 ${missing.length} 键: ${missing.slice(0, 5).join(', ')}`);
});
check('en 有、zh 缺的键为零', () => {
  const missing = Object.keys(dicts.en).filter((k) => !(k in dicts.zh));
  if (missing.length) throw new Error(`zh 缺 ${missing.length} 键: ${missing.slice(0, 5).join(', ')}`);
});
check('没有空翻译', () => {
  const empty = Object.entries(dicts.zh).filter(([, v]) => !String(v).trim()).map(([k]) => k);
  if (empty.length) throw new Error(`空的 zh 翻译: ${empty.slice(0, 5).join(', ')}`);
});
check('en 里没有残留中文', () => {
  const cjk = Object.entries(dicts.en).filter(([, v]) => /[\u4e00-\u9fa5]/.test(String(v))).map(([k]) => k);
  if (cjk.length) throw new Error(`en 里混了中文: ${cjk.slice(0, 5).join(', ')}`);
});
check('占位符在两份词典里一一对应', () => {
  const holders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  const broken = [];
  for (const key of Object.keys(dicts.zh)) {
    const zh = holders(dicts.zh[key]);
    const en = holders(dicts.en[key] ?? '');
    if (zh !== en) broken.push(`${key}: zh[${zh}] vs en[${en}]`);
  }
  if (broken.length) throw new Error(broken.slice(0, 5).join(' | '));
});

console.log('\n[B] 正常渲染不泄漏原始 key');
for (const [label, build] of tabs) {
  check(`${label} 无原始 key 泄漏`, () => {
    const html = renderToStaticMarkup(build());
    const hits = leakOf(html);
    if (hits.length) throw new Error(`泄漏: ${hits.slice(0, 5).join(', ')}`);
    if (html.length < 200) throw new Error(`渲染过短: ${html.length} 字节`);
  });
}

console.log('\n[C] 异常数据不炸');
const emptySnapshot = {
  ok: true, plugin: { name: 'wechat-bridge', activatedAt: 0, uptimeMs: 0 },
  config: {}, autoReply: false, agentServices: false, presets: [], persona: { injected: false, chars: 0 },
  chats: [], counters: { inbound: 0, outbound: 0, replies: 0, errors: 0 },
  lastError: null, sessions: [], memory: {}, override: {}, events: [], deliveries: [], stub: {},
};
const brokenSnapshot = {
  ...emptySnapshot,
  lastError: { at: Date.now(), phase: 'handoff(wxid_x)', message: '网关返回 500，重试 3 次后放弃' },
  counters: { inbound: 3, outbound: 0, replies: 0, errors: 3 },
};
const weirdNames = {
  ...fixture,
  chats: [{ chatId: 'wxid_\u4e2d\u6587\u7fa4\u540d\u8d85\u957f', name: '一个特别特别长的群名字用来测试它到底会不会把布局撑破啊啊啊啊', unread: 128, lastAt: Date.now(), kind: 'group' }],
};

const states = [
  ['空快照', emptySnapshot],
  ['有 lastError', brokenSnapshot],
  ['超长群名 + 大未读数', weirdNames],
];
for (const [label, snapshot] of states) {
  for (const [tabLabel, make] of [
    ['概览', () => React.createElement(I.OverviewTab, { snapshot, wizard: { step: 'stub', busy: false, error: '', completed: false, done: {} }, onStubStart() {}, onPointAtStub() {}, onPing() {}, onWizardReset() {}, onStubStop() {} })],
    ['会话', () => React.createElement(I.ChatsTab, { snapshot, tick: 0, onRefresh() {} })],
    ['控制台', () => React.createElement(I.ConsoleTab, { snapshot, onRefresh() {} })],
    ['设置', () => React.createElement(I.SettingsTab, { snapshot, onSaved() {} })],
  ]) {
    check(`${label} · ${tabLabel} 能渲染且不泄漏 key`, () => {
      const html = renderToStaticMarkup(make());
      if (!html || html.length < 100) throw new Error(`渲染过短: ${html.length}`);
      if (/undefined|NaN|\[object Object\]/.test(html.replace(/<[^>]+>/g, ' '))) {
        throw new Error('渲染结果里出现了 undefined / NaN / [object Object]');
      }
      const hits = leakOf(html);
      if (hits.length) throw new Error(`泄漏: ${hits.slice(0, 5).join(', ')}`);
    });
  }
}

console.log(failures === 0 ? '\n全部通过 ✅\n' : `\n${failures} 项失败 ❌\n`);
process.exit(failures === 0 ? 0 : 1);
