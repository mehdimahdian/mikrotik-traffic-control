'use strict';
// A small fake RouterOS API server: enough of the API for the dashboard, the setup wizard and the tests - and for `npm run demo`,
// so you can try Mikrotik Traffic Control without a router. State lives in memory; firewall/queue/hotspot objects can be added,
// changed and removed like on a real router. Synthetic clients generate growing connection counters.

const net = require('net');
const http = require('http');
const { encSentence, parseSentence } = require('../src/rosapi');

const bool = (v) => (v === 'yes' || v === 'true' ? 'true' : v === 'no' || v === 'false' ? 'false' : v);

function createMock(opts = {}) {
  const o = Object.assign({ user: 'demo', password: 'demo', wan: 'ether1', clients: 12, fresh: false, group: 'full' }, opts);
  let seq = 0; const nid = () => '*' + (++seq).toString(16).toUpperCase();
  const T = {};   // path -> rows
  const tbl = (p) => (T[p] = T[p] || []);
  const put = (p, row) => { const r = Object.assign({ '.id': nid() }, row); tbl(p).push(r); return r; };

  put('/system/identity', { name: 'MockRouter' });
  put('/system/resource', { version: '7.19.3 (stable)', 'board-name': 'CCR2116-12G-4S+' });
  put('/system/ntp/client', { enabled: 'true' });
  put('/interface', { name: o.wan, type: 'ether', running: 'true', disabled: 'false' });
  put('/interface', { name: 'ether2', type: 'ether', running: 'true', disabled: 'false', comment: 'Office LAN' });
  put('/interface', { name: 'ether5', type: 'ether', running: 'false', disabled: 'false' });
  put('/interface', { name: 'wlan-guest', type: 'wlan', running: 'true', disabled: 'false', comment: 'Guest Wi-Fi' });
  put('/ip/address', { address: '203.0.113.2/30', network: '203.0.113.0', interface: o.wan, disabled: 'false' });
  put('/ip/address', { address: '192.168.88.1/24', network: '192.168.88.0', interface: 'ether2', disabled: 'false' });
  if (!o.fresh) put('/ip/address', { address: '10.20.0.1/24', network: '10.20.0.0', interface: 'wlan-guest', disabled: 'false' });
  put('/ip/route', { 'dst-address': '0.0.0.0/0', gateway: '203.0.113.1', 'immediate-gw': '203.0.113.1%' + o.wan, active: 'true', distance: '1', 'routing-table': 'main' });
  put('/ip/dhcp-server', { name: 'dhcp-office', interface: 'ether2', 'address-pool': 'pool-office', disabled: 'false' });
  if (!o.fresh) put('/ip/dhcp-server', { name: 'dhcp-guest', interface: 'wlan-guest', 'address-pool': 'pool-guest', disabled: 'false' });
  put('/ip/firewall/filter', { chain: 'forward', action: 'fasttrack-connection', disabled: 'false', comment: 'defconf: fasttrack' });
  put('/ip/firewall/filter', { chain: 'forward', action: 'accept', disabled: 'false', comment: 'defconf: accept established' });
  put('/ip/firewall/filter', { chain: 'input', action: 'accept', disabled: 'false', comment: 'defconf: accept established' });
  put('/ip/service', { name: 'api', port: '8728', disabled: o.apiOff ? 'true' : 'false', address: '' });
  put('/ip/service', { name: 'www', port: '80', disabled: 'false', address: '' });
  put('/user/group', { name: 'full', policy: 'local,telnet,ssh,ftp,reboot,read,write,policy,test,winbox,password,web,sniff,sensitive,api,romon,rest-api' });
  put('/user', { name: o.user, group: o.group });
  put('/user', { name: 'admin', group: 'full' });
  // synthetic clients
  const clients = [];
  for (let i = 0; i < o.clients; i++) {
    const guest = i % 3 === 2, ip = guest ? `10.20.0.${10 + i}` : `192.168.88.${10 + i}`;
    clients.push({ ip, mac: '02:00:00:00:00:' + (16 + i).toString(16).padStart(2, '0').toUpperCase(), name: (guest ? 'guest-phone-' : 'pc-') + i, iface: guest ? 'wlan-guest' : 'ether2', rate: (guest ? 400e3 : 150e3) * (1 + (i % 5)), up: 0, down: 0 });
    put('/ip/dhcp-server/lease', { address: ip, 'mac-address': clients[i].mac, 'host-name': clients[i].name, dynamic: 'true', server: guest ? 'dhcp-guest' : 'dhcp-office' });
    put('/ip/arp', { address: ip, 'mac-address': clients[i].mac, interface: clients[i].iface, status: 'reachable' });
  }
  let last = Date.now();
  const tick = () => { const dt = (Date.now() - last) / 1000; last = Date.now(); for (const c of clients) { c.down += c.rate * dt * (0.5 + Math.random()); c.up += c.rate * dt * 0.1 * (0.5 + Math.random()); } };

  const conns = () => {
    tick(); const rows = []; let k = 0;
    for (const c of clients) for (let j = 0; j < 3; j++) {
      const rip = `198.51.100.${(k++ % 200) + 10}`;
      rows.push({ '.id': '*C' + k, protocol: 'tcp', 'src-address': `${c.ip}:${40000 + j}`, 'dst-address': `${rip}:443`, 'reply-src-address': `${rip}:443`, 'reply-dst-address': `${o.wan === 'x' ? '' : '203.0.113.2'}:${40000 + j}`,
        'orig-bytes': String(Math.round(c.up / 3)), 'repl-bytes': String(Math.round(c.down / 3)), 'seen-reply': 'true' });
    }
    return rows;
  };

  const matchQ = (row, queries) => queries.every(([k, v]) => String(row[k]) === v);
  function handle(words) {
    const cmd = words[0], args = {}, queries = [];
    for (const w of words.slice(1)) { if (w[0] === '=') { const j = w.indexOf('=', 1); if (j > 0) args[w.slice(1, j)] = w.slice(j + 1); } else if (w[0] === '?') { const j = w.indexOf('='); if (j > 0) queries.push([w.slice(1, j), w.slice(j + 1)]); } }
    const m = /^(.*)\/(print|add|remove|set|enable|disable)$/.exec(cmd);
    if (cmd === '/export') { put('/file', { name: (args.file || 'export') + '.rsc', size: '1000' }); return []; }
    if (cmd === '/ping') return [{ received: '1' }];
    if (cmd === '/file/add') { put('/file', { name: args.name, size: String((args.contents || '').length), contents: args.contents || '' }); return []; }
    if (cmd === '/tool/fetch') return [];
    if (cmd === '/log/print') return [];
    if (!m) throw new Error('no such command: ' + cmd);
    const [, p, verb] = m;
    if (p === '/ip/firewall/connection') { if (verb === 'print') return args['count-only'] !== undefined ? [{ ret: String(clients.length * 3) }] : conns(); if (verb === 'remove') return []; }
    if (verb === 'print') {
      if (p === '/ip/hotspot/active' || p === '/ip/hotspot/user' || p === '/ip/hotspot/user/profile' || p === '/ip/hotspot/ip-binding') return tbl(p).filter((r) => matchQ(r, queries)).map((r) => Object.assign({}, r));
      return tbl(p).filter((r) => matchQ(r, queries)).map((r) => Object.assign({ disabled: 'false' }, r));
    }
    if (verb === 'add') {
      const row = {}; for (const [k, v] of Object.entries(args)) if (k !== 'place-before') row[k] = k === 'disabled' ? bool(v) : v;
      if (p === '/user') row.group = row.group || 'read';
      const r = { '.id': nid() }; Object.assign(r, row);
      const pb = args['place-before']; const arr = tbl(p), at = pb ? arr.findIndex((x) => x['.id'] === pb) : -1;
      if (at >= 0) arr.splice(at, 0, r); else arr.push(r);
      return [{ ret: r['.id'] }];
    }
    const ids = String(args.numbers || args['.id'] || '').split(',').filter(Boolean);
    const rows = tbl(p).filter((r) => ids.includes(r['.id']));
    if (!rows.length && ids.length) throw new Error('no such item');
    if (verb === 'remove') { T[p] = tbl(p).filter((r) => !ids.includes(r['.id'])); return []; }
    if (verb === 'enable' || verb === 'disable') { for (const r of rows) r.disabled = verb === 'disable' ? 'true' : 'false'; return []; }
    if (verb === 'set') { for (const r of rows) for (const [k, v] of Object.entries(args)) if (k !== 'numbers' && k !== '.id') r[k] = k === 'disabled' ? bool(v) : v; return []; }
    return [];
  }

  let sockets = new Set();
  const server = net.createServer((s) => {
    sockets.add(s); s.on('close', () => sockets.delete(s)); s.on('error', () => {});
    let buf = Buffer.alloc(0), authed = false;
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const r = parseSentence(buf); if (!r) return; buf = buf.subarray(r.used);
        const w = r.words, send = (...x) => s.write(encSentence(x));
        try {
          if (w[0] === '/login') {
            const a = Object.fromEntries(w.slice(1).map((x) => { const j = x.indexOf('=', 1); return [x.slice(1, j), x.slice(j + 1)]; }));
            const ok = (a.name === o.user && a.password === o.password) || (a.name === 'admin' && a.password === (o.adminPassword !== undefined ? o.adminPassword : 'admin')) || tbl('/user').some((u) => u.name === a.name && u.pw === a.password);
            if (!ok) { send('!trap', '=message=invalid user name or password (6)'); send('!done'); continue; }
            authed = true; s.user = a.name; send('!done'); continue;
          }
          if (!authed) { send('!fatal', 'not logged in'); continue; }
          if (w[0] === '/user/add') { const a = Object.fromEntries(w.slice(1).filter((x) => x[0] === '=').map((x) => { const j = x.indexOf('=', 1); return [x.slice(1, j), x.slice(j + 1)]; })); put('/user', { name: a.name, group: a.group, pw: a.password, address: a.address || '' }); send('!done'); continue; }
          for (const row of handle(w)) send('!re', ...Object.entries(row).map(([k, v]) => `=${k}=${v}`));
          send('!done');
        } catch (e) { send('!trap', '=message=' + e.message); send('!done'); }
      }
    });
  });
  // ---- REST (web interface) of RouterOS 7: /rest/<menu path>  GET (print, ?name=x), PUT (add), PATCH /<id> (set)
  let apiPort = 0, apiUp = false;
  const startApi = () => new Promise((res) => { if (apiUp) return res(apiPort); server.listen(apiPort, '127.0.0.1', () => { apiUp = true; apiPort = server.address().port; res(apiPort); }); });
  const stopApi = () => new Promise((res) => { if (!apiUp) return res(); for (const x of sockets) x.destroy(); server.close(() => { apiUp = false; res(); }); });
  const restAuth = (hdr) => { const m = /^Basic (.*)$/.exec(hdr || ''); if (!m) return false; const t = Buffer.from(m[1], 'base64').toString(), i = t.indexOf(':'), n = t.slice(0, i), pw = t.slice(i + 1);
    return (n === o.user && pw === o.password) || (n === 'admin' && pw === (o.adminPassword !== undefined ? o.adminPassword : 'admin')) || tbl('/user').some((u) => u.name === n && u.pw === pw); };
  const rest = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
      if (!restAuth(req.headers.authorization)) return send(401, { error: 401, message: 'Unauthorized' });
      const u = new URL(req.url, 'http://x'); if (!u.pathname.startsWith('/rest/')) return send(404);
      let path = u.pathname.slice(5), id = null; const m = /^(.*)\/(\*[0-9A-F]+)$/.exec(path); if (m) { path = m[1]; id = m[2]; }
      let j = {}; try { j = body ? JSON.parse(body) : {}; } catch { return send(400, { detail: 'bad json' }); }
      if (req.method === 'GET') { const q = [...u.searchParams.entries()]; return send(200, tbl(path).filter((r) => matchQ(r, q)).map((r) => Object.assign({ disabled: 'false' }, r))); }
      if (req.method === 'PUT') { const row = Object.assign({}, j); if (path === '/user') { row.pw = j.password; delete row.password; } return send(201, put(path, row)); }
      if (req.method === 'PATCH') {
        const row = tbl(path).find((r) => r['.id'] === id); if (!row) return send(404, { detail: 'no such item' });
        for (const [k, v] of Object.entries(j)) { if (k === 'password') row.pw = v; else row[k] = v; }
        if (path === '/ip/service' && row.name === 'api' && row.disabled === 'false') startApi();
        return send(200, row);
      }
      send(405);
    });
  });
  return {
    state: T, clients,
    listen: async (port = 0) => { if (!o.apiOff) await startApi(); else { apiPort = port; } return apiPort; },
    listenRest: (port = 0) => new Promise((res) => rest.listen(port, '127.0.0.1', () => res(rest.address().port))),
    setApiPort: (port) => { apiPort = port; },
    close: () => new Promise((res) => { for (const x of sockets) x.destroy(); rest.close(); if (apiUp) server.close(() => res()); else res(); }),
  };
}
module.exports = { createMock };
