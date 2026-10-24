import { readFileSync, writeFileSync } from 'node:fs';
const s = readFileSync('client.js', 'utf8');
const marker = 'const CSS = ';
const start = s.indexOf(marker) + marker.length;
const quote = s[start];
let i = start + 1;
while (i < s.length) {
  const ch = s[i];
  if (ch === '\\') { i += 2; continue; }
  if (ch === quote) break;
  i += 1;
}
const css = s.slice(start + 1, i);
writeFileSync('scripts/fixtures/panel.css', css);
console.log('quote char code:', quote.charCodeAt(0));
console.log('css bytes:', css.length);
console.log('tail:', JSON.stringify(css.slice(-30)));
console.log('has warn:', css.includes('wx-node--warn'));
