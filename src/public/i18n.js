'use strict';
// Mikrotik Traffic Control - internationalisation (en, fa, ar, ru, zh).
//   * English text is the key. Dictionaries live in i18n/<lang>.json: { "English text": "translation", ... }.
//   * Keys may contain {name} placeholders: "Top: {0} {1}" matches "Top: SEC-PC 21 Mbps" and is translated with the captured values.
//   * Static and dynamically rendered text (text nodes, placeholder / title / alt / aria-label) is translated in the DOM and kept in
//     step by a MutationObserver, so the dashboard code can keep writing plain English.
//   * Code that builds a sentence uses  __('English with {n} values', { n: 3 })  - missing keys fall back to English.
//   * RTL languages (fa, ar) switch <html dir>; see the dir=rtl rules in index.html.
// Add a language: copy i18n/en.json (keys only) to i18n/xx.json, translate the values, add xx to LANGS below and to src/manager.js.
(function () {
  const LANGS = {
    en: { name: 'English', rtl: false, weekStart: 1, locale: 'en' },
    fa: { name: 'فارسی', rtl: true, weekStart: 6, locale: 'fa-u-nu-latn' },
    ar: { name: 'العربية', rtl: true, weekStart: 6, locale: 'ar-u-nu-latn' },
    ru: { name: 'Русский', rtl: false, weekStart: 1, locale: 'ru' },
    zh: { name: '中文', rtl: false, weekStart: 1, locale: 'zh-CN' },
  };
  const ATTRS = ['placeholder', 'title', 'alt', 'aria-label'];
  const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE', 'IFRAME', 'CANVAS']);
  const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

  const I18N = { lang: 'en', rtl: false, weekStart: 1, locale: 'en', langs: LANGS, dict: {}, tpl: {}, pats: [], observer: null };
  window.I18N = I18N;

  function build(dict) {
    I18N.dict = Object.create(null); I18N.tpl = Object.create(null); I18N.pats = [];
    for (const [k, v] of Object.entries(dict)) {
      if (typeof v !== 'string' || !v) continue;
      const key = norm(k);
      if (/\{\w+\}/.test(key)) {
        const names = [], re = '^' + key.split(/(\{\w+\})/).map((p) => { const m = /^\{(\w+)\}$/.exec(p); if (m) { names.push(m[1]); return '(.+?)'; } return p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('') + '$';
        I18N.pats.push({ re: new RegExp(re), names, out: v, len: key.length }); I18N.tpl[key] = v;
      } else I18N.dict[key] = v;
    }
    I18N.pats.sort((a, b) => b.len - a.len);
  }
  const fill = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : s);
  /** translate a plain key (no DOM); null when there is no translation */
  function lookup(key) {
    if (I18N.lang === 'en') return null;
    const d = I18N.dict[key]; if (d !== undefined) return d;
    for (const p of I18N.pats) { const m = p.re.exec(key); if (m) { const vars = {}; p.names.forEach((n, i) => { vars[n] = m[i + 1]; }); return fill(p.out, vars); } }
    return null;
  }
  /** translate in code:  __('Saved {n} files', { n: 3 })  */
  window.__ = (s, vars) => { const key = norm(s), d = I18N.lang === 'en' ? undefined : (I18N.dict[key] !== undefined ? I18N.dict[key] : I18N.tpl[key]); return fill(d !== undefined ? d : s, vars); };
  I18N.t = window.__;
  I18N.dayName = (d, style) => new Intl.DateTimeFormat(I18N.locale, { weekday: style || 'long' }).format(new Date(2024, 0, 7 + d));   // 0 = Sunday

  // ---- DOM translation (originals remembered so the language can be switched back and forth)
  const textOrig = new WeakMap();   // Text node -> { en, out }
  function doText(n) {
    const raw = n.data, o = textOrig.get(n);
    const src = o && o.out === raw ? o.en : raw;                  // unchanged since we wrote it -> its English source; otherwise the app wrote new text
    const key = norm(src); if (!key) { textOrig.delete(n); return; }
    const tr = lookup(key);
    if (tr === null) { if (src !== raw) n.data = src; textOrig.delete(n); return; }
    const lead = /^\s*/.exec(src)[0], trail = /\s*$/.exec(src)[0], out = lead + tr + trail;
    if (n.data !== out) n.data = out;
    textOrig.set(n, { en: src, out });
  }
  function doAttrs(el) {
    for (const a of ATTRS) {
      if (!el.hasAttribute || !el.hasAttribute(a)) continue;
      const k = 'i18n' + a.replace('-', ''), cur = el.getAttribute(a), saved = el.dataset ? el.dataset[k] : undefined;
      const src = saved !== undefined && el.dataset[k + 'out'] === cur ? saved : cur, tr = lookup(norm(src));
      if (tr === null) { if (src !== cur) el.setAttribute(a, src); if (el.dataset) { delete el.dataset[k]; delete el.dataset[k + 'out']; } continue; }
      if (el.dataset) { el.dataset[k] = src; el.dataset[k + 'out'] = tr; }
      if (cur !== tr) el.setAttribute(a, tr);
    }
  }
  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) { doText(root); return; }
    if (root.nodeType !== 1 || SKIP.has(root.tagName) || root.hasAttribute('data-noi18n')) return;
    doAttrs(root);
    for (let c = root.firstChild; c; c = c.nextSibling) walk(c);
  }
  function startObserver() {
    if (!document.body) return;
    if (I18N.observer) { I18N.observer.observe(document.body, OPTS); return; }   // reconnect after a language switch
    I18N.observer = new MutationObserver((muts) => {
      I18N.observer.disconnect();
      try {
        for (const m of muts) {
          if (m.type === 'childList') m.addedNodes.forEach((n) => walk(n));
          else if (m.type === 'characterData') doText(m.target);
          else if (m.type === 'attributes') doAttrs(m.target);
        }
      } finally { I18N.observer.observe(document.body, OPTS); }
    });
    I18N.observer.observe(document.body, OPTS);
  }
  const OPTS = { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS };

  async function loadDict(lang) {
    if (lang === 'en') return {};
    try { const r = await fetch('i18n/' + lang + '.json', { cache: 'no-store' }); if (r.ok) return await r.json(); } catch { /* English fallback */ }
    return {};
  }
  /** switch language: loads the dictionary, sets lang/dir, re-translates the whole page */
  I18N.set = async function (lang) {
    if (!LANGS[lang]) lang = 'en';
    const dict = await loadDict(lang);
    I18N.lang = lang; I18N.rtl = LANGS[lang].rtl; I18N.weekStart = LANGS[lang].weekStart; I18N.locale = LANGS[lang].locale;
    build(dict);
    document.documentElement.lang = lang; document.documentElement.dir = I18N.rtl ? 'rtl' : 'ltr';
    try { localStorage.setItem('mtc.lang', lang); } catch { /* ignore */ }
    if (I18N.observer) I18N.observer.disconnect();
    walk(document.body); walk(document.head && document.head.querySelector('title'));
    document.title = lookup(norm('Mikrotik Traffic Control')) || 'Mikrotik Traffic Control';
    startObserver();
    document.dispatchEvent(new CustomEvent('i18n', { detail: lang }));
  };
  I18N.guess = function () {
    try { const s = localStorage.getItem('mtc.lang'); if (s && LANGS[s]) return s; } catch { /* ignore */ }
    const n = (navigator.language || 'en').slice(0, 2).toLowerCase(); return LANGS[n] ? n : 'en';
  };
  // set direction early (before first paint) to avoid a flash of mirrored layout
  try { const g = I18N.guess(); document.documentElement.lang = g; document.documentElement.dir = LANGS[g].rtl ? 'rtl' : 'ltr'; } catch { /* ignore */ }
})();
