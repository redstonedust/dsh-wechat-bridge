/**
 * 面板视觉预览：把 SSR 输出 + 插件 CSS + DSH 主题变量拼成一个静态页面，
 * 用浏览器截图检查配色/间距/层级是否符合预期。
 *
 * 这不是 mock 后端，只是把真实的 React 渲染结果放进真实的主题变量里看。
 *
 * 用法: node scripts/preview-client.mjs [outDir]
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const outDir = path.resolve(root, process.argv[2] ?? 'scripts/fixtures/preview');
mkdirSync(outDir, { recursive: true });

const profileRequire = createRequire(path.join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'desktop', 'index.cjs'));
const React = profileRequire('react');
const { renderToStaticMarkup } = profileRequire('react-dom/server');

/* ── 装载 client.js ── */
let definition;
const styleNodes = [];
const documentStub = {
  head: { appendChild(node) { styleNodes.push(node); } },
  getElementById() { return null; },
  createElement(tag) { return { tagName: tag, id: '', textContent: '' }; },
};
globalThis.window = { __ModuleLoader__: { load(v) { definition = v; } } };
const source = readFileSync(path.join(root, 'client.js'), 'utf8');
new Function('window', 'document', source)(globalThis.window, documentStub);

const mod = definition.factory((name) => (name === 'react' ? React : (() => { throw new Error(name); })()));
const dictZh = mod.__internals.dictionaries.zh;
const t = (key, params) => {
  let text = dictZh[key] ?? key;
  for (const [name, value] of Object.entries(params ?? {})) text = text.split(`{${name}}`).join(String(value));
  return text;
};
const fakeCtx = {
  effect(fn) { return fn(); },
  locale: { register() { return () => {}; }, bind() { return t; }, subscribe() { return () => {}; } },
  slots: { inject(name, fn) { return fn(); }, register() { return () => {}; } },
};
mod.apply(fakeCtx);
const CSS = styleNodes[0]?.textContent ?? '';

/* ── 快照样本 ── */
const fixture = JSON.parse(readFileSync(path.join(root, 'scripts', 'fixtures', 'snapshot.json'), 'utf8'));
const I = mod.__internals;

/* 造一个"什么都配好了"的版本，用来看绿灯态 */
const healthy = JSON.parse(JSON.stringify(fixture));
healthy.counters = { inbound: 42, outbound: 38, replies: 35, errors: 0 };
healthy.lastError = null;
healthy.deliveries = [
  { at: Date.now() - 40_000, phase: 'stub', ok: true, chatId: 'wxid_demo', text: '在的，刚看完你说的那个问题' },
  { at: Date.now() - 240_000, phase: 'manual', ok: true, chatId: 'wxid_demo', text: '这是一条来自 DSH 微信桥接的测试消息 👋' },
];

const wizardIdle = { step: 'stub', busy: false, error: '', completed: false, done: { stub: false, point: false, ping: false } };
const wizardDone = { step: 'ping', busy: false, error: '', completed: true, done: { stub: true, point: true, ping: true } };

const views = {
  overview: () => React.createElement(I.OverviewTab, {
    snapshot: healthy, wizard: wizardDone,
    onStubStart() {}, onPointAtStub() {}, onPing() {}, onWizardReset() {}, onStubStop() {},
  }),
  'overview-first': () => React.createElement(I.OverviewTab, {
    snapshot: fixture, wizard: wizardIdle,
    onStubStart() {}, onPointAtStub() {}, onPing() {}, onWizardReset() {}, onStubStop() {},
  }),
  chats: () => React.createElement(I.ChatsTab, { snapshot: healthy, tick: 0, onRefresh() {} }),
  console: () => React.createElement(I.ConsoleTab, { snapshot: healthy, onRefresh() {} }),
  settings: () => React.createElement(I.SettingsTab, { snapshot: healthy, onSaved() {} }),
  check: () => React.createElement(I.CheckTab, { onRefresh() {} }),
  shell: () => React.createElement(I.WeChatPanel),
};

/* 面板外壳（头部 + 标签条）单独拼一份，因为 WeChatPanel 依赖 fetch */
function shellMarkup(activeTab, bodyHtml) {
  const tabs = I.tabs.map((tab) => {
    const on = tab.id === activeTab;
    return `<button type="button" class="wx-tab${on ? ' wx-tab--on' : ''}" data-wx-tab="${tab.id}">${t(tab.label)}</button>`;
  }).join('');
  return `<div class="wx-page">
    <header class="wx-head">
      <div class="wx-head-mark">${renderToStaticMarkup(React.createElement(I.WeChatIcon, { size: 20, active: true }))}</div>
      <div class="wx-head-text"><h1>${t('panel.title')}</h1><p>${t('panel.subtitle')}</p></div>
      <div class="wx-head-side">
        <span class="wx-pill wx-pill--on"><i></i>${t('panel.badge.on')}</span>
        <button type="button" class="wx-btn wx-btn--sm wx-btn--quiet">${t('panel.refresh')}</button>
      </div>
    </header>
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <div class="wx-tabs" role="tablist">${tabs}</div>
      <span style="flex:1"></span>
      <span class="wx-muted" style="font-size:11px">${t('panel.updated', { time: '03:12' })}</span>
    </div>
    ${bodyHtml}
  </div>`;
}

/* ── 主题变量：抄一份 DSH 的浅色/深色 token ── */
const LIGHT = `
  --dsw-alias-bg-base: #ffffff;
  --dsw-alias-bg-layer-1: #f7f8fa;
  --dsw-alias-bg-layer-2: #eef0f4;
  --dsw-alias-bg-overlay: #ffffff;
  --dsw-alias-border-l1: #e6e8ed;
  --dsw-alias-border-l2: #d5d9e0;
  --dsw-alias-brand-primary: #4d6bfe;
  --dsw-alias-label-primary: #101114;
  --dsw-alias-label-secondary: #71757e;
  --dsw-alias-state-error-primary: #e5484d;
  --dsw-alias-state-idle-primary: #b6bac2;
  --dsw-alias-state-success-primary: #30a46c;
  --dsw-alias-state-warn-primary: #f5a623;
  --dsw-font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  --dsw-specific-sidebar-fill: #f7f8fa;
`;
const DARK = `
  --dsw-alias-bg-base: #17181b;
  --dsw-alias-bg-layer-1: #1e1f23;
  --dsw-alias-bg-layer-2: #26282d;
  --dsw-alias-bg-overlay: #232529;
  --dsw-alias-border-l1: #2c2e34;
  --dsw-alias-border-l2: #3a3d44;
  --dsw-alias-brand-primary: #6b84ff;
  --dsw-alias-label-primary: #f2f3f5;
  --dsw-alias-label-secondary: #9a9ea8;
  --dsw-alias-state-error-primary: #ff6369;
  --dsw-alias-state-idle-primary: #4d5158;
  --dsw-alias-state-success-primary: #4cc38a;
  --dsw-alias-state-warn-primary: #ffb224;
  --dsw-font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  --dsw-specific-sidebar-fill: #1b1c20;
`;

const page = (title, bodyInner, dark) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { ${dark ? DARK : LIGHT} background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-family: var(--dsw-font-family); -webkit-font-smoothing: antialiased; }
  .stage { padding: 0; }
${CSS}
</style></head>
<body><div class="stage">${bodyInner}</div></body></html>`;

/* ── 输出 ── */
for (const [name, build] of Object.entries(views)) {
  if (name === 'shell') continue;
  const bodyHtml = renderToStaticMarkup(React.createElement(I.WeChatPanel === null ? 'div' : React.Fragment, null, build()));
  const activeTab = name === 'overview-first' ? 'overview' : name;
  const full = shellMarkup(activeTab, bodyHtml);
  writeFileSync(path.join(outDir, `${name}-light.html`), page(name, full, false), 'utf8');
  writeFileSync(path.join(outDir, `${name}-dark.html`), page(name, full, true), 'utf8');
}

/* 首屏（无快照）：直接渲染 WeChatPanel，看加载态 */
const loadingHtml = renderToStaticMarkup(React.createElement(I.WeChatPanel));
writeFileSync(path.join(outDir, 'loading-light.html'), page('loading', loadingHtml, false), 'utf8');
writeFileSync(path.join(outDir, 'loading-dark.html'), page('loading', loadingHtml, true), 'utf8');

/* 侧栏图标单独一页 */
const iconHtml = [12, 16, 20].map((size) => `<div style="padding:16px;color:var(--dsw-alias-label-primary)">${renderToStaticMarkup(React.createElement(I.WeChatIcon, { size, active: false }))}</div>`).join('');
writeFileSync(path.join(outDir, 'icon.html'), page('icon', `<div style="display:flex;gap:8px">${iconHtml}</div>`, false), 'utf8');

console.log(`预览已生成: ${outDir}`);
for (const file of readFileSync(path.join(outDir, '..', 'snapshot.json')) ? [] : []) void file;
