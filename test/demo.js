'use strict';
// npm run demo : starts a fake MikroTik router (no hardware needed) and the dashboard with it already connected, so you can click through everything.
const { fork } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { createMock } = require('./mock-router');

(async () => {
  const mock = createMock({ clients: 18 }), mport = await mock.listen(0);
  const data = path.join(__dirname, '..', 'data-demo'); fs.mkdirSync(data, { recursive: true });
  const port = Number(process.env.MTC_PORT || 8787), base = `http://127.0.0.1:${port}`;
  const mgr = fork(path.join(__dirname, '..', 'src', 'manager.js'), [], { env: Object.assign({}, process.env, { MTC_PORT: String(port), MTC_DATA: data }) });
  for (let i = 0; i < 40; i++) { try { await fetch(base + '/api/settings'); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
  const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
  const have = await (await fetch(base + '/api/routers')).json();
  if (!have.length) {
    const r = await post('/api/routers', { name: 'Demo router', host: '127.0.0.1', port: mport, user: 'demo', password: 'demo' });
    if (r.ok) await post(`/api/r/${r.id}/api/config`, { staffNetworks: ['ether2'], guestNetworks: ['wlan-guest'], sec: { adminIps: ['127.0.0.1'] } });
    await post('/api/settings', { org: { name: 'Demo Company', type: 'office' }, wizardDone: true });
  }
  console.log(`\nMikrotik Traffic Control DEMO is running (fake router, synthetic traffic): ${base}\nPress Ctrl+C to stop.\n`);
  const stop = async () => { mgr.kill(); await mock.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
})();
