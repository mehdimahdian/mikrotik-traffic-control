'use strict';
// npm run lint : syntax-checks every JavaScript file and every inline script of the dashboard pages (there is no build step to catch typos).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const root = path.join(__dirname, '..');
let bad = 0;
function walk(d, out = []) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', 'data', 'data-demo'].includes(f.name)) continue;
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
for (const f of walk(root)) {
  if (f.endsWith('.js')) {
    try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); } catch (e) { bad++; console.error('FAIL', path.relative(root, f), String(e.stderr).split('\n').slice(0, 4).join('\n')); }
  } else if (f.endsWith('.html')) {
    const s = fs.readFileSync(f, 'utf8');
    for (const m of s.matchAll(/<script>([\s\S]*?)<\/script>/g)) { try { new Function(m[1]); } catch (e) { bad++; console.error('FAIL', path.relative(root, f), e.message); } }
  } else if (f.endsWith('.json')) {
    try { JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { bad++; console.error('FAIL', path.relative(root, f), e.message); }
  }
}
console.log(bad ? `${bad} problem(s)` : 'syntax OK');
process.exit(bad ? 1 : 0);
