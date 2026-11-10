'use strict';
// Builds src/public/i18n/<lang>.json from the numbered translation sources in i18n-src/:
//   i18n-src/keys.txt            one line per key:   N|English text            (the master list; extend it at the END only)
//   i18n-src/<lang>-<part>.txt   one line per entry: N|translation              (any number of parts per language)
//   i18n-src/extra.txt           N|English pattern with {0} {1} placeholders    (composed sentences, N from 1001)
// Missing numbers simply stay English. After the first build the generated JSON files are the thing to edit by hand
// (they are plain { "English text": "translation" } objects), so this tool is only needed to re-import the numbered sources.
//   node tools/build-i18n.js            build all languages and print coverage
//   node tools/build-i18n.js --sample   also print 6 random pairs per language to eyeball the alignment
const fs = require('fs');
const path = require('path');
const SRC = path.join(__dirname, '..', 'i18n-src'), OUT = path.join(__dirname, '..', 'src', 'public', 'i18n');
const LANGS = ['fa', 'ar', 'ru', 'zh'];
const parse = (f) => fs.readFileSync(f, 'utf8').replace(/\r/g, '').split('\n').filter(Boolean).map((l) => { const i = l.indexOf('|'); return [Number(l.slice(0, i)), l.slice(i + 1)]; });
const keys = new Map(parse(path.join(SRC, 'keys.txt')));
if (fs.existsSync(path.join(SRC, 'extra.txt'))) for (const [n, k] of parse(path.join(SRC, 'extra.txt'))) keys.set(n, k);
fs.mkdirSync(OUT, { recursive: true });
for (const lang of LANGS) {
  const out = {}; let n = 0;
  for (const f of fs.readdirSync(SRC).filter((x) => x.startsWith(lang + '-') && x.endsWith('.txt')).sort()) {
    for (const [num, tr] of parse(path.join(SRC, f))) { const k = keys.get(num); if (k === undefined) { console.warn(`${f}: unknown number ${num}`); continue; } out[k] = tr; n++; }
  }
  fs.writeFileSync(path.join(OUT, lang + '.json'), JSON.stringify(out, null, 1));
  const pct = Math.round((n / keys.size) * 100);
  console.log(`${lang}: ${n} of ${keys.size} entries (${pct}%)`);
  if (process.argv.includes('--sample')) { const ks = Object.keys(out); for (let i = 0; i < 6; i++) { const k = ks[Math.floor(Math.random() * ks.length)]; console.log('   ', JSON.stringify(k), '->', out[k]); } }
}
