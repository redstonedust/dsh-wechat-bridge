() => {
  const problems = [];
  const facts = {};
  const page = document.querySelector('.wx-page');
  if (!page) { problems.push('no .wx-page'); return { problems, facts }; }
  facts.pageWidth = Math.round(page.getBoundingClientRect().width);
  facts.viewport = window.innerWidth;
  facts.scrollWidth = document.documentElement.scrollWidth;
  if (document.documentElement.scrollWidth > window.innerWidth + 2) {
    problems.push('horizontal overflow: ' + document.documentElement.scrollWidth + ' > ' + window.innerWidth);
  }
  let overflowCount = 0;
  document.querySelectorAll('.wx-page *').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0) return;
    if (r.right > window.innerWidth + 2) {
      overflowCount += 1;
      if (overflowCount <= 8) problems.push('overflows right: ' + (el.className || el.tagName) + ' right=' + Math.round(r.right));
    }
  });
  const clipped = [];
  document.querySelectorAll('.wx-page *').forEach((el) => {
    if (el.children.length > 0) return;
    if (!el.textContent.trim()) return;
    const st = getComputedStyle(el);
    if (st.overflow === 'hidden' && st.textOverflow !== 'ellipsis' && el.scrollWidth > el.clientWidth + 1) {
      clipped.push(el.className + ' :: ' + el.textContent.slice(0, 18));
    }
  });
  facts.clipped = clipped.slice(0, 8);
  if (clipped.length) problems.push(clipped.length + ' clipped text nodes');
  const tiny = [];
  document.querySelectorAll('.wx-page *').forEach((el) => {
    if (el.children.length > 0) return;
    if (!el.textContent.trim()) return;
    const size = parseFloat(getComputedStyle(el).fontSize);
    if (size < 10.5) tiny.push((el.className || el.tagName) + ':' + size);
  });
  facts.tinyText = tiny.slice(0, 8);
  const shortBtn = [];
  document.querySelectorAll('.wx-btn, .wx-tab').forEach((b) => {
    const h = b.getBoundingClientRect().height;
    if (h < 24) shortBtn.push(b.className + ':' + Math.round(h));
  });
  facts.shortButtons = shortBtn.slice(0, 8);
  const cards = [];
  document.querySelectorAll('.wx-card').forEach((c) => cards.push(Math.round(c.getBoundingClientRect().width)));
  facts.cardWidths = cards;
  const rgb = (s) => s.match(/\d+/g).slice(0, 3).map(Number);
  const lum = (c) => {
    const f = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const contrast = (a, b) => { const p = lum(a); const q = lum(b); const hi = Math.max(p, q); const lo = Math.min(p, q); return (hi + 0.05) / (lo + 0.05); };
  const bg = rgb(getComputedStyle(document.body).backgroundColor || 'rgb(255,255,255)');
  const probe = document.querySelector('.wx-sub') || document.body;
  const fg = rgb(getComputedStyle(probe).color);
  facts.contrastSecondary = Number(contrast(bg, fg).toFixed(2));
  if (facts.contrastSecondary < 4.5) problems.push('secondary contrast ' + facts.contrastSecondary);
  return { problems, facts };
}
