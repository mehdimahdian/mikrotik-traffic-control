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
  return /login/i.test(m) ? 'login-failed' : /ECONNREFUSED/.test(m) ? 'refused' : /timeout|ETIMEDOUT|EHOSTUNREACH/i.test(m) ? 'no-answer' : 'error:' + m.replace(/password=\S+/gi, '');
}
async function withApi(host, port, user, pw, fn) {
  const api = new RosApi(host, port, user, pw);
  try {
    await Promise.race([api.connect(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))]);
    return await fn(api);
  } finally { api.close(); }
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
        saveSettings(); sendJson(res, 200, { ok: true });
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
    if (u.pathname === '/api/init-script' && req.method === 'GET') {     // RouterOS script that prepares a fresh router for this program (API user + service)
      const ip = String(u.searchParams.get('ip') || ''); if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return sendJson(res, 200, { error: 'bad address' });
      const t = fs.readFileSync(path.join(ROUTEROS_DIR, 'mtc-init.rsc'), 'utf8').replace(/%PC_ADDRESS%/g, ip);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': 'attachment; filename="mtc-init.rsc"', 'Cache-Control': 'no-store' }); return res.end(t);
    }
    if (u.pathname === '/api/routers/test' && req.method === 'POST') {
      return readJson(req, res, async (b) => {
        const port = Number(b.port || 8728);
        if (!b.token && (!okHost(b.host) || !okPort(port) || !okUser(b.user))) return sendJson(res, 200, { ok: false, code: 'bad-input' });
        const c = await credsOf(b); if (!c.pw) return sendJson(res, 200, { ok: false, code: 'no-password' });
        sendJson(res, 200, await testRouter(c.host, c.port, c.user, c.pw));
      });
    }
    if (u.pathname === '/api/routers/inspect' && req.method === 'POST') {       // wizard: what is this router? (read only)
      return readJson(req, res, async (b) => {
        const port = Number(b.port || 8728);
        if (!b.token && (!okHost(b.host) || !okPort(port) || !okUser(b.user))) return sendJson(res, 200, { ok: false, code: 'bad-input' });
        const c = await credsOf(b); if (!c.pw) return sendJson(res, 200, { ok: false, code: 'no-password' });
        try { const info = await withApi(c.host, c.port, c.user, c.pw, (api) => routerinfo.inspect(api, c.user)); sendJson(res, 200, { ok: true, info }); }
        catch (e) { sendJson(res, 200, { ok: false, code: friendly(e) }); }
      });
    }
    if (u.pathname === '/api/routers/provision' && req.method === 'POST') {     // wizard: create the least-privilege user with a one-time admin login
      return readJson(req, res, async (b) => {
        const port = Number(b.port || 8728);
        if (!okHost(b.host) || !okPort(port) || !okUser(b.adminUser) || !b.adminPassword) return sendJson(res, 200, { ok: false, code: 'bad-input' });
        const user = 'mtc-monitor', pw = randPw();
        try {
          const pcAddress = await withApi(b.host, port, b.adminUser, String(b.adminPassword), async (api) => {
            const pcA = (api.sock && api.sock.localAddress) || '';
            await routerinfo.provisionUser(api, { user, password: pw, address: b.restrict && pcA ? pcA + '/32' : '' });
            return pcA;
          });
          const t = await testRouter(b.host, port, user, pw);
          if (!t.ok) return sendJson(res, 200, t);
          const token = crypto.randomBytes(16).toString('hex'); pending.set(token, { host: b.host, port, user, pw, exp: Date.now() + 30 * 60e3 });
          sendJson(res, 200, { ok: true, token, user, pcAddress, identity: t.identity });
        } catch (e) { sendJson(res, 200, { ok: false, code: friendly(e) }); }
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
        routers.push(r); saveRouters(); await startWorker(r);
        sendJson(res, 200, { ok: true, id, identity: t.identity });
      });
    }
    if (u.pathname === '/api/routers/delete' && req.method === 'POST') {
      return readJson(req, res, async (b) => {
        const r = routers.find((x) => x.id === b.id); if (!r) return sendJson(res, 200, { ok: false, error: 'unknown' });
        stopWorker(r.id); routers = routers.filter((x) => x.id !== r.id); saveRouters();
        sendJson(res, 200, { ok: true });          // its history folder in the data directory is kept
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
});
const down = () => { for (const id of [...workers.keys()]) stopWorker(id); setTimeout(() => process.exit(0), 300); };
process.on('SIGINT', down); process.on('SIGTERM', down);
