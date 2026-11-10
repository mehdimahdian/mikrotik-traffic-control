'use strict';
// Point every link, badge and package field at your GitHub repository.
//   node tools/set-repo.js <owner>/<repo>          e.g.  node tools/set-repo.js acme/mikrotik-traffic-control
// The current repository is read from package.json (repository.url), so it can be run again after a move or a fork.
const fs = require('fs');
const path = require('path');
const to = process.argv[2];
if (!/^[\w.-]+\/[\w.-]+$/.test(to || '')) { console.error('usage: node tools/set-repo.js <owner>/<repo>'); process.exit(1); }
const root = path.join(__dirname, '..');
const from = (/github\.com\/([\w.-]+\/[\w.-]+?)(\.git)?$/.exec(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).repository.url) || [])[1];
if (!from) { console.error('package.json has no GitHub repository url'); process.exit(1); }
let n = 0;
(function walk(d) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', 'data', 'data-demo'].includes(f.name)) continue;
    const p = path.join(d, f.name);
    if (f.isDirectory()) { walk(p); continue; }
    if (!/\.(md|yml|yaml|json|js|ps1|iss)$/.test(f.name) || p === __filename) continue;
    const s = fs.readFileSync(p, 'utf8');
    if (s.includes(from)) { fs.writeFileSync(p, s.split(from).join(to)); n++; }
  }
})(root);
console.log(`${n} file(s) now point to https://github.com/${to}`);
