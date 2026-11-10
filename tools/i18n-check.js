'use strict';
// Lists the user-visible English strings of the dashboard that have no translation yet.
//   node tools/i18n-check.js          summary per language
//   node tools/i18n-check.js fa       list the missing strings of one language (copy them into src/public/i18n/fa.json)
// The strings are found by the same extractor that produced the first key list (static text, attributes, text between tags and
// string literals in the scripts). Some hits are code or CSS fragments: ignore those.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = path.join(__dirname, '..', 'src', 'public');
const keys = new Set();
for (const f of ['index.html', 'app-ext.js', 'report.html']) {
  const out = path.join(os.tmpdir(), 'mtc-i18n-' + f + '.json');
  execFileSync(process.execPath, [path.join(__dirname, 'i18n-extract.js'), path.join(root, f), out], { stdio: 'ignore' });
  for (const o of JSON.parse(fs.readFileSync(out, 'utf8'))) if (!/[$]|=>|\(\)|\bconst\b|\bfunction\b|\.\w+\(|\|\||&&|^[<>\/#]|^[a-z]+[A-Z]\w*$|@font-face|@page/.test(o.k)) keys.add(o.k);
}
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const langs = ['fa', 'ar', 'ru', 'zh'], want = process.argv[2];
for (const l of langs) {
  if (want && want !== l) continue;
  const d = JSON.parse(fs.readFileSync(path.join(root, 'i18n', l + '.json'), 'utf8')), have = new Set(Object.keys(d).map(norm));
  const miss = [...keys].filter((k) => !have.has(norm(k)));
  if (want) { console.log(miss.join('\n')); console.log(`\n${miss.length} of ${keys.size} strings missing in ${l}`); } else console.log(`${l}: ${keys.size - miss.length} of ${keys.size} strings translated (${miss.length} missing)`);
}
