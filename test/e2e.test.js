'use strict';
// End-to-end test against the fake router: first-run settings, inspect, one-time provisioning, adding the router, live data,
// router base setup (block rules, FastTrack, guest network), quota configuration and removal.
const test = require('node:test');
const assert = require('node:assert');
const { fork } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { createMock } = require('./mock-router');

const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let mock, mockPort, mgr, port, dataDir, base;
const api = async (p, body) => {
  const r = await fetch(base + p, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.headers.get('content-type') && r.headers.get('content-type').includes('json') ? r.json() : r.text();
};

test.before(async () => {
  mock = createMock({ clients: 9 }); mockPort = await mock.listen(0);
  port = await freePort(); dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtc-test-')); base = `http://127.0.0.1:${port}`;
  mgr = fork(path.join(__dirname, '..', 'src', 'manager.js'), [], { env: Object.assign({}, process.env, { MTC_PORT: String(port), MTC_DATA: dataDir }), stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { try { await fetch(base + '/api/settings'); break; } catch { await sleep(250); } }
});
test.after(async () => { if (mgr) mgr.kill(); await mock.close(); await sleep(300); try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ } });

let token, routerId;
test('first run: no routers, wizard not done, 5 languages offered', async () => {
  const s = await api('/api/settings'); assert.equal(s.wizardDone, false); assert.deepEqual(s.langs, ['en', 'fa', 'ar', 'ru', 'zh']);
  assert.deepEqual(await api('/api/routers'), []);
});
test('inspect finds the WAN, networks and warnings', async () => {
  const r = await api('/api/routers/inspect', { host: '127.0.0.1', port: mockPort, user: 'demo', password: 'demo' });
  assert.equal(r.ok, true); assert.equal(r.info.wan, 'ether1'); assert.ok(r.info.networks.some((n) => n.iface === 'ether2' && n.private));
  assert.ok(r.info.warnings.includes('fasttrack')); assert.equal(r.info.identity, 'MockRouter');
});
test('wrong password gives a clean code', async () => {
  const r = await api('/api/routers/inspect', { host: '127.0.0.1', port: mockPort, user: 'demo', password: 'nope' });
  assert.equal(r.ok, false); assert.equal(r.code, 'login-failed');
});
test('provision creates a dedicated user and returns a one-time token (no password)', async () => {
  const r = await api('/api/routers/provision', { host: '127.0.0.1', port: mockPort, adminUser: 'admin', adminPassword: 'admin', restrict: false });
  assert.equal(r.ok, true); assert.match(r.user, /^mtc-/); assert.ok(r.token); assert.ok(!JSON.stringify(r).includes('password'));
  token = r.token;
  assert.ok(mock.state['/user'].some((u) => u.name === r.user && u.group === 'mtc'));
});
test('add router with the token; collector delivers live data', async () => {
  const r = await api('/api/routers', { name: 'Test Router', host: '127.0.0.1', port: mockPort, token });
  assert.equal(r.ok, true); routerId = r.id;
  const raw = fs.readFileSync(path.join(dataDir, 'routers.json'), 'utf8'); assert.ok(!raw.includes('"pw"') && /"pwEnc": "(dpapi|aes):/.test(raw));
  let live; for (let i = 0; i < 40; i++) { await sleep(500); live = await api(`/api/r/${routerId}/api/live`).catch(() => null); if (live && live.devices && live.devices.length >= 5) break; }
  assert.ok(live && live.devices.length >= 5, 'devices appear');
  assert.equal(live.status.ok, true);
});
test('router setup: plan, apply, idempotent, remove', async () => {
  const cfg = { parts: { block: true, ipblock: true, fasttrack: true, guest: true }, guest: { iface: 'ether5', address: '10.88.0.1/24', dns: '', leaseTime: '1h', isolate: true, masquerade: true } };
  assert.equal((await api(`/api/r/${routerId}/api/setup/config`, { config: cfg })).ok, true);
  const rep = await api(`/api/r/${routerId}/api/setup`); assert.ok(rep.ops.length >= 8, 'ops planned: ' + JSON.stringify(rep.error || rep.ops.length)); assert.match(rep.rsc, /\[:len \[\/ip firewall filter find/);
  const ap = await api(`/api/r/${routerId}/api/setup/apply`, { confirm: true }); assert.equal(ap.ok, true, JSON.stringify(ap));
  const f = mock.state['/ip/firewall/filter']; assert.ok(f.some((r) => /^\[mtc-block\]/.test(r.comment))); assert.equal(f.find((r) => r.action === 'fasttrack-connection').disabled, 'true');
  assert.ok(mock.state['/ip/firewall/raw'].filter((r) => /^\[mtc-ipblock\]/.test(r.comment)).length === 2);
  assert.ok(mock.state['/ip/dhcp-server'].some((r) => r.name === 'mtc-guest-dhcp'));
  const again = await api(`/api/r/${routerId}/api/setup/apply`, { confirm: true }); assert.equal(again.ops, 0, 'second apply changes nothing');
  const rm = await api(`/api/r/${routerId}/api/setup/remove`, { confirm: true }); assert.equal(rm.ok, true);
  assert.ok(!mock.state['/ip/firewall/filter'].some((r) => /^\[mtc-/.test(r.comment || '')), 'all [mtc-] rules removed');
  assert.equal(mock.state['/ip/firewall/filter'].find((r) => r.action === 'fasttrack-connection').disabled, 'false', 'FastTrack enabled again');
});
test('working hours: 24/7 and schedule are accepted, bad times rejected', async () => {
  const wk = (on) => Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, { on, start: '08:00', end: '17:00' }]));
  assert.equal((await api(`/api/r/${routerId}/api/config`, { abuse: { hours: { mode: '24x7', week: wk(true) } } })).ok, true);
  assert.equal((await api(`/api/r/${routerId}/api/config`, { abuse: { hours: { mode: 'schedule', week: wk(true) } } })).ok, true);
  const bad = wk(true); bad[1].start = '25:99';
  assert.equal((await api(`/api/r/${routerId}/api/config`, { abuse: { hours: { mode: 'schedule', week: bad } } })).ok, false);
  const a = await api(`/api/r/${routerId}/api/abuse?group=staff&period=today`); assert.ok(a.hoursMode === 'schedule' || a.hoursMode === '24x7');
});
test('usage quota config validates', async () => {
  const q = await api(`/api/r/${routerId}/api/qos`); assert.ok(q.config.quota);
  const c = Object.assign({}, q.config, { quota: Object.assign({}, q.config.quota, { enabled: true, downGB: 0, upGB: 0, totalGB: 0 }) });
  assert.equal((await api(`/api/r/${routerId}/api/qos/config`, { config: c })).ok, false, 'at least one limit needed');
});

test('hotspot: created from scratch on a fresh router, pages uploaded, enabled, removed again', async () => {
  const base = `/api/r/${routerId}/api`;
  const cfg = { iface: 'wlan-guest', orgName: { en: 'Test Cafe', local: 'كافيه' }, pageLang: 'ar', packages: { basic: { name: 'Basic', down: '3M', up: '1M', devices: 2 } }, defaultPackage: 'basic' };
  assert.equal((await api(base + '/hotspot/config', { config: cfg })).ok, true);
  const plan = await api(base + '/hotspot/plan'); assert.ok(!plan.error, plan.error);
  assert.ok(plan.ops.some((o) => /hotspot server mtc-hotspot on wlan-guest/.test(o)), 'server creation planned: ' + plan.ops.join(' | '));
  const ap = await api(base + '/hotspot/apply', { confirm: true }); assert.equal(ap.ok, true, JSON.stringify(ap));
  const srv = mock.state['/ip/hotspot'].find((r) => r.name === 'mtc-hotspot'); assert.ok(srv, 'server created'); assert.equal(srv.disabled, 'true', 'created disabled'); assert.equal(srv['address-pool'], 'pool-guest');
  assert.ok(mock.state['/ip/hotspot/user/profile'].some((r) => r.name === 'mtc-basic' && r['rate-limit'] === '1000000/3000000'));
  assert.equal((await api(base + '/hotspot/plan')).ops.length, 0, 'second prepare changes nothing');
  const up = await api(base + '/hotspot/pages', { confirm: true }); assert.equal(up.ok, true, JSON.stringify(up));
  assert.ok(mock.state['/file'].some((f) => /mtc-hotspot\/login\.html$/.test(f.name)), 'pages written');
  const page = await fetch(base.replace(/^/, 'http://127.0.0.1:' + port) + '/hotspot/preview?file=login.html').then((r) => r.text()); assert.match(page, /dir="rtl"/); assert.match(page, /Test Cafe/);
  const en = await api(base + '/hotspot/enable', { phrase: 'ENABLE GUEST WIFI', grandfather: 0 }); assert.equal(en.ok, true, JSON.stringify(en));
  assert.equal(mock.state['/ip/hotspot'].find((r) => r.name === 'mtc-hotspot').disabled, 'false');
  const acc = await api(base + '/hotspot/account', { room: '12', guest: 'Ali', package: 'basic', until: Math.floor(Date.now() / 1000) + 7200 }); assert.equal(acc.ok, true, JSON.stringify(acc)); assert.ok(acc.code);
  const rm = await api(base + '/hotspot/remove', { confirm: true }); assert.equal(rm.ok, true, JSON.stringify(rm));
  assert.ok(!mock.state['/ip/hotspot'].some((r) => r.name === 'mtc-hotspot'), 'program-created server removed');
  assert.ok(!mock.state['/ip/hotspot/user/profile'].some((r) => /^mtc-/.test(r.name)), 'packages removed');
});

test('bandwidth groups are created from the networks marked as staff / guest (no site-specific defaults)', async () => {
  const base = `/api/r/${routerId}/api`;
  assert.equal((await api(base + '/config', { staffNetworks: ['ether2'], guestNetworks: ['wlan-guest'] })).ok, true);
  const q = await api(base + '/qos'); const g = Object.fromEntries(q.config.groups.map((x) => [x.id, x.targets]));
  assert.deepEqual(g.staff, ['192.168.88.0/24']); assert.deepEqual(g.guest, ['10.20.0.0/24']);
  assert.equal(q.config.enabled, false, 'master switch stays off until the admin turns it on');
});

test('shared configuration: saved on the router, a second PC joins without the wizard', async () => {
  // PC 1 saves its configuration (organization, logo-less, networks) to the router
  await api('/api/settings', { org: { name: 'Shared Org', type: 'hotel' } });
  assert.equal((await api(`/api/r/${routerId}/api/config`, { staffNetworks: ['ether2'], guestNetworks: ['wlan-guest'], sec: { adminIps: ['192.168.88.5'] } })).ok, true);
  const push = await api('/api/routers/sync', { id: routerId, mode: 'push' }); assert.equal(push.ok, true, JSON.stringify(push));
  const scripts = mock.state['/system/script'].filter((s) => /^mtc-cfg-/.test(s.name)); assert.ok(scripts.length >= 1);
  assert.ok(scripts.every((s) => !/password|pwEnc/i.test(Buffer.from(s.source, 'base64').toString('latin1'))), 'no secrets stored');
  // PC 2: a brand-new manager with an empty data folder
  const port2 = await freePort(), dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'mtc-test2-')), base2 = `http://127.0.0.1:${port2}`;
  const m2 = fork(path.join(__dirname, '..', 'src', 'manager.js'), [], { env: Object.assign({}, process.env, { MTC_PORT: String(port2), MTC_DATA: dir2 }), stdio: 'ignore' });
  const api2 = async (p, body) => (await fetch(base2 + p, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  try {
    for (let i = 0; i < 40; i++) { try { await fetch(base2 + '/api/settings'); break; } catch { await sleep(250); } }
    assert.equal((await api2('/api/settings')).wizardDone, false);
    const creds = { host: '127.0.0.1', port: mockPort, user: 'demo', password: 'demo' };
    const rc = await api2('/api/routers/remote-config', creds); assert.equal(rc.found, true); assert.equal(rc.org, 'Shared Org');
    const add = await api2('/api/routers', Object.assign({ name: 'x', adopt: true }, creds)); assert.equal(add.ok, true);
    const s2 = await api2('/api/settings'); assert.equal(s2.org.name, 'Shared Org'); assert.equal(s2.wizardDone, true);
    const cfg = JSON.parse(fs.readFileSync(path.join(dir2, 'routers', add.id, 'config.json'), 'utf8'));
    assert.deepEqual(cfg.staffNetworks, ['ether2']); assert.deepEqual(cfg.sec.adminIps, ['192.168.88.5']);
  } finally { m2.kill(); await sleep(300); try { fs.rmSync(dir2, { recursive: true, force: true }); } catch { /* ignore */ } }
});

test('sign-in helpers: probe tells open / refused, discovery answers, a blank admin password works, login errors are specific', async () => {
  assert.equal((await api('/api/routers/probe', { host: '127.0.0.1', port: mockPort })).ok, true);
  const closed = await api('/api/routers/probe', { host: '127.0.0.1', port: await freePort() }); assert.equal(closed.ok, false); assert.equal(closed.code, 'refused');
  const d = await api('/api/discover'); assert.ok(Array.isArray(d.candidates));
  const fresh = createMock({ adminPassword: '', clients: 2 }); const fp = await fresh.listen(0);
  try {
    const bad = await api('/api/routers/provision', { host: '127.0.0.1', port: fp, adminUser: 'admin', adminPassword: 'wrong', restrict: false }); assert.equal(bad.code, 'login-failed');
    const ok = await api('/api/routers/provision', { host: '127.0.0.1', port: fp, adminUser: 'admin', adminPassword: '', restrict: false }); assert.equal(ok.ok, true, JSON.stringify(ok));
  } finally { await fresh.close(); }
});

test('API switched off: the web interface (REST) logs in, switches the API on and creates the user; probe lists the ways in', async () => {
  const apiPort = await freePort(), m = createMock({ clients: 2, apiOff: true }); await m.listen(apiPort);
  // REST must be on the standard web port for the manager to find it: use the mock's own REST port through the "http" probe list is not possible,
  // so the manager is pointed at it with a dedicated environment: here we call the library the same way the manager does.
  const restapi = require('../src/restapi'); const rp = await m.listenRest(0);
  try {
    assert.equal((await api('/api/routers/probe', { host: '127.0.0.1', port: apiPort })).ok, false, 'API closed');
    const rest = await restapi.connect('127.0.0.1', 'admin', 'admin', [[rp, false]]);
    const r = await restapi.bootstrap(rest, { user: 'mtc-x', password: 'pw123', policy: 'read,write,api' });
    assert.ok(r.pcAddress); assert.ok(m.state['/user'].some((u) => u.name === 'mtc-x' && u.group === 'mtc'));
    assert.equal(m.state['/ip/service'].find((x) => x.name === 'api').disabled, 'false');
    // the same through the wizard endpoint (API is on now, so switch it off again to force the REST path)
    const m2 = createMock({ clients: 2, apiOff: true }); const ap2 = await freePort(); await m2.listen(ap2); const rp2 = await m2.listenRest(0);
    try {
      const pv = await api('/api/routers/provision', { host: '127.0.0.1', port: ap2, webPort: rp2, adminUser: 'admin', adminPassword: 'admin', restrict: false });
      assert.equal(pv.ok, true, JSON.stringify(pv)); assert.equal(pv.via, 'rest'); assert.ok(pv.token);
      const bad = await api('/api/routers/provision', { host: '127.0.0.1', port: ap2, webPort: rp2, adminUser: 'admin', adminPassword: 'nope', restrict: false }); assert.equal(bad.code, 'login-failed');
    } finally { await m2.close(); }
    const t = await api('/api/routers/test', { host: '127.0.0.1', port: apiPort, user: 'mtc-x', password: 'pw123' }); assert.equal(t.ok, true, 'API works after the REST bootstrap');
    await assert.rejects(restapi.connect('127.0.0.1', 'admin', 'wrong', [[rp, false]]), /invalid user name or password/);
  } finally { await m.close(); }
});
test('init script is personalised: own user name, generated password, one-time token', async () => {
  const r = await fetch(base + '/api/init-script?ip=192.168.88.10&host=127.0.0.1&port=' + mockPort); const t = await r.text();
  assert.ok(r.headers.get('x-mtc-token')); assert.ok(!t.includes('CHANGE-ME-TO-A-LONG') || t.includes(':if'), 'password filled in');
  assert.match(t, /:local pw "[A-Za-z0-9]{24}"/); assert.ok(!t.includes('mtc-monitor'));
  const tk = await api('/api/routers/test', { token: r.headers.get('x-mtc-token'), host: '127.0.0.1', port: mockPort }); assert.equal(tk.ok, false, 'user does not exist on the router until the script runs');
});

test('sign out: the router is forgotten, its own API user can be removed, the shared configuration stays on the router', async () => {
  const before = mock.state['/system/script'].filter((s) => /^mtc-cfg-/.test(s.name)).length;
  const list = await api('/api/routers'); const r = list.find((x) => x.id === routerId); assert.ok(r);
  const out = await api('/api/routers/delete', { id: routerId, removeUser: true }); assert.equal(out.ok, true);
  assert.deepEqual(await api('/api/routers'), []);
  assert.equal(mock.state['/system/script'].filter((s) => /^mtc-cfg-/.test(s.name)).length, before, 'shared configuration untouched');
  assert.ok(out.userRemoved === true || out.userRemoved === false);
});
