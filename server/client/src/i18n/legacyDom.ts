import i18n from './index';

/**
 * Translates the screens that still run on the legacy engine, without touching the engine's code.
 *
 * Every piece of visible text (and placeholder / aria-label / title) that exactly matches an English phrase in the
 * dictionary for the current language is swapped, including text the engine adds later (banners, notices).
 * The original English is remembered per node, so switching language (or back to English) always starts from it.
 *
 * Phrases not in a dictionary stay English. As screens move to React they use real translation keys instead
 * and their phrases leave these dictionaries. See MIGRATION.md.
 */
type Dict = Record<string, string>;

const loaders: Record<string, () => Promise<{ default: Dict }>> = {
  hi: () => import('./locales/legacy/hi.json'),
  ml: () => import('./locales/legacy/ml.json'),
  ta: () => import('./locales/legacy/ta.json'),
  kn: () => import('./locales/legacy/kn.json'),
  te: () => import('./locales/legacy/te.json'),
};
const cache = new Map<string, Dict>();

const ATTRS = ['placeholder', 'aria-label', 'title', 'alt'] as const;
// Never translate: code, the map's own canvas and controls (zoom buttons, attribution text), or anything marked data-no-i18n.
// Our buttons placed on top of a map (like the satellite switch) are ours, so they are translated.
const SKIP = 'script, style, [data-no-i18n], .maplibregl-canvas-container, .maplibregl-control-container';
// Text typed into a textarea is the person's own words. (An input's placeholder is ours, so inputs are fine.)
const SKIP_TEXT = 'textarea';

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

const textOriginal = new WeakMap<Node, string>();
const textShown = new WeakMap<Node, string>();
const attrOriginal = new WeakMap<Element, Map<string, string>>();
const attrShown = new WeakMap<Element, Map<string, string>>();

function swap(original: string, dict: Dict | null): string {
  if (!dict) return original;
  const key = norm(original);
  const tr = dict[key];
  if (!tr) return original;
  const lead = original.match(/^\s*/)![0];
  const trail = original.match(/\s*$/)![0];
  return lead + tr + trail;
}

function translateText(node: Text, dict: Dict | null): void {
  const current = node.nodeValue ?? '';
  // If the value is what we wrote last time, the real original is the one we saved; otherwise the engine changed it.
  const original = textShown.get(node) === current ? (textOriginal.get(node) ?? current) : current;
  textOriginal.set(node, original);
  const target = swap(original, dict);
  if (target !== current) node.nodeValue = target;
  textShown.set(node, target);
}

function translateAttrs(el: Element, dict: Dict | null): void {
  for (const name of ATTRS) {
    const current = el.getAttribute(name);
    if (current === null) continue;
    const originals = attrOriginal.get(el) ?? new Map<string, string>();
    const shown = attrShown.get(el) ?? new Map<string, string>();
    const original = shown.get(name) === current ? (originals.get(name) ?? current) : current;
    originals.set(name, original);
    const target = swap(original, dict);
    if (target !== current) el.setAttribute(name, target);
    shown.set(name, target);
    attrOriginal.set(el, originals);
    attrShown.set(el, shown);
  }
}

function walk(root: Node, dict: Dict | null): void {
  if (root.nodeType === Node.TEXT_NODE) {
    if (!(root.parentElement?.closest(`${SKIP}, ${SKIP_TEXT}`))) translateText(root as Text, dict);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  const el = root as Element;
  if (el.closest(SKIP)) return;
  translateAttrs(el, dict);
  const tree = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let n = tree.nextNode(); n; n = tree.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) {
      if (!(n.parentElement?.closest(`${SKIP}, ${SKIP_TEXT}`))) translateText(n as Text, dict);
    } else if (!(n as Element).closest(SKIP)) translateAttrs(n as Element, dict);
  }
}

async function dictionaryFor(language: string): Promise<Dict | null> {
  const base = language.split('-')[0];
  if (!loaders[base]) return null; // English, or a language with no dictionary yet
  const hit = cache.get(base);
  if (hit) return hit;
  const loaded = (await loaders[base]()).default;
  cache.set(base, loaded);
  return loaded;
}

/** Starts translating everything inside `root` and keeps doing so as the engine changes it. Returns a stop function. */
export function startLegacyTranslation(root: HTMLElement): () => void {
  let dict: Dict | null = null;
  const pending = new Set<Node>();
  let scheduled = 0;

  const flush = () => {
    scheduled = 0;
    const nodes = [...pending];
    pending.clear();
    observer.disconnect(); // our own edits must not wake us up again
    for (const n of nodes) if (root.contains(n)) walk(n, dict);
    observe();
  };
  const queue = (n: Node) => {
    pending.add(n);
    if (!scheduled) scheduled = window.requestAnimationFrame(flush);
  };

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'childList') m.addedNodes.forEach(queue);
      else if (m.type === 'characterData') queue(m.target);
      else if (m.type === 'attributes') queue(m.target);
    }
  });
  const observe = () => observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: [...ATTRS] });

  let token = 0;
  const apply = async (language: string) => {
    const mine = ++token;
    const next = await dictionaryFor(language);
    if (mine !== token) return; // a newer language change won
    dict = next;
    observer.disconnect();
    walk(root, dict);
    observe();
  };

  observe();
  void apply(i18n.language || 'en');
  const onChange = (lng: string) => { void apply(lng); };
  i18n.on('languageChanged', onChange);

  return () => {
    observer.disconnect();
    i18n.off('languageChanged', onChange);
    if (scheduled) window.cancelAnimationFrame(scheduled);
  };
}
