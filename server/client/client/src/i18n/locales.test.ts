import { describe, expect, it } from 'vitest';
import en from './locales/en.json';
import hi from './locales/hi.json';
import ml from './locales/ml.json';
import ta from './locales/ta.json';
import kn from './locales/kn.json';
import te from './locales/te.json';
import legacyHi from './locales/legacy/hi.json';
import legacyMl from './locales/legacy/ml.json';
import markup from '../legacy/markup.html?raw';

type Tree = { [k: string]: string | Tree };
const flatten = (o: Tree, prefix = ''): Record<string, string> =>
  Object.entries(o).reduce<Record<string, string>>((acc, [k, v]) => {
    if (typeof v === 'string') acc[prefix + k] = v; else Object.assign(acc, flatten(v, `${prefix}${k}.`));
    return acc;
  }, {});
const vars = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort().join(',');
const tags = (s: string) => [...s.matchAll(/<\/?(\w+)>/g)].map((m) => m[1]).sort().join(',');

const base = flatten(en as Tree);
const others: Record<string, Tree> = { hi, ml, ta, kn, te };

describe('UI translations', () => {
  for (const [code, tree] of Object.entries(others)) {
    const flat = flatten(tree);
    it(`${code} has exactly the same keys as English`, () => {
      expect(Object.keys(flat).sort()).toEqual(Object.keys(base).sort());
    });
    it(`${code} keeps every {{variable}} and <tag> from English`, () => {
      for (const key of Object.keys(base)) {
        expect(vars(flat[key]), `${code}:${key}`).toBe(vars(base[key]));
        expect(tags(flat[key]), `${code}:${key}`).toBe(tags(base[key]));
        expect(flat[key].trim(), `${code}:${key} is empty`).not.toBe('');
      }
    });
  }
});

describe('legacy screen dictionaries', () => {
  // every phrase that is visible in the legacy markup must have a Hindi and a Malayalam translation
  const body = markup.replace(/<svg[\s\S]*?<\/svg>|<script[\s\S]*?<\/script>/g, '');
  const clean = (t: string) => t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
  const phrases = new Set<string>();
  for (const m of body.matchAll(/>([^<>]+)</g)) phrases.add(clean(m[1]));
  for (const m of body.matchAll(/\b(?:placeholder|aria-label|title|alt)="([^"]+)"/g)) phrases.add(clean(m[1]));
  const visible = [...phrases].filter((p) => p.length > 1 && /[A-Za-z]{2}/.test(p) && !/^[\W\d_]+$/.test(p));

  it('finds the phrases (guards against the extraction going quiet)', () => { expect(visible.length).toBeGreaterThan(150); });
  for (const [code, dict] of [['hi', legacyHi], ['ml', legacyMl]] as const) {
    it(`${code} covers every phrase in the legacy markup`, () => {
      const missing = visible.filter((p) => !(p in dict));
      expect(missing).toEqual([]);
    });
  }
});
