'use strict';
// Translation sanity checks - they run on every pull request so a translation can never break the dashboard.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'src', 'public', 'i18n');
const langs = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
const ph = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join(',');

test('the five shipped languages exist', () => { for (const l of ['fa', 'ar', 'ru', 'zh']) assert.ok(langs.includes(l), l + '.json is missing'); });

for (const l of langs) {
  test(`${l}: valid JSON, string values, placeholders kept`, () => {
    const d = JSON.parse(fs.readFileSync(path.join(dir, l + '.json'), 'utf8'));
    assert.ok(Object.keys(d).length > 300, 'suspiciously small dictionary');
    for (const [k, v] of Object.entries(d)) {
      assert.equal(typeof v, 'string', `value of "${k.slice(0, 40)}" must be a string`);
      assert.equal(ph(v), ph(k), `placeholders differ for "${k.slice(0, 50)}"`);
      assert.ok(!/<script/i.test(v), 'no script tags in translations');
    }
  });
  test(`${l}: registered in i18n.js and manager.js`, () => {
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'i18n.js'), 'utf8'), new RegExp(`\\b${l}:\\s*\\{`));
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'manager.js'), 'utf8'), new RegExp(`'${l}'`));
  });
}

test('portal pages exist in every language', () => {
  const hs = require('../src/hotspot');
  for (const l of hs.PAGE_LANGS) { const p = hs.pages(hs.normalize({ pageLang: l }), 2026); assert.ok(p['login.html'].includes('Wi-Fi'), l); }
});
