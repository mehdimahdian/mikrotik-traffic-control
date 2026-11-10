// (used by i18n-check.js) Extract candidate user-visible strings from the dashboard (static HTML text, attributes, text between tags in JS templates, JS string literals).
const fs = require('fs');
const file = process.argv[2];
const src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const set = new Map();
const add = (s, where) => {
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&middot;/g, '·').replace(/&hellip;/g, '…').replace(/&[a-z#0-9]+;/gi, '').replace(/\s+/g, ' ').trim();
  if (s.length < 2 || !/[A-Za-z]{2,}/.test(s)) return;
  if (/^[#.\[\]a-z0-9_\-:>\s,*=()\/'"]+$/.test(s) && !/\s[A-Za-z]/.test(s) && s === s.toLowerCase()) return;   // ids / selectors
  if (/^(https?:|\/api|[a-z]+\.[a-z]{2,4}$)/.test(s)) return;
  if (!set.has(s)) set.set(s, where);
};
// 1) HTML text nodes and attributes (everything outside <script>/<style>)
const html = src.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<script[\s\S]*?<\/script>/g, '');
for (const m of html.matchAll(/>([^<>]+)</g)) add(m[1], 'html');
for (const m of html.matchAll(/\b(?:placeholder|title|alt|aria-label)="([^"]+)"/g)) add(m[1], 'attr');
// 2) in script: text between tags inside templates / strings, and plain literals
const scripts = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
for (const m of scripts.matchAll(/>([^<>`'"$\\]{2,})</g)) add(m[1], 'js-tag');
for (const m of scripts.matchAll(/(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g)) {
  const body = m[2];
  const parts = body.split(/\$\{[^}]*\}/);
  for (const p of parts) { const t = p.replace(/<[^>]*>/g, ' '); if (/[A-Za-z]{3,}.*\s|[A-Z][a-z]{2,}/.test(t)) add(t, 'js'); }
}
const out = [...set.entries()].map(([k, w]) => ({ k, w }));
fs.writeFileSync(process.argv[3], JSON.stringify(out, null, 1));
const len = (a, b) => out.filter((o) => o.k.length >= a && o.k.length < b).length;
console.log('total', out.length, '| <30:', len(0, 30), '30-80:', len(30, 80), '80-200:', len(80, 200), '200+:', len(200, 1e9));
