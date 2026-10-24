import { readFileSync } from 'node:fs';
const css = readFileSync('scripts/fixtures/panel.css', 'utf8');
const checks = [
  ['transition: all', /transition:\s*all/g],
  ['scale(0) 起手', /(?:transform:\s*)?scale\(0\)/g],
];
let bad = 0;
for (const [name, rx] of checks) {
  const m = css.match(rx);
  if (m) { bad += m.length; console.log(' 违规 ' + name + ' × ' + m.length); }
}
if (!bad) console.log(' 无 transition:all / scale(0) 违规');

const durations = [...new Set([...css.matchAll(/(\d+)ms/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
const long = durations.filter((d) => d > 300);
console.log('duration 全部取值:', durations.join(', '));
console.log('>300ms 的时长:', long.length ? long.join(', ') : '无');
console.log('transition 条数:', (css.match(/transition:/g) || []).length);
console.log('animation 条数:', (css.match(/animation:/g) || []).length);
console.log('keyframes:', [...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]).join(', '));
const eases = [...new Set([...css.matchAll(/cubic-bezier\([^)]+\)/g)].map((m) => m[0]))];
console.log('easing:', eases.join('  ') || '(全部用内置关键字)');
console.log('hover 门控:', /hover:\s*hover/.test(css) ? '有' : '缺');
console.log('reduced-motion:', /prefers-reduced-motion/.test(css) ? '有' : '缺');
console.log('--dsw 变量引用:', [...new Set([...css.matchAll(/--dsw-[a-z-]+/g)].map((m) => m[0]))].length, '种');
console.log('硬编码颜色:', (css.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) || []).length, '处');
