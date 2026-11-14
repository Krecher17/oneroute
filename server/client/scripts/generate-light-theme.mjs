// Generates src/styles/theme-light.generated.css from src/legacy/legacy.css.
// For every rule that uses a hard-coded dark surface, a white text/overlay or a pale accent colour, it writes a
// `html[data-theme="light"] <selector>` copy with the colour mapped to its light-theme equivalent. Run: npm run theme
import fs from 'fs';
import path from 'path';
import postcss from 'postcss';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'src/legacy/legacy.css'), 'utf8');
const LIGHT = { page: '#f3f1ec', card: '#ffffff', raised: '#ece9e2', line: '#d9d6cd', line2: '#cfcbc1', text: '#1b1d21' };
const ACCENT_TEXT = { '--yellow': '#7a5800', '--green': '#1d7a4b', '--red': '#c23b36', '--orange': '#a85d00' };

// ---------- colour helpers ----------
function parseColor(token) {
  let m = /^#([0-9a-f]{3,8})$/i.exec(token);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
  }
  m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(token);
  if (m) { let a = 1; if (m[4] !== undefined) a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]); return { r: +m[1], g: +m[2], b: +m[3], a }; }
  if (/^white$/i.test(token)) return { r: 255, g: 255, b: 255, a: 1 };
  return null;
}
const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const sat = ({ r, g, b }) => Math.max(r, g, b) - Math.min(r, g, b);
function hsl({ r, g, b }) { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2; let h = 0, s = 0; if (mx !== mn) { const d = mx - mn; s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn); h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; } return { h, s, l }; }
const fromHsl = (h, s, l, a) => { const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2; const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]; return out({ r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255, a }); };
const hex = (n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
function out({ r, g, b, a }) { return a < 1 ? `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${+a.toFixed(3)})` : `#${hex(r)}${hex(g)}${hex(b)}`; }
const withAlpha = (hexColor, a) => { const c = parseColor(hexColor); return out({ ...c, a }); };

const TEXTISH = new Set(['color', 'fill', 'stroke', 'caret-color', '-webkit-text-fill-color']);
const SURFACE = (p) => p === 'background' || p === 'background-color' || p === 'background-image';
const LINEISH = (p) => /^(border|outline)/.test(p);

// Map one colour for one property. Returns a string, or null to leave it alone.
function mapColor(token, prop, ctx) {
  const c = parseColor(token);
  if (!c) return null;
  const L = lum(c), S = sat(c);
  if (TEXTISH.has(prop)) {
    if (S < 28 && L > 0.7) return ctx.accentBg ? null : withAlpha(LIGHT.text, c.a);       // white text -> dark text (not on coloured buttons)
    if (S < 28 && L > 0.45 && !ctx.accentBg) return withAlpha('#5d6470', c.a);              // pale grey text (hard to read on white) -> readable grey
    if (S >= 28 && L > 0.45 && !ctx.accentBg) { const h = hsl(c); return fromHsl(h.h, Math.min(h.s, 0.85), 0.27, c.a); } // pale accent text -> deep accent
    return null;
  }
  if (S < 28) {
    if (L > 0.7) { // white / near-white
      if (c.a < 1) return out({ r: 0, g: 0, b: 0, a: +(c.a * 0.8).toFixed(3) });          // translucent white overlay -> translucent black
      return LINEISH(prop) ? LIGHT.line : null;                                             // solid white surface stays white
    }
    if (L < 0.15) { // dark neutral surface / line -> light
      const base = LINEISH(prop) ? (L < 0.10 ? LIGHT.line : LIGHT.line2)
        : L < 0.012 ? LIGHT.page : L < 0.03 ? LIGHT.card : L < 0.06 ? LIGHT.raised : L < 0.10 ? LIGHT.line : LIGHT.line2;
      return c.a < 1 ? withAlpha(base, c.a) : base;
    }
    return null;
  }
  if (L < 0.12 && (SURFACE(prop) || LINEISH(prop))) { const h = hsl(c); return fromHsl(h.h, Math.min(h.s, 0.9), LINEISH(prop) ? 0.72 : 0.9, c.a); } // dark tinted panel -> pale tint
  return null;
}

const COLOR_TOKEN = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|\bwhite\b/g;
function mapValue(prop, value, ctx) {
  let changed = false;
  let next = value.replace(COLOR_TOKEN, (tok) => { const m = mapColor(tok, prop, ctx); if (m && m !== tok) { changed = true; return m; } return tok; });
  if (TEXTISH.has(prop)) {
    next = next.replace(/var\((--(?:yellow|green|red|orange))\)/g, (m, v) => { if (ctx.accentBg) return m; changed = true; return ACCENT_TEXT[v]; });
  }
  return changed ? next : null;
}

// ---------- walk the stylesheet ----------
const ast = postcss.parse(source);
const outRoot = postcss.root();
const wrappers = new Map();
const wrapperFor = (chain) => {
  let parent = outRoot;
  for (const at of chain) {
    let w = wrappers.get(at);
    if (!w) { w = postcss.atRule({ name: at.name, params: at.params }); parent.append(w); wrappers.set(at, w); }
    parent = w;
  }
  return parent;
};

let rules = 0, decls = 0;
ast.walkRules((rule) => {
  const chain = []; let p = rule.parent;
  while (p && p.type !== 'root') { chain.unshift(p); p = p.parent; }
  if (chain.some((a) => /keyframes|font-face/.test(a.name))) return;
  if (rule.selectors.every((s) => /^(:root|html)$/.test(s.trim()))) return;
  // Is this rule's own background a coloured (accent) fill? Then white text on it must stay white.
  // Gradient-filled text (background-clip: text): its "background" colours are really text colours.
  const clipText = rule.nodes.some((d) => d.type === 'decl' && /background-clip$/.test(d.prop) && /text/.test(d.value));
  const accentBg = !clipText && rule.nodes.some((d) => d.type === 'decl' && SURFACE(d.prop) && (/var\(--(?:yellow|red|green|orange)\)/.test(d.value) || (d.value.match(COLOR_TOKEN) || []).some((t) => { const c = parseColor(t); return c && sat(c) >= 60 && lum(c) >= 0.1 && lum(c) <= 0.9; })));
  const kept = [];
  rule.each((d) => {
    if (d.type !== 'decl' || /box-shadow|text-shadow|^--/.test(d.prop)) return;
    if (!(TEXTISH.has(d.prop) || SURFACE(d.prop) || LINEISH(d.prop))) return;
    const v = mapValue(clipText && SURFACE(d.prop) ? 'color' : d.prop, d.value, { accentBg });
    if (v) kept.push(postcss.decl({ prop: d.prop, value: v, important: d.important }));
  });
  if (!kept.length) return;
  // A `background` shorthand resets its longhands (size, position, clip...), so carry the rule's own longhands along.
  if (kept.some((k) => k.prop === 'background')) {
    rule.each((d) => { if (d.type === 'decl' && (/^background-(?!color$|image$)/.test(d.prop) || d.prop === '-webkit-background-clip') && !kept.some((k) => k.prop === d.prop)) kept.push(d.clone()); });
  }
  const selector = rule.selectors.map((s) => { s = s.trim(); return /^html\b/.test(s) ? s.replace(/^html/, 'html[data-theme="light"]') : `html[data-theme="light"] ${s}`; }).join(',\n');
  wrapperFor(chain).append(postcss.rule({ selector, nodes: kept }));
  rules++; decls += kept.length;
});

const header = `/* GENERATED by scripts/generate-light-theme.mjs from src/legacy/legacy.css. Do not edit by hand: change theme-light.css instead. */\n`;
fs.writeFileSync(path.join(root, 'src/styles/theme-light.generated.css'), header + outRoot.toString() + '\n');
console.log(`light theme: ${rules} rules, ${decls} declarations -> src/styles/theme-light.generated.css`);
