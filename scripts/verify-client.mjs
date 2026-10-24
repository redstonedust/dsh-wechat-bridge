/**
 * client.js 渲染冒烟测试（不需要浏览器）：
 *   1. 伪造 window.__ModuleLoader__ + require('react')
 *   2. 用假 ctx 跑 apply()，拿到注册的槽位工厂
 *   3. 用 react-dom/server 真渲染每个标签页，确认没有抛错、有内容
 *   4. 断言关键文案、按钮、CSS 与词典条目都在
 *
 * 用法: node scripts/verify-client.mjs
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

/* ── 1. 最小 DOM 垫片 ── */
const styleNodes = [];
const document = {
  head: { appendChild(node) { styleNodes.push(node); } },
  getElementById() { return null; },
  createElement(tag) { return { tagName: tag, id: '', textContent: '', parentNode: null }; },
};
const listeners = [];
const globalObject = {
  setInterval() { return 1; },
  clearInterval() {},
  setTimeout() { return 1; },
  clearTimeout() {},
  addEventListener(name, fn) { listeners.push([name, fn]); },
  removeEventListener() {},
  confirm() { return false; },
  fetch() { return Promise.reject(new Error('offline')); },
};
Object.assign(globalThis, { document, AbortController: globalThis.AbortController });

/* ── 2. 加载 client.js ── */
let definition;
globalThis.window = {
  __ModuleLoader__: {
    load(value) { definition = value; },
  },
  addEventListener: globalObject.addEventListener,
  removeEventListener: globalObject.removeEventListener,
  setInterval: globalObject.setInterval,
  clearInterval: globalObject.clearInterval,
  setTimeout: globalObject.setTimeout,
  clearTimeout: globalObject.clearTimeout,
  fetch: globalObject.fetch,
  confirm: globalObject.confirm,
};
const source = readFileSync(path.join(root, 'client.js'), 'utf8');
new Function('window', 'document', 'globalThis', source)(
  globalThis.window,
  document,
  new Proxy(globalThis, {
    get(target, key) {
      if (key in globalObject) return globalObject[key];
      return target[key];
    },
  }),
);

const failures = [];
const check = (ok, label, detail) => {
  if (ok) console.log(`  ok   ${label}`);
  else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(label);
  }
};

console.log('client.js 模块定义');
check(definition !== undefined, '调用了 __ModuleLoader__.load');
check(definition?.id === 'dsh-wechat-bridge', 'id 正确', definition?.id);
check(typeof definition?.factory === 'function', 'factory 是函数');

const fakeRequire = (name) => {
  if (name === 'react') return React;
  throw new Error(`unexpected require: ${name}`);
};
const exported = definition.factory(fakeRequire);
console.log(`\n导出形状   inject=${JSON.stringify(exported.inject)}`);

/* ── 3. 假 ctx，收集槽位注册 ── */
const registrations = [];
const cleanups = [];
const dictionary = { zh: null, en: null };
const fakeCtx = {
  effect(fn, label) {
    const dispose = fn();
    cleanups.push([label, dispose]);
    return dispose;
  },
  locale: {
    register(namespace, entries) {
      dictionary.zh = entries.zh;
      dictionary.en = entries.en;
      return () => {};
    },
    bind() {
      return (key, params) => {
        const dict = dictionary.zh ?? {};
        let text = dict[key] ?? key;
        for (const [name, value] of Object.entries(params ?? {})) {
          text = text.split(`{${name}}`).join(String(value));
        }
        return text;
      };
    },
    subscribe() { return () => {}; },
  },
  slots: {
    inject(name, fn) {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    register(meta, component) {
      registrations.push({ meta, component });
      return () => {};
    },
  },
};

console.log('\napply()');
exported.apply(fakeCtx);
check(styleNodes.length === 1, '注入了一个 <style>', `实际 ${styleNodes.length}`);
check(/wx-page/.test(styleNodes[0]?.textContent ?? ''), 'CSS 含 .wx-page');
check(/prefers-reduced-motion/.test(styleNodes[0]?.textContent ?? ''), 'CSS 含 reduced-motion 兜底');
check(/--dsw-alias-/.test(styleNodes[0]?.textContent ?? ''), 'CSS 用主题 token');
check(!/#[0-9a-fA-F]{3,8}\b/.test(styleNodes[0]?.textContent ?? ''), 'CSS 里没有硬编码色值');

const sidebar = registrations.find((item) => item.meta.name === 'sidebar.panellist');
const main = registrations.find((item) => item.meta.name === 'main');
check(Boolean(sidebar), '注册了 sidebar.panellist');
check(sidebar?.meta.id === 'wechat', 'sidebar id = wechat', sidebar?.meta.id);
check(typeof sidebar?.meta.order === 'number', 'sidebar order 是数字', sidebar?.meta.order);
check(typeof sidebar?.meta.label === 'function', 'sidebar label 是 thunk（跟随语言）');
check(main?.meta.key === 'wechat', 'main key = wechat', main?.meta.key);
check(dictionary.zh && Object.keys(dictionary.zh).length > 150, '中文词典条目 > 150', Object.keys(dictionary.zh ?? {}).length);
check(dictionary.en && Object.keys(dictionary.en).length > 150, '英文词典条目 > 150', Object.keys(dictionary.en ?? {}).length);

const missingEn = Object.keys(dictionary.zh ?? {}).filter((key) => !(key in (dictionary.en ?? {})));
const missingZh = Object.keys(dictionary.en ?? {}).filter((key) => !(key in (dictionary.zh ?? {})));
check(missingEn.length === 0, '中英词典键完全对齐', `en 缺 ${missingEn.slice(0, 6).join(', ')}`);
check(missingZh.length === 0, '英中词典键完全对齐', `zh 缺 ${missingZh.slice(0, 6).join(', ')}`);

/* ── 4. 侧栏图标 ── */
if (sidebar) {
  const iconHtml = renderToStaticMarkup(React.createElement(sidebar.component, { size: 16, active: false }));
  check(/<svg/.test(iconHtml), '图标渲染成 svg');
  check(/data-dsh-panel-entry/.test(iconHtml), '图标带 data-dsh-panel-entry');
}

/* ── 5. 主面板：首屏（无快照）── */
if (!main) {
  console.log('\n主面板缺失，跳过渲染');
} else {
  const Panel = main.component;
  console.log('\n主面板首屏');
  let firstHtml = '';
  try {
    firstHtml = renderToStaticMarkup(React.createElement(Panel));
    check(true, '首屏渲染无异常');
  } catch (error) {
    check(false, '首屏渲染无异常', error.message);
  }
  check(/正在连上 Host|Connecting to the host/.test(firstHtml), '首屏显示加载文案');

  /* ── 6. 主面板：有快照后逐标签页 ── */
  const fixture = JSON.parse(readFileSync(path.join(root, 'scripts', 'fixtures', 'snapshot.json'), 'utf8'));

  /* 用 fetch 垫片喂快照：组件挂载后异步 setState，SSR 拿不到；
     所以直接渲染各标签页组件本身。它们通过 props 拿快照。 */

  const tabNames = ['OverviewTab', 'ChatsTab', 'ConsoleTab', 'SettingsTab', 'CheckTab'];
  for (const name of tabNames) {
    const Tab = exported.__internals?.[name];
    if (!Tab) {
      check(false, `${name} 可渲染`, '未导出到 __tabs');
      continue;
    }
    try {
      let html;
      if (name === 'CheckTab') {
        html = renderToStaticMarkup(React.createElement(Tab, { onRefresh() {} }));
      } else if (name === 'SettingsTab') {
        html = renderToStaticMarkup(React.createElement(Tab, { snapshot: fixture, onSaved() {} }));
      } else if (name === 'ChatsTab') {
        html = renderToStaticMarkup(React.createElement(Tab, { snapshot: fixture, tick: 0, onRefresh() {} }));
      } else if (name === 'ConsoleTab') {
        html = renderToStaticMarkup(React.createElement(Tab, { snapshot: fixture, onRefresh() {} }));
      } else {
        html = renderToStaticMarkup(React.createElement(Tab, {
          snapshot: fixture,
          wizard: { step: 'stub', busy: false, error: '', completed: false, done: { stub: false, point: false, ping: false } },
          onStubStart() {}, onPointAtStub() {}, onPing() {}, onWizardReset() {}, onStubStop() {},
        }));
      }
      check(html.length > 200, `${name} 渲染出内容`, `${html.length} 字节`);
    } catch (error) {
      check(false, `${name} 可渲染`, error.message);
    }
  }
}

/* ── 7. 清理器 ── */
console.log('\n清理');
let badCleanup = 0;
for (const [label, dispose] of cleanups) {
  try {
    if (typeof dispose === 'function') dispose();
    else if (typeof dispose !== 'undefined') badCleanup += 1;
  } catch (error) {
    console.log(`  warn ${label}: ${error.message}`);
  }
}
check(badCleanup === 0, '每个 effect 都返回了可调用清理器');

console.log(`\n${failures.length === 0 ? '全部通过' : `${failures.length} 项失败`}`);
process.exit(failures.length === 0 ? 0 : 1);
