'use strict';
// Mikrotik Traffic Control - manager: serves the dashboard on http://127.0.0.1:8787 (this PC only), keeps the list of routers and the
// organisation settings, and runs one collector (server.js) per router, each with its own database.
// Router passwords are stored encrypted: Windows DPAPI (only this Windows user on this PC can decrypt) or, on other systems, AES-256-GCM
// with a key file next to the data (mode 600). Nothing is stored in plain text.

const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { fork, execFile } = require('child_process');
const { RosApi } = require('./rosapi');
const routerinfo = require('./routerinfo');
const store = require('./routerstore');
const restapi = require('./restapi');
const os = require('os');

const PORT = Number(process.env.MTC_PORT || 8787);
const DATA = path.resolve(process.env.MTC_DATA || path.join(__dirname, '..', 'data'));
const PUB = path.join(__dirname, 'public');
const ROUTEROS_DIR = path.join(__dirname, '..', 'routeros');
const FILE = path.join(DATA, 'routers.json');
const SETTINGS = path.join(DATA, 'settings.json');
const LANGS = ['en', 'fa', 'ar', 'ru', 'zh'];
const TYPES = ['office', 'hotel', 'restaurant', 'retail', 'residential', 'school', 'other'];
fs.mkdirSync(DATA, { recursive: true });

// ---------------------------------------------------------------- settings (organisation profile)
let settings = { org: { name: '', type: 'office' }, lang: 'en', wizardDone: false };
try { settings = Object.assign(settings, JSON.parse(fs.readFileSync(SETTINGS, 'utf8'))); } catch { /* first run */ }
const saveSettings = () => fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2));

// ---------------------------------------------------------------- router list
let routers = [];
function loadRouters() { try { routers = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { routers = []; } }
function saveRouters() { fs.writeFileSync(FILE, JSON.stringify(routers, null, 2)); }
const pub = (r) => ({ id: r.id, name: r.name, host: r.host, port: r.port, user: r.user, dns: r.dns || '' });

// ---------------------------------------------------------------- secrets at rest
// Windows PowerShell 5 cannot load its modules when it inherits PSModulePath from a PowerShell 7 parent (pwsh): drop it
function cleanEnv(extra) { const e = Object.assign({}, process.env, extra); delete e.PSModulePath; return e; }
function ps(script, env) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { env: cleanEnv(env), windowsHide: true, timeout: 30000 },
      (e, out) => (e ? reject(new Error('encryption helper failed')) : resolve(String(out).trim())));
  });
}
const keyFile = path.join(DATA, 'secret.key');
function localKey() {
  try { return fs.readFileSync(keyFile); } catch { const k = crypto.randomBytes(32); fs.writeFileSync(keyFile, k, { mode: 0o600 }); return k; }
}
async function encrypt(pw) {
  if (process.platform === 'win32') return 'dpapi:' + await ps('ConvertFrom-SecureString (ConvertTo-SecureString $env:MTC_X -AsPlainText -Force)', { MTC_X: pw });
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', localKey(), iv), enc = Buffer.concat([c.update(pw, 'utf8'), c.final()]);
  return 'aes:' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
async function decrypt(blob) {
  if (blob.startsWith('aes:')) { const b = Buffer.from(blob.slice(4), 'base64'), d = crypto.createDecipheriv('aes-256-gcm', localKey(), b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'); }
  const raw = blob.startsWith('dpapi:') ? blob.slice(6) : blob;
  return ps('[Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR((ConvertTo-SecureString $env:MTC_X)))', { MTC_X: raw });
}

// one-time credentials created by "provision": the password never goes to the browser
const pending = new Map();   // token -> {host, port, user, pw, exp}
function takePending(token) { const p = pending.get(token); if (!p || p.exp < Date.now()) { pending.delete(token); return null; } return p; }

// ---------------------------------------------------------------- workers
const workers = new Map(); // id -> {proc, port, stopping}
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

async function startWorker(r) {
  stopWorker(r.id);
  const port = await freePort();
  const dataDir = path.resolve(DATA, 'routers', r.id);
  fs.mkdirSync(dataDir, { recursive: true });
  const env = Object.assign({}, process.env, { MTC_PORT: String(port), MTC_ROUTER: r.host, MTC_API_PORT: String(r.port), MTC_DATA: dataDir, MTC_DNS: r.dns || '' });
  try { env.MTC_USER = r.user; env.MTC_PW = await decrypt(r.pwEnc); }
  catch (e) { console.error('router', r.id, ': cannot decrypt the saved password (saved on another PC / Windows user?) - edit the router and enter it again'); return; }
  const log = fs.openSync(path.join(dataDir, 'monitor.log'), 'a');
  const proc = fork(path.join(__dirname, 'server.js'), [], { env, stdio: ['ignore', log, log, 'ipc'] });
  const w = { proc, port, stopping: false };
  workers.set(r.id, w);
  proc.on('exit', () => {
    if (workers.get(r.id) === w) workers.delete(r.id);
    if (!w.stopping && routers.some((x) => x.id === r.id)) setTimeout(() => { if (!workers.has(r.id)) startWorker(r).catch(() => {}); }, 5000);
  });
}
function stopWorker(id) { const w = workers.get(id); if (w) { w.stopping = true; workers.delete(id); try { w.proc.kill(); } catch { /* ignore */ } } }

function workerGet(id, p, timeout = 2500) {
  return new Promise((resolve) => {
    const w = workers.get(id); if (!w) return resolve(null);
    const req = http.get({ host: '127.0.0.1', port: w.port, path: p, headers: { Host: `127.0.0.1:${w.port}` }, timeout }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// ---------------------------------------------------------------- validation + connection helpers
const okHost = (s) => typeof s === 'string' && /^[A-Za-z0-9]([A-Za-z0-9.\-]{0,98}[A-Za-z0-9])?$/.test(s);
const okUser = (s) => typeof s === 'string' && /^[^\s=]{1,60}$/.test(s);
const okPort = (n) => Number.isInteger(n) && n > 0 && n < 65536;
const okDns = (s) => s === '' || /^\d{1,3}(\.\d{1,3}){3}$/.test(s);
function friendly(e) {
  const m = String(e.message || e);
  return /ENETUNREACH|EHOSTUNREACH|ENOTFOUND|EADDRNOTAVAIL/.test(m) ? 'unreachable' : /invalid user name or password/i.test(m) ? 'login-failed' : /login/i.test(m) ? 'error:' + m.replace(/password=\S+/gi, '') : /ECONNREFUSED/.test(m) ? 'refused' : /timeout|ETIMEDOUT|EHOSTUNREACH/i.test(m) ? 'no-answer' : 'error:' + m.replace(/password=\S+/gi, '');
}
async function withApi(host, port, user, pw, fn) {
  const api = new RosApi(host, port, user, pw);
  try {
    await Promise.race([api.connect(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))]);
    return await fn(api);
  } finally { api.close(); }
}
/** is something listening on host:port? -> 'open' | 'refused' | 'no-answer' */
let probeLocal = '';
function tcpProbe(host, port, ms = 2500) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port }); let done = false;
    const end = (v) => { if (!done) { done = true; s.destroy(); resolve(v); } };
    s.setTimeout(ms, () => end('no-answer')); s.on('connect', () => { probeLocal = s.localAddress || probeLocal; end('open'); });
    s.on('error', (e) => end(e.code === 'ECONNREFUSED' ? 'refused' : /UNREACH|NOTFOUND/.test(e.code || '') ? 'unreachable' : 'no-answer'));
  });
}
/** this PC's default gateway = almost always the router */
function gatewayGuess() {
  return new Promise((resolve) => {
    const ok = (t) => { const v = String(t || "").trim().split(/\s+/)[0]; return /^\d{1,3}(\.\d{1,3}){3}$/.test(v) && v !== '0.0.0.0' ? v : ''; };
    if (process.platform === 'win32') execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1).NextHop"], { env: cleanEnv(), windowsHide: true, timeout: 6000 }, (e, out) => resolve(e ? '' : ok(out)));
    else execFile('sh', ['-c', "ip route 2>/dev/null | awk '/^default/{print $3; exit}' || netstat -rn 2>/dev/null | awk '/^default/{print $2; exit}'"], { timeout: 4000 }, (e, out) => resolve(e ? '' : ok(out)));
  });
}
async function testRouter(host, port, user, pw) {
  try { return await withApi(host, port, user, pw, async (api) => { const id = await api.run(['/system/identity/print']); await api.run(['/ip/firewall/connection/print', '=count-only=']); return { ok: true, identity: (id[0] && id[0].name) || '' }; }); }
  catch (e) { return { ok: false, code: friendly(e) }; }
}
/** the login for a request: a one-time token (from provision), a typed password, or the saved password of router b.id */
async function credsOf(b) {
  const host = b.host, port = Number(b.port || 8728);
  if (b.token) { const p = takePending(b.token); if (!p) throw new Error('The saved login expired: create it again'); return { host: p.host, port: p.port, user: p.user, pw: p.pw }; }
  let pw = String(b.password || '');
  if (!pw && b.id) { const r = routers.find((x) => x.id === b.id); if (r) pw = await decrypt(r.pwEnc); }
  return { host, port, user: b.user, pw };
}

// ---------------------------------------------------------------- shared configuration on the router (see routerstore.js)
// Everything that defines "how this organisation uses the router" is kept on the router too, so another PC only has to log in.
// PC-only data (history database, quota counters, saved passwords) is never shared.
const SHARED_FILES = ['config.json', 'qos.json', 'setup.json', 'setup-state.json', 'hotspot.json', 'names.json', 'staff.json', 'watch.json', 'user-labels.json'];
const SYNCF = path.join(DATA, 'sync.json');
let syncState = {}; try { syncState = JSON.parse(fs.readFileSync(SYNCF, 'utf8')); } catch { /* first run */ }
const saveSync = () => { try { fs.writeFileSync(SYNCF, JSON.stringify(syncState, null, 2)); } catch { /* ignore */ } };
const syncInfo = {};          // id -> {state, at, by, error} for the dashboard
const rdir = (id) => path.resolve(DATA, 'routers', id);
const jread = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return undefined; } };
const mtimeOf = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
const LOGO = path.join(DATA, 'org-logo.png');

function buildBundle(r) {
  const files = {}; let m = Math.max(mtimeOf(SETTINGS), mtimeOf(LOGO));
  for (const n of SHARED_FILES) { const f = path.join(rdir(r.id), n), v = jread(f); if (v !== undefined) { files[n] = v; m = Math.max(m, mtimeOf(f)); } }
  let logo = null; try { const b = fs.readFileSync(LOGO); if (b.length <= 400 * 1024) logo = b.toString('base64'); } catch { /* none */ }
  const content = { org: settings.org, logo, router: { name: r.name, port: r.port, dns: r.dns || '' }, files };
  return { bundle: { v: 1, content, lang: settings.lang }, hash: store.contentHash(content), mtime: m };
}
/** write a bundle into this PC's data folder (router id); first = a PC joining: also take the default language */
function applyBundle(id, bundle, first) {
  const c = bundle.content || {};
  if (c.org && typeof c.org === 'object') settings.org = { name: String(c.org.name || '').slice(0, 80).replace(/[<>]/g, ''), type: TYPES.includes(c.org.type) ? c.org.type : 'office' };
  if (first && LANGS.includes(bundle.lang)) settings.lang = bundle.lang;
  if (first) settings.wizardDone = true;
  saveSettings();
  if (c.logo) { try { fs.writeFileSync(LOGO, Buffer.from(c.logo, 'base64')); } catch { /* ignore */ } }
  fs.mkdirSync(rdir(id), { recursive: true });
  for (const n of SHARED_FILES) if (c.files && c.files[n] !== undefined) fs.writeFileSync(path.join(rdir(id), n), JSON.stringify(c.files[n], null, 2));
}
async function apiFor(r) { const api = new RosApi(r.host, r.port, r.user, await decrypt(r.pwEnc)); await Promise.race([api.connect(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))]); return api; }

let syncBusy = false;
/** one reconciliation: push local changes, pull router changes. mode: 'push' | 'pull' | undefined (automatic) */
async function syncRouter(r, mode) {
  const info = syncInfo[r.id] = syncInfo[r.id] || {}; let api;
  try {
    api = await apiFor(r);
    const m = await store.meta(api), L = buildBundle(r), st = syncState[r.id] = syncState[r.id] || {};
    let act = 'none';
    if (mode === 'push' || (!mode && !m)) act = 'push';
    else if (mode === 'pull') act = m ? 'pull' : 'none';
    else if (m.c === L.hash) act = 'none';
    else if (st.hash === L.hash) act = 'pull';                    // this PC changed nothing since the last sync
    else if (st.hash === m.c) act = 'push';                       // the router copy did not change
    else act = L.mtime > (m.at || 0) ? 'push' : 'pull';           // both changed: the newer one wins
    if (act === 'push') { await store.write(api, L.bundle, os.hostname()); st.hash = L.hash; info.by = os.hostname(); info.at = Date.now(); }
    else if (act === 'pull') {
      const got = await store.read(api);
      if (got) { applyBundle(r.id, got.bundle, false); st.hash = buildBundle(r).hash; info.by = got.by; info.at = got.at; stopWorker(r.id); await startWorker(r); }
    } else { st.hash = L.hash; if (m) { info.by = m.by; info.at = m.at; } }
    saveSync(); info.state = act === 'none' ? 'ok' : act === 'push' ? 'saved' : 'loaded'; info.error = ''; info.checked = Date.now();
  } catch (e) { info.state = 'error'; info.error = friendly(e); }
  finally { if (api) api.close(); }
  return info;
}
async function syncAll() {
  if (syncBusy) return; syncBusy = true;
  try { for (const r of routers) await syncRouter(r); } finally { syncBusy = false; }
}
let syncTimer = null;
const syncSoon = () => { clearTimeout(syncTimer); syncTimer = setTimeout(() => syncAll().catch(() => {}), 2000); };

// ---------------------------------------------------------------- http
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const hostOk = (h) => h === `127.0.0.1:${PORT}` || h === `localhost:${PORT}`;
const sendJson = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(b); };
function readJson(req, res, cb) {
  if ((req.headers['content-type'] || '').indexOf('application/json') !== 0 || (req.headers.origin && !hostOk(req.headers.origin.replace(/^https?:\/\//, '')))) { res.writeHead(403); return res.end('forbidden'); }
  let body = ''; req.on('data', (c) => { body += c; if (body.length > 20000) req.destroy(); });
  req.on('end', async () => { try { await cb(JSON.parse(body)); } catch (e) { console.error('request failed:', req.url, e.message); sendJson(res, 400, { ok: false, error: 'bad request' }); } });
}
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'router';
const randPw = () => crypto.randomBytes(18).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 24).padEnd(24, 'x');

const server = http.createServer(async (req, res) => {
  if (!hostOk(req.headers.host || '')) { res.writeHead(403); return res.end('forbidden'); }
  const u = new URL(req.url, 'http://x');
  try {
    // proxy to a router's collector
    const m = /^\/api\/r\/([a-z0-9-]+)(\/.*)$/.exec(u.pathname);
    if (m) {
      const w = workers.get(m[1]);
      if (!w) return sendJson(res, 503, { error: 'collector not running' });
      if (req.method !== 'GET' && req.headers.origin && !hostOk(req.headers.origin.replace(/^https?:\/\//, ''))) { res.writeHead(403); return res.end('forbidden'); }
      const hdr = Object.assign({}, req.headers, { host: `127.0.0.1:${w.port}` }); delete hdr.origin;
      const opts = { host: '127.0.0.1', port: w.port, path: m[2] + u.search, method: req.method, headers: hdr };
      const pr = http.request(opts, (r2) => { res.writeHead(r2.statusCode, r2.headers); r2.pipe(res); });
      pr.on('error', () => { if (!res.headersSent) sendJson(res, 502, { error: 'collector error' }); });
      return req.pipe(pr);
    }
    if (u.pathname === '/api/settings' && req.method === 'GET') return sendJson(res, 200, Object.assign({}, settings, { langs: LANGS, types: TYPES, platform: process.platform, hasLogo: fs.existsSync(path.join(DATA, 'org-logo.png')), version: require('../package.json').version }));
    if (u.pathname === '/api/settings' && req.method === 'POST') {
      return readJson(req, res, (b) => {
        if (b.lang !== undefined) { if (!LANGS.includes(b.lang)) return sendJson(res, 200, { ok: false, error: 'bad language' }); settings.lang = b.lang; }
        if (b.org) { const name = String(b.org.name || '').trim().slice(0, 80).replace(/[<>]/g, ''), type = TYPES.includes(b.org.type) ? b.org.type : settings.org.type; settings.org = { name, type }; }
        if (b.wizardDone !== undefined) settings.wizardDone = !!b.wizardDone;
        saveSettings(); syncSoon(); sendJson(res, 200, { ok: true });
      });
    }
    if (u.pathname === '/org-logo.png') {                       // optional: put your own logo at <data>/org-logo.png
      const f = path.join(DATA, 'org-logo.png'); if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }); return fs.createReadStream(f).pipe(res);
    }
    if (u.pathname === '/api/routers' && req.method === 'GET') {
      const list = await Promise.all(routers.map(async (r) => Object.assign(pub(r), { status: await workerGet(r.id, '/api/status') })));
      return sendJson(res, 200, list);
    }
    if (u.pathname === '/api/init-script' && req.method === 'GET') {     // RouterOS script (Winbox / SSH terminal) that prepares a router for this program: API user + service
      const ip = String(u.searchParams.get('ip') || ''), host = String(u.searchParams.get('host') || ''), port = Number(u.searchParams.get('port') || 8728);
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return sendJson(res, 200, { error: 'bad address' });
      const user = 'mtc-' + slug(os.hostname()).slice(0, 18), pw = randPw(), token = crypto.randomBytes(16).toString('hex');
      let t = fs.readFileSync(path.join(ROUTEROS_DIR, 'mtc-init.rsc'), 'utf8').replace(/%PC_ADDRESS%/g, ip).replace(/mtc-monitor/g, user);
      t = t.replace('"CHANGE-ME-TO-A-LONG-RANDOM-PASSWORD"   ;# <== CHANGE ME', '"' + pw + '"');   // the generated password; the program keeps it (encrypted) when you continue
      if (okHost(host) && okPort(port)) pending.set(token, { host, port, user, pw, exp: Date.now() + 30 * 60e3 });
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': 'attachment; filename="mtc-init.rsc"', 'Cache-Control': 'no-store', 'X-MTC-Token': token }); return res.end(t);
    }
    if (u.pathname === '/api/discover' && req.method === 'GET') {            // wizard: guess the router (this PC's gateway) and see whether its API answers
      const gw = await gatewayGuess(), cands = [...new Set([gw, '192.168.88.1'].filter(Boolean))], found = [];
      for (const h of cands) found.push({ host: h, api: await tcpProbe(h, 8728, 1500) });
      return sendJson(res, 200, { gateway: gw, candidates: found });
    }
    if (u.pathname === '/api/routers/probe' && req.method === 'POST') {      // wizard: which ways lead to this router? (API, web/REST, SSH, Winbox)
      return readJson(req, res, async (b) => {
        const port = Number(b.port || 8728); if (!okHost(b.host) || !okPort(port)) return sendJson(res, 200, { ok: false, code: 'bad-input' });
        const names = { api: port, 'api-ssl': 8729, http: 80, https: 443, ssh: 22, winbox: 8291 };
        const res2 = await Promise.all(Object.values(names).map((pt) => tcpProbe(b.host, pt, 1800)));
        const ports = Object.fromEntries(Object.keys(names).map((k, i) => [k, res2[i]]));
        sendJson(res, 200, { ok: ports.api === 'open', code: ports.api === 'open' ? '' : ports.api, ports, pc: probeLocal.replace(/^::ffff:/, '') });
      });
    }
    if (u.pathname === '/api/routers/test' && req.method === 'POST') {
      return readJson(req, res, async (b) => {
        const port = Number(b.port || 8728);
        if (!b.token && (!okHost(b.host) || !okPort(port) || !okUser(b.user))) return sendJson(res, 200, { ok: false, code: 'bad-input' });
        const c = await credsOf(b);
        sendJson(res, 200, await testRouter(c.host, c.port, c.user, c.pw));
      });
    }
    if (u.pathname === '/api/routers/inspect' && req.method === 'POST') {       // wizard: what is this router? (read only)
      return readJson(req, res, async (b) => {
        const port = Number(b.port || 8728);
        if (!b.token && (!okHost(b.host) || !okPort(port) || !okUser(b.user))) return sendJson(res, 200, { ok: false, code: 'bad-input' });
        const c = await credsOf(b);          // a blank password is legal on RouterOS (a new router's admin has none)
        try { const info = await withApi(c.host, c.port, c.user, c.pw, (api) => routerinfo.inspect(api, c.user)); sendJson(res, 200, { ok: true, info }); }
        catch (e) { sendJson(res, 200, { ok: false, code: friendly(e) }); }
      });
    }
    if (u.pathname === '/api/routers/provision' && req.method === 'POST') {     // wizard: sign in any way that works and create the least-privilege API user
      return readJson(req, res, async (b) => {
        const port = Number(b.port || 8728);
        if (!okHost(b.host) || !okPort(port) || !okUser(b.adminUser)) return sendJson(res, 200, { ok: false, code: 'bad-input' });
        const user = 'mtc-' + slug(os.hostname()).slice(0, 18), pw = randPw();   // one API user per PC: a second PC must not reset the first one's password
        const done = async (pcAddress, via) => {
          const t = await testRouter(b.host, port, user, pw); if (!t.ok) return sendJson(res, 200, Object.assign({ via }, t));
          const token = crypto.randomBytes(16).toString('hex'); pending.set(token, { host: b.host, port, user, pw, exp: Date.now() + 30 * 60e3 });
          sendJson(res, 200, { ok: true, token, user, pcAddress, identity: t.identity, via });
        };
        let first;
        try {   // 1. the RouterOS API
          const pcAddress = await withApi(b.host, port, b.adminUser, String(b.adminPassword), async (api) => {
            const pcA = (api.sock && api.sock.localAddress) || '';
            await routerinfo.provisionUser(api, { user, password: pw, address: b.restrict && pcA ? pcA + '/32' : '' });
            return pcA;
          });
          return await done(pcAddress, 'api');
        } catch (e) { first = friendly(e); }
        if (['login-failed', 'refused', 'no-answer', 'unreachable'].includes(first)) {
          try {   // 2. the web interface (REST, RouterOS 7): log in there, switch the API on, create the user
            const rest = await restapi.connect(b.host, b.adminUser, String(b.adminPassword), b.webPort && okPort(Number(b.webPort)) ? [[Number(b.webPort), !!b.webTls]] : [[80, false], [443, true]]);
            const r = await restapi.bootstrap(rest, { user, password: pw, policy: 'read,write,api,test,ftp,policy,sensitive' });
            return await done(r.pcAddress, 'rest');
          } catch (e) { if (/invalid user name or password/.test(e.message)) first = 'login-failed'; }
        }
        sendJson(res, 200, { ok: false, code: first });
      });
    }
    if (u.pathname === '/api/routers' && req.method === 'POST') {
      return readJson(req, res, async (b) => {
        const name = String(b.name || '').trim().slice(0, 60), dns = String(b.dns || '').trim();
        const ex = b.id ? routers.find((x) => x.id === b.id) : null;
        const c = await credsOf(Object.assign({}, b, { id: ex && ex.id }));
        if (!name || !okHost(c.host) || !okPort(c.port) || !okDns(dns) || !okUser(c.user)) return sendJson(res, 200, { ok: false, code: 'bad-input' });
        if (!c.pw) return sendJson(res, 200, { ok: false, code: 'no-password' });
        const t = await testRouter(c.host, c.port, c.user, c.pw);
        if (!t.ok) return sendJson(res, 200, t);
        const pwEnc = (b.password || b.token || !ex) ? await encrypt(c.pw) : ex.pwEnc;
        if (ex) { Object.assign(ex, { name, host: c.host, port: c.port, user: c.user, dns, pwEnc }); saveRouters(); await startWorker(ex); return sendJson(res, 200, { ok: true, id: ex.id, identity: t.identity }); }
        let id = slug(name); while (routers.some((x) => x.id === id)) id = slug(name).slice(0, 18) + '-' + Math.random().toString(36).slice(2, 6);
        const r = { id, name, host: c.host, port: c.port, user: c.user, pwEnc, dns };
        if (b.adopt) {         // join: take the shared configuration from the router before the collector starts
          const got = await withApi(c.host, c.port, c.user, c.pw, (api) => store.read(api)).catch(() => null);
          if (got) { const rc = (got.bundle.content || {}).router || {}; if (rc.name) r.name = String(rc.name).slice(0, 60); if (okDns(rc.dns || '')) r.dns = rc.dns || ''; applyBundle(id, got.bundle, true); }
        }
        routers.push(r); saveRouters(); await startWorker(r); setTimeout(() => syncRouter(r).catch(() => {}), 4000);
        sendJson(res, 200, { ok: true, id, identity: t.identity });
      });
    }
    if (u.pathname === '/api/routers/remote-config' && req.method === 'POST') {   // wizard: does this router already carry a shared configuration?
      return readJson(req, res, async (b) => {
        const port = Number(b.port || 8728);
        if (!b.token && (!okHost(b.host) || !okPort(port) || !okUser(b.user))) return sendJson(res, 200, { ok: false, code: 'bad-input' });
        const c = await credsOf(b);
        try {
          const got = await withApi(c.host, c.port, c.user, c.pw, (api) => store.read(api));
          if (!got) return sendJson(res, 200, { ok: true, found: false });
          const cc = got.bundle.content || {};
          sendJson(res, 200, { ok: true, found: true, by: got.by, at: got.at, org: (cc.org && cc.org.name) || '', router: (cc.router && cc.router.name) || '', hasLogo: !!cc.logo });
        } catch (e) { sendJson(res, 200, { ok: false, code: friendly(e) }); }
      });
    }
    if (u.pathname === '/api/routers/sync' && req.method === 'GET') {
      const r = routers.find((x) => x.id === u.searchParams.get('id')); if (!r) return sendJson(res, 200, { ok: false });
      return sendJson(res, 200, Object.assign({ ok: true, host: os.hostname() }, syncInfo[r.id] || { state: 'pending' }));
    }
    if (u.pathname === '/api/routers/sync' && req.method === 'POST') {            // "Save to router" / "Load from router" buttons
      return readJson(req, res, async (b) => {
        const r = routers.find((x) => x.id === b.id); if (!r) return sendJson(res, 200, { ok: false, error: 'unknown' });
        const i = await syncRouter(r, b.mode === 'push' ? 'push' : b.mode === 'pull' ? 'pull' : undefined);
        sendJson(res, 200, Object.assign({ ok: i.state !== 'error' }, i));
      });
    }
    if (u.pathname === '/api/routers/delete' && req.method === 'POST') {
      return readJson(req, res, async (b) => {
        const r = routers.find((x) => x.id === b.id); if (!r) return sendJson(res, 200, { ok: false, error: 'unknown' });
        let userRemoved = false;
        if (b.removeUser && /^mtc-/.test(r.user)) {     // sign-out option: also delete this PC's own API user from the router (best effort)
          try { userRemoved = await withApi(r.host, r.port, r.user, await decrypt(r.pwEnc), async (api) => { const u = await api.run(['/user/print', '=.proplist=.id,name', '?name=' + r.user]); if (!u[0]) return false; await api.run(['/user/remove', '=numbers=' + u[0]['.id']]); return true; }); }
          catch { userRemoved = false; }
        }
        stopWorker(r.id); routers = routers.filter((x) => x.id !== r.id); saveRouters();
        delete syncState[r.id]; delete syncInfo[r.id]; saveSync();
        sendJson(res, 200, { ok: true, userRemoved });          // its history folder in the data directory is kept
      });
    }
    // static (dashboard files only)
    const f = u.pathname === '/' ? '/index.html' : u.pathname;
    const full = path.normalize(path.join(PUB, f));
    if (!full.startsWith(PUB) || !fs.existsSync(full) || !fs.statSync(full).isFile()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(full).pipe(res);
  } catch (e) { if (!res.headersSent) sendJson(res, 500, { error: 'server error' }); }
});
server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use (is it already running?)` : e.message); process.exit(1); });
loadRouters();
server.listen(PORT, '127.0.0.1', async () => {
  console.log(`Mikrotik Traffic Control on http://127.0.0.1:${PORT}  (${routers.length} router(s), data in ${DATA})`);
  for (const r of routers) await startWorker(r).catch((e) => console.error('start failed', r.id, e.message));
  setTimeout(() => syncAll().catch(() => {}), 5000); setInterval(() => syncAll().catch(() => {}), 30000);
});
const down = () => { for (const id of [...workers.keys()]) stopWorker(id); setTimeout(() => process.exit(0), 300); };
process.on('SIGINT', down); process.on('SIGTERM', down);
