'use strict';
// Mikrotik Traffic Control - per-router collector (one process per router, started by manager.js).
// Reads the connection table, ARP and DHCP leases. Its only router WRITES are the block / unblock address-list entries and the
// [mtc-qos] simple queues, and only when you ask for them in the dashboard.
// The router login arrives in the environment from manager.js (decrypted from the DPAPI store); it is never logged or stored here.
// Data: <data dir>/traffic.db (SQLite), names.json (your own device names), config.json, qos.json.

const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const { DatabaseSync } = require('node:sqlite');

const CFG = {
  router: process.env.MTC_ROUTER || '',
  apiPort: Number(process.env.MTC_API_PORT || 8728),
  httpPort: Number(process.env.MTC_PORT || 8787),
  pollMs: Number(process.env.MTC_POLL_MS || 3000),
  dnsServer: process.env.MTC_DNS || '',   // optional internal DNS server used for reverse names of PCs ('' = none)
  dataDir: process.env.MTC_DATA || path.join(__dirname, '..', 'data'),
  publicDir: path.join(__dirname, 'public'),
};
fs.mkdirSync(CFG.dataDir, { recursive: true });

const { RosApi } = require('./rosapi');
const { classify } = require('./classify');
const { detect } = require('./security');
const qos = require('./qos');
let apiConn = null;          // the live router connection (used for the block / unblock writes)

// Started by manager.js (one worker per router): the login comes in the environment (MTC_USER / MTC_PW) and is removed at once.
const ENV_CRED = process.env.MTC_PW ? { user: process.env.MTC_USER, pw: process.env.MTC_PW } : null;
delete process.env.MTC_PW; delete process.env.MTC_USER;

function readCreds() {
  if (!ENV_CRED) throw new Error('No router login: start the program through manager.js (npm start), not server.js directly');
  return ENV_CRED;
}

// ---------------------------------------------------------------- helpers
const ip2n = (ip) => { const a = ip.split('.'); return ((+a[0] << 24) >>> 0) + (+a[1] << 16) + (+a[2] << 8) + +a[3]; };
const isIPv4 = (s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s);
function isPrivate(ip) {
  const a = ip.split('.').map(Number);
  return a[0] === 10 || a[0] === 127 || (a[0] === 172 && a[1] >= 16 && a[1] <= 31) || (a[0] === 192 && a[1] === 168) ||
    (a[0] === 169 && a[1] === 254) || (a[0] === 100 && a[1] >= 64 && a[1] <= 127) || a[0] >= 224 || a[0] === 0;
}
const hostOf = (addr) => { const i = addr.indexOf(':'); return i < 0 ? addr : addr.slice(0, i); };
const portOf = (addr) => { const i = addr.indexOf(':'); return i < 0 ? 0 : +addr.slice(i + 1); };
const pad = (n) => String(n).padStart(2, '0');
const dayStr = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const now = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------- database
const db = new DatabaseSync(path.join(CFG.dataDir, 'traffic.db'));
db.exec(`
PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
CREATE TABLE IF NOT EXISTS m (ip TEXT, ts INTEGER, iu INTEGER, id INTEGER, lu INTEGER, ld INTEGER, PRIMARY KEY (ip, ts)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS m_ts ON m(ts);
CREATE TABLE IF NOT EXISTS h (ip TEXT, ts INTEGER, iu INTEGER, id INTEGER, lu INTEGER, ld INTEGER, PRIMARY KEY (ip, ts)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS h_ts ON h(ts);
CREATE TABLE IF NOT EXISTS d (ip TEXT, day TEXT, iu INTEGER, id INTEGER, lu INTEGER, ld INTEGER, PRIMARY KEY (ip, day)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS d_day ON d(day);
CREATE TABLE IF NOT EXISTS names (ip TEXT PRIMARY KEY, name TEXT, mac TEXT, vlan TEXT, seen INTEGER);
CREATE TABLE IF NOT EXISTS rm (day TEXT, ip TEXT, remote TEXT, iu INTEGER, id INTEGER, hits INTEGER, port INTEGER, PRIMARY KEY (day, ip, remote)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS rm_remote ON rm(remote, day);
CREATE TABLE IF NOT EXISTS x (day TEXT, ip TEXT, mc INTEGER, mr INTEGER, mh INTEGER, PRIMARY KEY (day, ip)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS cc (ts INTEGER PRIMARY KEY, total INTEGER, inet INTEGER);
CREATE TABLE IF NOT EXISTS ptr (ip TEXT PRIMARY KEY, name TEXT, ts INTEGER);
CREATE TABLE IF NOT EXISTS sec (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, last INTEGER, kind TEXT, sev TEXT, ip TEXT, detail TEXT, count INTEGER DEFAULT 1, ack INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS sec_ts ON sec(ts);
`);
const stRM = db.prepare('INSERT INTO rm (day,ip,remote,iu,id,hits,port) VALUES (?,?,?,?,?,?,?) ON CONFLICT(day,ip,remote) DO UPDATE SET iu=iu+excluded.iu, id=id+excluded.id, hits=hits+excluded.hits, port=excluded.port');
const stX = db.prepare('INSERT INTO x (day,ip,mc,mr,mh) VALUES (?,?,?,?,?) ON CONFLICT(day,ip) DO UPDATE SET mc=MAX(mc,excluded.mc), mr=MAX(mr,excluded.mr), mh=MAX(mh,excluded.mh)');
const stCC = db.prepare('INSERT INTO cc (ts,total,inet) VALUES (?,?,?) ON CONFLICT(ts) DO UPDATE SET total=MAX(total,excluded.total), inet=MAX(inet,excluded.inet)');
const stPtr = db.prepare('INSERT INTO ptr (ip,name,ts) VALUES (?,?,?) ON CONFLICT(ip) DO UPDATE SET name=excluded.name, ts=excluded.ts');
const upsertSql = (t, k) => `INSERT INTO ${t} (ip, ${k}, iu, id, lu, ld) VALUES (?,?,?,?,?,?) ON CONFLICT(ip, ${k}) DO UPDATE SET iu=iu+excluded.iu, id=id+excluded.id, lu=lu+excluded.lu, ld=ld+excluded.ld`;
const stM = db.prepare(upsertSql('m', 'ts'));
const stH = db.prepare(upsertSql('h', 'ts'));
const stD = db.prepare(upsertSql('d', 'day'));
const stN = db.prepare('INSERT INTO names (ip,name,mac,vlan,seen) VALUES (?,?,?,?,?) ON CONFLICT(ip) DO UPDATE SET name=excluded.name, mac=excluded.mac, vlan=excluded.vlan, seen=excluded.seen');

const dbNames = new Map();
for (const r of db.prepare('SELECT ip,name,mac,vlan FROM names').all()) dbNames.set(r.ip, r);

// user-given names
const namesFile = path.join(CFG.dataDir, 'names.json');
let overrides = {};
try { overrides = JSON.parse(fs.readFileSync(namesFile, 'utf8')); } catch { /* none yet */ }

// staff: networks counted as staff by default (data\config.json can change them) + per-device overrides (data\staff.json)
const confFile = path.join(CFG.dataDir, 'config.json');
const DEFAULTS = {
  staffNetworks: [],      // router interface names counted as staff (set in the setup wizard / Configuration)
  guestNetworks: [],      // router interface names counted as guests
  abuse: { hours: { mode: 'schedule', week: { 0: { on: false, start: '08:00', end: '17:00' }, 1: { on: true, start: '08:00', end: '17:00' }, 2: { on: true, start: '08:00', end: '17:00' }, 3: { on: true, start: '08:00', end: '17:00' }, 4: { on: true, start: '08:00', end: '17:00' }, 5: { on: true, start: '08:00', end: '17:00' }, 6: { on: false, start: '08:00', end: '17:00' } } }, busyMB: 4, busyMinWarn: 120, staffDayGB: 2, guestDayGB: 6, uploadGB: 1, peerMult: 3, minPeerMB: 500, connWarn: 1500 },
  sec: { scanUnrep: 40, scanHosts: 25, lanHosts: 10, fanout: 60, bruteConns: 40, maxConns: 3000,
    ignore: [], adminIps: [],     // ignore = servers that scan on purpose; adminIps = admin PCs (never blocked or limited)
    protectedPublic: ['8.8.8.8', '8.8.4.4', '1.1.1.1', '1.0.0.1', '9.9.9.9', '208.67.222.222'] },      // internet addresses that may never be blocked (DNS in use)
};
let CONF = JSON.parse(JSON.stringify(DEFAULTS));
function loadConf() {
  let c = {}; try { c = JSON.parse(fs.readFileSync(confFile, 'utf8')); } catch { /* defaults */ }
  CONF = { staffNetworks: c.staffNetworks || DEFAULTS.staffNetworks, guestNetworks: c.guestNetworks || DEFAULTS.guestNetworks,
    abuse: Object.assign({}, DEFAULTS.abuse, c.abuse || {}), sec: Object.assign({}, DEFAULTS.sec, c.sec || {}) };
  staffNets = CONF.staffNetworks;
}
function saveConf(patch) {
  let c = {}; try { c = JSON.parse(fs.readFileSync(confFile, 'utf8')); } catch { /* new */ }
  for (const k of ['abuse', 'sec']) if (patch[k]) c[k] = Object.assign({}, c[k] || {}, patch[k]);
  for (const k of ['staffNetworks', 'guestNetworks']) if (patch[k]) c[k] = patch[k];
  fs.writeFileSync(confFile, JSON.stringify(c, null, 2)); loadConf();
}
let staffNets = DEFAULTS.staffNetworks;
loadConf();
const staffFile = path.join(CFG.dataDir, 'staff.json');
let staffOv = {};
try { staffOv = JSON.parse(fs.readFileSync(staffFile, 'utf8')); } catch { /* none yet */ }

// ---------------------------------------------------------------- router info (names, vlans)
const info = { arp: new Map(), lease: new Map(), statics: new Map(), nets: [], rdns: new Map(), rdnsTry: new Map() };
const resolver = new dns.Resolver({ timeout: 1500, tries: 1 });
if (CFG.dnsServer) resolver.setServers([CFG.dnsServer]);
const sysResolver = new dns.Resolver({ timeout: 1500, tries: 1 });
let rdnsBusy = 0;
function lookupRdns(ip) {
  const last = info.rdnsTry.get(ip) || 0;
  if (Date.now() - last < 3600e3 || rdnsBusy >= 4) return;
  info.rdnsTry.set(ip, Date.now()); rdnsBusy++;
  // Windows resolver first (finds AD/NetBIOS names), then the DC's reverse zone
  dns.lookupService(ip, 0, (err, host) => {
    if (!err && host && host !== ip) { rdnsBusy--; info.rdns.set(ip, host.split('.')[0]); return; }
    resolver.reverse(ip, (err2, names) => {
      rdnsBusy--;
      if (!err2 && names && names[0]) info.rdns.set(ip, names[0].split('.')[0]);
    });
  });
}
const wanRdns = new Map(); // remote internet host names (kept in table ptr)
for (const r of db.prepare('SELECT ip,name FROM ptr ORDER BY ts DESC LIMIT 20000').all()) wanRdns.set(r.ip, r.name);
let wanBusy = 0;
function lookupWan(ip) {
  if (wanRdns.has(ip) || wanRdns.size > 40000 || wanBusy >= 8) return;
  wanRdns.set(ip, ''); wanBusy++;
  sysResolver.reverse(ip, (err, names) => {
    wanBusy--;
    const nm = (!err && names && names[0]) ? names[0] : '';
    wanRdns.set(ip, nm);
    try { stPtr.run(ip, nm, now()); } catch { /* ignore */ }
  });
}

const { detectWan } = require('./routerinfo');
async function refreshInfo(api) {
  try {
    const arp = await api.run(['/ip/arp/print', '=.proplist=address,mac-address,interface']);
    info.arp = new Map(arp.filter((r) => r.address).map((r) => [r.address, r]));
    const ls = await api.run(['/ip/dhcp-server/lease/print', '=.proplist=address,mac-address,host-name,comment,dynamic,server']);
    info.lease = new Map(ls.filter((r) => r.address).map((r) => [r.address, r]));
    try { macsSeen(); } catch (e) { /* ignore */ }
    info.statics = new Map(ls.filter((r) => r.address && r.dynamic === 'false').map((r) => [r.address, r]));   // fixed-address inventory
    const ad = await api.run(['/ip/address/print', '=.proplist=address,network,interface,disabled']);
    info.routerIps = new Set(ad.filter((r) => r.address).map((r) => r.address.split('/')[0]));
    info.wanPeers = new Set(ad.map((r) => r.network).filter((n) => n && isIPv4(n) && !isPrivate(n)));          // the ISP side of the PPPoE link
    info.nets = ad.filter((r) => r.disabled !== 'true' && r.address).map((r) => {
      const [a, bits] = r.address.split('/'); const b = +bits;
      const mask = b === 0 ? 0 : (~0 << (32 - b)) >>> 0;
      return { base: (ip2n(a) & mask) >>> 0, mask, bits: b, iface: r.interface, addr: a };
    }).filter((n) => n.bits >= 8 && n.bits < 32);
  } catch (e) { /* keep old info */ }
  try {                                  // the router's own scan / brute-force traps (read-only)
    const lists = {};
    for (const name of ['port scanners', 'ssh_blacklist', 'telnet_blacklist', 'ftp_blacklist']) {
      const rows = await api.run(['/ip/firewall/address-list/print', '=.proplist=address,timeout,creation-time', '?list=' + name]);
      lists[name] = rows.map((r) => ({ address: r.address, timeout: r.timeout || '', created: r['creation-time'] || '' }));
    }
    S.routerLists = lists;
    await refreshBlocked();
    await refreshIpBlocked();
    const rr = await api.run(['/ip/firewall/raw/print', '=.proplist=comment,disabled,packets,bytes']);
    const mineRaw = rr.filter((r) => String(r.comment || '').startsWith('[mtc-ipblock]'));
    S.ipRule = mineRaw.length >= 2 && mineRaw.every((r) => r.disabled !== 'true'); S.ipDropped = mineRaw.reduce((s, r) => s + (Number(r.packets) || 0), 0);
    const fr = await api.run(['/ip/firewall/filter/print', '=.proplist=comment,disabled,action', '?chain=forward']);
    S.blockRule = fr.some((r) => String(r.comment || '').startsWith('[mtc-block]') && r.disabled !== 'true');
    S.fastTrack = fr.some((r) => r.action === 'fasttrack-connection' && r.disabled !== 'true');
    S.wan = (await detectWan(api)) || S.wan;
  } catch (e) { /* ignore */ }
}
function vlanOf(ip) {
  let best = null;
  const n = ip2n(ip);
  for (const x of info.nets) if (((n & x.mask) >>> 0) === x.base && (!best || x.bits > best.bits)) best = x;
  if (best) return best.iface;
  const a = info.arp.get(ip); if (a) return a.interface;
  if (ip.startsWith('192.168.45.')) return 'L2TP VPN';
  if (ip.startsWith('192.168.44.')) return 'WireGuard';
  return 'other';
}
function nameOf(ip) {
  if (overrides[ip]) return overrides[ip];
  const l = info.lease.get(ip);
  if (l) { const c = (l.comment || '').replace(/\s*\[[^\]]*\]\s*/g, ' ').trim(); if (l['host-name'] || c) return l['host-name'] || c; }
  if (info.rdns.has(ip)) return info.rdns.get(ip);
  const d = dbNames.get(ip); return d && d.name || '';
}
function macOf(ip) { const a = info.arp.get(ip); if (a && a['mac-address']) return a['mac-address']; const l = info.lease.get(ip); return l && l['mac-address'] || (dbNames.get(ip) || {}).mac || ''; }

// ---------------------------------------------------------------- collector state
const RING = 400; // 20 min at 3 s
const S = {
  ok: false, error: 'connecting...', lastPoll: 0, pollMs: 0, conns: 0, started: Date.now(),
  conn: new Map(),            // connection key -> {o, r}
  first: true,
  rate: new Map(),            // ip -> {iu,id,lu,ld, n} current B/s
  ring: new Map(),            // ip -> [[t,iu,id,lu,ld]...] (B/s)
  total: [],                  // same for all devices
  today: new Map(), todayDay: dayStr(new Date()),
  acc: new Map(),             // unflushed bytes per ip
  lastSeen: new Map(),
  flows: new Map(),           // ip -> [{remote, proto, port, up, down, inet}] from last poll
  routerLists: {}, blocked: new Map(), blockRule: false, lastRows: [],
  rmAcc: new Map(),           // 'ip|remote' -> [up, down, hits, port] since last flush
  peak: new Map(),            // ip -> [max conns, max rate B/s, max distinct remotes] since last flush
  cc: [], ccMin: { ts: 0, total: 0, inet: 0 },
  remoteNow: [], stats: new Map(), streak: new Map(), fired: new Map(), logCursor: '', logSummary: [],
};
function loadToday() {
  S.today = new Map();
  for (const r of db.prepare('SELECT ip,iu,id,lu,ld FROM d WHERE day=?').all(S.todayDay)) S.today.set(r.ip, [r.iu, r.id, r.lu, r.ld]);
}
loadToday();

function flushPresence() {
  if (!presDirty.size && !upAcc.size) return;
  const day = dayStr(new Date());
  db.exec('BEGIN');
  try {
    for (const ip of presDirty) { const p = pres.get(ip); if (p) { stPresUp.run(ip, p.mac || '', p.first || 0, p.last || 0, p.state, p.since || 0); p.savedAt = now(); } }
    for (const [ip, v] of upAcc) stUpt.run(day, ip, Math.round(v[0]), Math.round(v[1]));
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch { /* ignore */ } console.error('presence flush failed:', e.message); return; }
  presDirty.clear(); upAcc.clear();
}
function flush() {
  flushPresence();
  if (!S.acc.size && !S.rmAcc.size && !S.peak.size && !S.ccMin.ts) return;
  const t = now(), tm = t - (t % 60), th = t - (t % 3600), day = dayStr(new Date());
  db.exec('BEGIN');
  try {
    for (const [k, v] of S.rmAcc) { const i = k.indexOf('|'); stRM.run(day, k.slice(0, i), k.slice(i + 1), v[0], v[1], v[2], v[3]); }
    for (const [ip, v] of S.peak) stX.run(day, ip, v[0], Math.round(v[1]), v[2]);
    if (S.ccMin.ts) stCC.run(S.ccMin.ts, S.ccMin.total, S.ccMin.inet);
    for (const [ip, v] of S.acc) {
      stM.run(ip, tm, v[0], v[1], v[2], v[3]);
      stH.run(ip, th, v[0], v[1], v[2], v[3]);
      stD.run(ip, day, v[0], v[1], v[2], v[3]);
      const nm = nameOf(ip), mac = macOf(ip), vl = vlanOf(ip);
      stN.run(ip, nm, mac, vl, t);
      dbNames.set(ip, { ip, name: nm, mac, vlan: vl });
    }
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch { /* ignore */ } console.error('db flush failed:', e.message); return; }
  S.acc.clear(); S.rmAcc.clear(); S.peak.clear();
}
function prune() {
  const t = now();
  // per-minute detail 31 days; hourly (h) and daily (d) rows are kept forever
  db.prepare('DELETE FROM m WHERE ts<?').run(t - 31 * 86400);
  db.prepare('DELETE FROM cc WHERE ts<?').run(t - 31 * 86400);
  const d0 = new Date(); d0.setDate(d0.getDate() - 120);
  db.prepare('DELETE FROM rm WHERE day<?').run(dayStr(d0));   // per-destination detail: 120 days
  db.prepare('DELETE FROM sec WHERE ts<?').run(t - 400 * 86400);
}

// ---------------------------------------------------------------- polling
const PROPS = '.id,protocol,src-address,dst-address,reply-src-address,reply-dst-address,orig-bytes,repl-bytes,orig-fasttrack-bytes,repl-fasttrack-bytes,seen-reply';
const ROUTER_PORTS = new Set([21, 22, 23, 6870, 8291, 8728, 8729]);
let lastPollAt = 0;

function processConnections(rows) {
  const t = Date.now();
  const dt = lastPollAt ? Math.max(0.5, (t - lastPollAt) / 1000) : 0;
  lastPollAt = t;
  const per = new Map();            // ip -> [iu,id,lu,ld] bytes this poll
  const flows = new Map();
  const seen = new Set();
  const connCount = new Map();
  const iconn = new Map(), remSet = new Map(), secStats = new Map(), remNow = new Map();
  let totInet = 0;
  VPNL = new Map();
  for (const r of rows) {
    const proto = r.protocol;
    const src = r['src-address'], dst = r['dst-address'], rsrc = r['reply-src-address'];
    if (!src || !dst) continue;
    const sh = hostOf(src), dh = hostOf(dst);
    if (!isIPv4(sh) || !isIPv4(dh)) continue;
    const ob = (+r['orig-bytes'] || 0) + (+r['orig-fasttrack-bytes'] || 0);
    const rb = (+r['repl-bytes'] || 0) + (+r['repl-fasttrack-bytes'] || 0);
    const key = r['.id'] + '|' + src + '|' + dst;
    seen.add(key);
    const prev = S.conn.get(key);
    let dO, dR;
    if (!prev) { dO = S.first ? 0 : ob; dR = S.first ? 0 : rb; }
    else { dO = ob >= prev.o ? ob - prev.o : ob; dR = rb >= prev.r ? rb - prev.r : rb; }
    S.conn.set(key, prev ? (prev.o = ob, prev.r = rb, prev) : { o: ob, r: rb });
    // which end is the LAN device
    let dev, remote, up, down, rport, init = false;
    if (isPrivate(sh) && sh !== '0.0.0.0') { dev = sh; remote = dh; up = dO; down = dR; rport = portOf(dst); init = true; }
    else if (rsrc && isIPv4(hostOf(rsrc)) && isPrivate(hostOf(rsrc))) { dev = hostOf(rsrc); remote = sh; up = dR; down = dO; rport = portOf(rsrc); }
    else continue;
    if (dev === '0.0.0.0' || ip2n(dev) >= ip2n('224.0.0.0')) continue;
    const inet = !isPrivate(remote);
    connCount.set(dev, (connCount.get(dev) || 0) + 1);
    if (inet) {
      totInet++; iconn.set(dev, (iconn.get(dev) || 0) + 1);
      let rs = remSet.get(dev); if (!rs) remSet.set(dev, rs = new Set()); rs.add(remote);
      let rn = remNow.get(remote); if (!rn) remNow.set(remote, rn = { conns: 0, up: 0, down: 0, devs: new Set(), port: rport, proto });
      rn.conns++; rn.devs.add(dev); rn.up += up; rn.down += down;
      if (!S.first && (up || down)) {
        const k = dev + '|' + remote; let a = S.rmAcc.get(k); if (!a) S.rmAcc.set(k, a = [0, 0, 0, rport]);
        a[0] += up; a[1] += down; a[2]++; a[3] = rport;
      }
    }
    if (init) {                      // scan / intrusion statistics (connections the device started)
      let st = secStats.get(dev);
      if (!st) secStats.set(dev, st = { conns: 0, unrep: 0, udsts: new Set(), lanUnrep: new Set(), lan: new Set(), perDst: new Map(), unrepPorts: new Map(), routerHits: new Map() });
      st.conns++;
      const dport = portOf(dst), lanHost = isPrivate(dh) && ip2n(dh) < ip2n('224.0.0.0') && dh !== '0.0.0.0';
      if (r['seen-reply'] === 'false' && (proto === 'tcp' || proto === 'icmp')) {
        st.unrep++; st.udsts.add(dh); st.unrepPorts.set(dport, (st.unrepPorts.get(dport) || 0) + 1);
        if (lanHost) st.lanUnrep.add(dh);
      }
      if (lanHost) st.lan.add(dh);
      const pk = dh + ':' + dport; st.perDst.set(pk, (st.perDst.get(pk) || 0) + 1);
      if (info.routerIps && info.routerIps.has(dh) && ROUTER_PORTS.has(dport)) st.routerHits.set(dport, (st.routerHits.get(dport) || 0) + 1);
    }
    if (inet && (up || down) && !S.first) { const vk = vpnKind(proto, rport); if (vk) vpnNote(dev, vk, remote, rport, up, down); }
    if (up || down) {
      let v = per.get(dev); if (!v) per.set(dev, v = [0, 0, 0, 0]);
      if (inet) { v[0] += up; v[1] += down; } else { v[2] += up; v[3] += down; }
    }
    if (!S.first && (up || down)) {
      let l = flows.get(dev); if (!l) flows.set(dev, l = []);
      l.push({ remote, proto, port: rport, up: up / dt, down: down / dt, inet });
    }
  }
  for (const k of S.conn.keys()) if (!seen.has(k)) S.conn.delete(k);
  S.conns = rows.length;
  if (S.first) { S.first = false; return; }
  if (!dt) return;

  const tsec = Math.floor(t / 1000);
  // rollover of day
  const dnow = dayStr(new Date());
  if (dnow !== S.todayDay) { flush(); S.todayDay = dnow; loadToday(); }

  // current rates
  const newRate = new Map();
  const tot = [0, 0, 0, 0];
  for (const [ip, v] of per) {
    const rate = [v[0] / dt, v[1] / dt, v[2] / dt, v[3] / dt];
    newRate.set(ip, rate);
    for (let i = 0; i < 4; i++) tot[i] += rate[i];
    let a = S.acc.get(ip); if (!a) S.acc.set(ip, a = [0, 0, 0, 0]);
    let td = S.today.get(ip); if (!td) S.today.set(ip, td = [0, 0, 0, 0]);
    for (let i = 0; i < 4; i++) { a[i] += v[i]; td[i] += v[i]; }
    S.lastSeen.set(ip, tsec);
    if (!nameOf(ip) && isPrivate(ip)) lookupRdns(ip);
  }
  S.rate = newRate;
  S.flows = flows;
  S.conns_by = connCount; S.iconn = iconn; S.remsets = new Map([...remSet].map(([k, v]) => [k, v.size]));
  S.lastRows = rows; S.vpnLive = VPNL;
  // peaks (per device, per day) + concurrent-connection history
  for (const [ip, c] of connCount) {
    const r = newRate.get(ip) || [0, 0, 0, 0]; const rate = r[0] + r[1];
    let p = S.peak.get(ip); if (!p) S.peak.set(ip, p = [0, 0, 0]);
    p[0] = Math.max(p[0], c); p[1] = Math.max(p[1], rate); p[2] = Math.max(p[2], (remSet.get(ip) || { size: 0 }).size);
  }
  S.cc.push([tsec, rows.length, totInet]); if (S.cc.length > RING) S.cc.shift();
  const tmin = tsec - (tsec % 60);
  if (S.ccMin.ts !== tmin) { if (S.ccMin.ts) { try { stCC.run(S.ccMin.ts, S.ccMin.total, S.ccMin.inet); } catch { /* ignore */ } } S.ccMin = { ts: tmin, total: 0, inet: 0 }; }
  S.ccMin.total = Math.max(S.ccMin.total, rows.length); S.ccMin.inet = Math.max(S.ccMin.inet, totInet);
  // who is on the other side right now (by connections and by rate)
  S.remoteNow = [...remNow].map(([ip, v]) => ({ ip, conns: v.conns, devices: v.devs.size, up: v.up / dt, down: v.down / dt, port: v.port, proto: v.proto }))
    .sort((a, b) => (b.up + b.down) - (a.up + a.down) || b.conns - a.conns).slice(0, 300);
  for (const r of S.remoteNow.slice(0, 40)) lookupWan(r.ip);
  runSecurity(secStats, tsec);
  // rings: every device with a ring gets a sample each poll (zero when idle)
  for (const ip of newRate.keys()) if (!S.ring.has(ip)) S.ring.set(ip, []);
  for (const [ip, ring] of S.ring) {
    const r = newRate.get(ip) || [0, 0, 0, 0];
    ring.push([tsec, r[0], r[1], r[2], r[3]]);
    if (ring.length > RING) ring.shift();
    if (tsec - (S.lastSeen.get(ip) || 0) > 1800) S.ring.delete(ip);
  }
  S.total.push([tsec, tot[0], tot[1], tot[2], tot[3]]);
  if (S.total.length > RING) S.total.shift();
}

async function main() {
  const cred = readCreds();
  let api = null;
  let lastInfo = 0, lastFlush = Date.now(), lastPrune = 0, lastLog = 0, lastBlk = 0, lastPres = 0, lastHs = 0;
  const loop = async () => {
    const t0 = Date.now();
    try {
      if (!api) {
        api = new RosApi(CFG.router, CFG.apiPort, cred.user, cred.pw);
        await api.connect();
        apiConn = api;
        lastInfo = 0; lastLog = 0; S.first = true; S.conn.clear(); lastPollAt = 0;
      }
      if (Date.now() - lastInfo > 60000) { await refreshInfo(api); lastInfo = Date.now(); }
      if (Date.now() - lastBlk > 15000) { lastBlk = Date.now(); try { await refreshBlocked(); await refreshIpBlocked(); } catch { /* ignore */ } }
      if (Date.now() - lastLog > 120000) { lastLog = Date.now(); try { await parseLog(api); } catch { /* ignore */ } }
      const rows = await api.run(['/ip/firewall/connection/print', '=.proplist=' + PROPS]);
      processConnections(rows);
      if (Date.now() - lastPres > 15000) { lastPres = Date.now(); try { await presenceTick(api); } catch (e) { console.error('presence:', e.message); } try { await qosTick(); } catch (e) { console.error('qos:', e.message); } try { if (Date.now() - lastHs > 60000) { lastHs = Date.now(); await hsTick(); } } catch (e) { console.error('hotspot:', e.message); } }
      S.ok = true; S.error = ''; S.lastPoll = Date.now(); S.pollMs = Date.now() - t0;
    } catch (e) {
      S.ok = false; S.error = String(e.message || e).replace(/password=\S+/gi, '');
      if (api) { api.close(); api = null; apiConn = null; }
    }
    if (Date.now() - lastFlush > 10000) { flush(); lastFlush = Date.now(); }
    if (Date.now() - lastPrune > 3600e3) { try { prune(); } catch { /* ignore */ } lastPrune = Date.now(); }
    setTimeout(loop, Math.max(S.ok ? 200 : 5000, CFG.pollMs - (Date.now() - t0)));
  };
  loop();
}

// ---------------------------------------------------------------- presence: online / offline tracking
db.exec(`
CREATE TABLE IF NOT EXISTS pres (ip TEXT PRIMARY KEY, mac TEXT, first INTEGER, last INTEGER, state TEXT, since INTEGER);
CREATE TABLE IF NOT EXISTS pe (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, ip TEXT, kind TEXT, gap INTEGER);
CREATE INDEX IF NOT EXISTS pe_ip ON pe(ip, ts);
CREATE INDEX IF NOT EXISTS pe_ts ON pe(ts);
CREATE TABLE IF NOT EXISTS upt (day TEXT, ip TEXT, on_s INTEGER, tot_s INTEGER, PRIMARY KEY (day, ip)) WITHOUT ROWID;
`);
const stPresUp = db.prepare('INSERT INTO pres (ip,mac,first,last,state,since) VALUES (?,?,?,?,?,?) ON CONFLICT(ip) DO UPDATE SET mac=excluded.mac, first=excluded.first, last=excluded.last, state=excluded.state, since=excluded.since');
const stPe = db.prepare('INSERT INTO pe (ts,ip,kind,gap) VALUES (?,?,?,?)');
const stUpt = db.prepare('INSERT INTO upt (day,ip,on_s,tot_s) VALUES (?,?,?,?) ON CONFLICT(day,ip) DO UPDATE SET on_s=on_s+excluded.on_s, tot_s=tot_s+excluded.tot_s');
const pres = new Map();                  // ip -> {ip, mac, first, last, state: online|offline|unknown, since, misses, lastProbe, group, watch}
for (const r of db.prepare('SELECT ip,mac,first,last,state,since FROM pres').all()) pres.set(r.ip, Object.assign({ misses: 0, lastProbe: 0, savedAt: 0, group: '', watch: false }, r));
const presDirty = new Set(), upAcc = new Map();
const watchFile = path.join(CFG.dataDir, 'watch.json');
let watchOv = {}; try { watchOv = JSON.parse(fs.readFileSync(watchFile, 'utf8')); } catch { /* none yet */ }
const WATCH_GROUPS = new Set(['Staff', 'AP', 'IoT controller', 'Server', 'CCTV', 'Door lock', 'VoIP phone']);   // watched by default
function groupOf(ip) {
  const l = info.lease.get(ip) || {}, v = info.nets.length ? vlanOf(ip) : ((dbNames.get(ip) || {}).vlan || '');
  if (/(access point|wifi ap|wap)/i.test(l.comment || '') || /^ap[-_ ]?w*$/i.test(l['host-name'] || '')) return 'AP';   // name or comment says access point
  if (/IoT|controller|BMS/i.test(v)) return 'IoT controller';
  if (/IPTV/i.test(v)) return 'IPTV box';
  if (/CCTV/i.test(v)) return 'CCTV';
  if (/Door/i.test(v)) return 'Door lock';
  if (/VOIP/i.test(v)) return 'VoIP phone';
  if (isStaff(ip, v)) return 'Staff';
  if (isGuestNet(v)) return 'Guest';
  if (/Server/i.test(v)) return 'Server';
  return 'Other';
}
function goOffline(p, ip) {
  const at = p.last || now();
  try { stPe.run(at, ip, 'down', Math.max(0, at - (p.since || at))); } catch { /* ignore */ }
  p.state = 'offline'; p.since = at; p.misses = 0; presDirty.add(ip);
}
function goOnline(p, ip, tsec) {
  if (p.state === 'offline' && p.first) { try { stPe.run(tsec, ip, 'up', Math.max(0, tsec - (p.since || tsec))); } catch { /* ignore */ } }
  if (!p.first) p.first = tsec;
  p.state = 'online'; p.since = tsec; p.misses = 0; presDirty.add(ip);
}
async function presenceTick(api) {
  const tsec = now(), dt = S.presAt ? Math.min(60, tsec - S.presAt) : 0; S.presAt = tsec;
  const arp = await api.run(['/ip/arp/print', '=.proplist=address,status,disabled']);
  const st = new Map(); for (const r of arp) if (r.address && r.disabled !== 'true') st.set(r.address, r.status);
  const active = new Set(); for (const [ip, v] of S.rate) if (v[0] + v[1] + v[2] + v[3] > 0) active.add(ip);
  const universe = new Set([...pres.keys(), ...st.keys(), ...info.statics.keys()]);
  const queue = [];
  for (const ip of universe) {
    if (!isIPv4(ip) || !isPrivate(ip) || (info.routerIps && info.routerIps.has(ip))) continue;
    const s = st.get(ip), up = active.has(ip) || s === 'reachable' || s === 'delay' || s === 'probe', down = s === 'failed' || s === 'incomplete';
    let p = pres.get(ip);
    if (!p) {
      if (!up && !info.statics.has(ip)) continue;                       // an unknown stale ARP entry: ignore
      p = { ip, mac: macOf(ip) || '', first: 0, last: 0, state: up ? 'online' : (down ? 'offline' : 'unknown'), since: tsec, misses: 0, lastProbe: 0, savedAt: 0, group: '', watch: false };
      if (up) { p.first = tsec; p.last = tsec; }
      pres.set(ip, p); presDirty.add(ip);
    }
    p.group = groupOf(ip);
    p.watch = watchOv[ip] !== undefined ? !!watchOv[ip] : WATCH_GROUPS.has(p.group);
    const guest = p.group === 'Guest';
    if (up) {
      p.last = tsec; p.misses = 0;
      if (p.state !== 'online') goOnline(p, ip, tsec); else if (tsec - p.savedAt > 120) presDirty.add(ip);
    } else if (down) {
      if (p.state === 'online' && tsec - p.last >= 60) goOffline(p, ip);
      else if (p.state === 'unknown') { p.state = 'offline'; p.since = tsec; presDirty.add(ip); }
    } else if (p.state === 'online' && tsec - p.last > (guest ? 1800 : 360)) {
      if (guest) goOffline(p, ip); else queue.push([p, p.watch ? 0 : 1]);
    } else if (p.state === 'unknown') {
      if (guest) pres.delete(ip); else queue.push([p, 2]);              // verify devices of the inventory that we have not seen yet
    }
    if (!guest && dt > 0 && p.state !== 'unknown') { let a = upAcc.get(ip); if (!a) upAcc.set(ip, a = [0, 0]); if (p.state === 'online') a[0] += dt; a[1] += dt; }
  }
  // ask the router to ping a few silent devices (a ping also refreshes ARP, so a PC that blocks ICMP still counts as alive)
  queue.sort((a, b) => a[1] - b[1] || a[0].lastProbe - b[0].lastProbe);
  for (const [p] of queue.filter(([x]) => tsec - x.lastProbe >= 45).slice(0, 3)) {
    p.lastProbe = tsec; let ok = false;
    try { const r = await api.run(['/ping', '=address=' + p.ip, '=count=1']); ok = r.some((x) => Number(x.received) > 0); } catch { /* ignore */ }
    if (!ok) { try { const a = await api.run(['/ip/arp/print', '=.proplist=status', '?address=' + p.ip]); const s2 = a[0] && a[0].status; ok = s2 === 'reachable' || s2 === 'delay' || s2 === 'probe'; } catch { /* ignore */ } }
    if (ok) { p.last = now(); p.misses = 0; if (p.state !== 'online') goOnline(p, p.ip, now()); }
    else { p.misses++; if (p.state === 'unknown') { p.state = 'offline'; p.since = now(); presDirty.add(p.ip); } else if (p.misses >= 2) goOffline(p, p.ip); }
  }
}
function presenceReport() {
  const t = now(), d0 = new Date(); d0.setDate(d0.getDate() - 6);
  const out7 = new Map(db.prepare("SELECT ip, COUNT(*) n FROM pe WHERE kind='down' AND ts>=? GROUP BY ip").all(t - 7 * 86400).map((r) => [r.ip, r.n]));
  const upt = new Map(db.prepare('SELECT ip, SUM(on_s) o, SUM(tot_s) t FROM upt WHERE day>=? GROUP BY ip').all(dayStr(d0)).map((r) => [r.ip, r]));
  const rows = [];
  for (const p of pres.values()) {
    const d = devInfo(p.ip, {}), u = upt.get(p.ip);
    rows.push({ ip: p.ip, name: d.name, mac: p.mac || d.mac, vlan: d.vlan, group: p.group || groupOf(p.ip), state: p.state, last: p.last, since: p.since, first: p.first,
      watch: p.watch, outages7: out7.get(p.ip) || 0, uptime7: u && u.t > 600 ? Math.min(100, u.o / u.t * 100) : null });
  }
  return { now: t, rows };
}
function presenceHistory(q) {
  const ip = q.get('ip'); if (!isIPv4(ip || '')) return [];
  return db.prepare('SELECT ts, kind, gap FROM pe WHERE ip=? ORDER BY ts DESC LIMIT 60').all(ip);
}
function offlineCounts() { let w = 0; for (const p of pres.values()) if (p.state === 'offline' && p.watch && p.first) w++; return w; }

// ---------------------------------------------------------------- bandwidth control (MikroTik simple queues, internet only)
db.exec(`CREATE TABLE IF NOT EXISTS qev (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, ip TEXT, action TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS aud (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, action TEXT, ip TEXT, name TEXT, mac TEXT, grp TEXT, detail TEXT, actor TEXT);
CREATE INDEX IF NOT EXISTS aud_ts ON aud(ts);`);
const stQev = db.prepare('INSERT INTO qev (ts,ip,action,detail) VALUES (?,?,?,?)');
const stAud = db.prepare('INSERT INTO aud (ts,action,ip,name,mac,grp,detail,actor) VALUES (?,?,?,?,?,?,?,?)');
// audit trail of every block / unblock / speed limit (and changes made directly on the router), kept forever
function audit(action, ip, detail, actor) {
  try { stAud.run(now(), action, ip || '', ip ? (nameOf(ip) || '') : '', ip ? (macOf(ip) || '') : '', ip ? groupOf(ip) : '', String(detail || '').slice(0, 300), actor || 'dashboard'); } catch { /* ignore */ }
}
const qevLog = (ip, action, detail) => {
  try { stQev.run(now(), ip || '', action, String(detail).slice(0, 300)); } catch { /* ignore */ }
  audit('qos-' + action, ip, detail, action === 'auto-limit' ? 'auto-throttle' : action === 'quota-limit' ? 'usage quota' : 'dashboard');
};
const qosFile = path.join(CFG.dataDir, 'qos.json');
let QOS; try { QOS = qos.normalize(JSON.parse(fs.readFileSync(qosFile, 'utf8'))); } catch { QOS = qos.normalize({}); }
const saveQos = () => fs.writeFileSync(qosFile, JSON.stringify(QOS, null, 2));
S.qosState = { types: [], queues: [], applied: false, at: 0 };
const qosWan = () => QOS.wan || S.wan || '';
async function qosActual() {
  const types = (await apiConn.run(['/queue/type/print', '=.proplist=.id,name,kind,pcq-rate,pcq-classifier'])).filter((t) => String(t.name).startsWith('mtc-'));
  const queues = (await apiConn.run(['/queue/simple/print', '=.proplist=.id,name,target,dst,max-limit,queue,disabled,comment,rate,bytes'])).filter((q) => String(q.name).startsWith('mtc-'));
  S.qosState = { types, queues, applied: queues.some((q) => q.name.startsWith('mtc-group-')), at: now() };
  return { types, queues };
}
async function qosPlan() {
  if (!apiConn) throw new Error('Router is not connected');
  const wan = qosWan(); if (!wan) throw new Error('Internet (WAN) interface not found: set it in the configuration');
  const plan = qos.plan(qos.desired(QOS, wan, now()), await qosActual());
  if (S.fastTrack) plan.warnings.push('A FastTrack rule is enabled on the router: fast-tracked traffic BYPASSES queues, so limits would not work. Disable FastTrack first.');
  if (!QOS.enabled) plan.warnings.push('The master switch is OFF: all QoS queues will exist but stay disabled (nobody is limited).');
  return plan;
}
async function qosRun(ops) {
  let firstGroup = null;
  for (const op of ops) {
    const words = op.words.slice();
    if (op.place === 'first-group') {
      if (!firstGroup) { const a = await qosActual(); const g = a.queues.find((q) => q.name.startsWith('mtc-group-')); firstGroup = g ? g['.id'] : null; }
      if (firstGroup) words.push('=place-before=' + firstGroup);
    }
    await apiConn.run(words);
  }
  await qosActual();
}
async function qosApply(backup) {
  const plan = await qosPlan();
  if (S.fastTrack && QOS.enabled) throw new Error('FastTrack is enabled on the router: queues would be bypassed. Disable it first.');
  if (backup) { try { await apiConn.run(['/export', '=file=before-qos-' + new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')]); } catch (e) { throw new Error('Could not save a router backup first: ' + e.message); } }
  await qosRun(plan.ops); qevLog('', 'apply', `${plan.ops.length} changes, master ${QOS.enabled ? 'ON' : 'off'}`);
  return { ops: plan.ops.length };
}
async function qosOff() {          // kill switch: disable every [mtc-qos] queue right now
  QOS.enabled = false; saveQos();
  await qosApply(false); qevLog('', 'off', 'master switch turned off, all limits disabled');
}
async function qosRemoveAll() {    // rollback: delete every [mtc-qos] object from the router
  QOS.enabled = false; saveQos();
  const a = await qosActual();
  for (const q of a.queues) await apiConn.run(['/queue/simple/remove', '=numbers=' + q['.id']]);
  for (const t of a.types) await apiConn.run(['/queue/type/remove', '=numbers=' + t['.id']]);
  await qosActual(); qevLog('', 'remove', `removed ${a.queues.length} queues and ${a.types.length} queue types`);
}
async function qosDeviceOps(ip) {
  const plan = await qosPlan(), name = 'mtc-dev-' + ip;
  return plan.ops.filter((o) => o.words.some((w) => w === '=name=' + name) || o.text.includes(name));
}
async function qosSetDevice(ip, spec) {
  if (!apiConn) throw new Error('Router is not connected');
  if (!isIPv4(ip) || !isPrivate(ip)) throw new Error('Only LAN addresses can be limited');
  if (protectedIps().has(ip)) throw new Error('This address is protected (admin PC / router address)');
  await qosActual();
  if (!S.qosState.applied) throw new Error('Bandwidth control is not on the router yet: open Configuration > Bandwidth control and Apply first');
  if (!QOS.enabled) throw new Error('The bandwidth-control master switch is OFF: turn it on in Configuration first');
  const mins = Math.max(0, Math.min(60 * 24 * 30, Number(spec.minutes) || 0)), until = mins ? now() + mins * 60 : 0;
  const next = qos.normalize(Object.assign({}, QOS, { devices: Object.assign({}, QOS.devices, { [ip]: { profile: spec.profile || '', custom: spec.custom || null, note: spec.note || nameOf(ip) || '', until, source: spec.source || 'manual' } }) }));
  QOS = next; saveQos();
  const ops = await qosDeviceOps(ip); await qosRun(ops);
  qevLog(ip, spec.source === 'auto' ? 'auto-limit' : spec.source === 'quota' ? 'quota-limit' : 'limit', `${spec.custom ? spec.custom.down + '/' + spec.custom.up : spec.profile}${until ? ' until ' + new Date(until * 1000).toLocaleString() : ''} ${spec.note || ''}`);
  return { ok: true };
}
async function qosClearDevice(ip, why) {
  if (!apiConn) throw new Error('Router is not connected');
  delete QOS.devices[ip]; saveQos();
  const ops = await qosDeviceOps(ip); await qosRun(ops); qevLog(ip, 'unlimit', why || 'removed');
}
// ---- usage quota: too much internet download/upload in the period -> temporary speed limit (default 24 h)
// Triggered devices are remembered by day in quota-state.json: after a limit the usage is counted again only from the NEXT day,
// so a rolling multi-day period cannot re-limit the same device over and over for the same traffic (and an admin who lifts a limit
// by hand is not overruled on the same day).
const quotaFile = path.join(CFG.dataDir, 'quota-state.json');
let QSTATE; try { QSTATE = JSON.parse(fs.readFileSync(quotaFile, 'utf8')); } catch { QSTATE = {}; }
const saveQState = () => { try { fs.writeFileSync(quotaFile, JSON.stringify(QSTATE)); } catch { /* ignore */ } };
const quotaFrom = (days) => dayStr(new Date(Date.now() - (days - 1) * 86400000));
const nextDay = (ds) => { const [y, m, d] = ds.split('-').map(Number); return dayStr(new Date(y, m - 1, d + 1)); };
let quotaPrev = { at: 0, key: '', map: new Map() };
function quotaUsage(ip, Q) {          // [uploadBytes, downloadBytes] of INTERNET traffic in the period (stored days before today + live today)
  let from = quotaFrom(Q.days); const last = QSTATE[ip]; if (last && nextDay(last) > from) from = nextDay(last);
  let up = 0, down = 0;
  if (Q.days > 1 && from < S.todayDay) {
    if (from === quotaFrom(Q.days)) {   // common case: one grouped query for everybody, cached 2 minutes
      const key = from + '|' + S.todayDay;
      if (quotaPrev.key !== key || Date.now() - quotaPrev.at > 120000) quotaPrev = { at: Date.now(), key, map: new Map(db.prepare('SELECT ip, SUM(iu) u, SUM(id) d FROM d WHERE day>=? AND day<? GROUP BY ip').all(from, S.todayDay).map((r) => [r.ip, [r.u || 0, r.d || 0]])) };
      const p = quotaPrev.map.get(ip); if (p) { up += p[0]; down += p[1]; }
    } else { const r = db.prepare('SELECT SUM(iu) u, SUM(id) d FROM d WHERE ip=? AND day>=? AND day<?').get(ip, from, S.todayDay); up += (r && r.u) || 0; down += (r && r.d) || 0; }
  }
  if (from <= S.todayDay) { const td = S.today.get(ip); if (td) { up += td[0]; down += td[1]; } }
  return [up, down];
}
function quotaWhy(Q, up, down) {
  const GB = 1e9, f = (b) => (b / GB).toFixed(1) + ' GB', per = Q.days === 1 ? 'today' : 'in ' + Q.days + ' days';
  if (Q.downGB && down >= Q.downGB * GB) return `downloaded ${f(down)} ${per} (limit ${Q.downGB} GB)`;
  if (Q.upGB && up >= Q.upGB * GB) return `uploaded ${f(up)} ${per} (limit ${Q.upGB} GB)`;
  if (Q.totalGB && up + down >= Q.totalGB * GB) return `used ${f(up + down)} ${per} (limit ${Q.totalGB} GB)`;
  return '';
}
const quotaSkip = (ip, Q, prot, ign) => !!QOS.devices[ip] || !!qos.profileOfUserIp(QOS, ip) || prot.has(ip) || ign.has(ip) || Q.exempt.includes(ip) || !Q.groups.includes(groupOf(ip));
S.quotaFail = new Map();
async function quotaTick(tsec) {
  const Q = QOS.quota; if (!QOS.enabled || !Q.enabled) return;
  const prot = protectedIps(), ign = new Set(CONF.sec.ignore); let acted = 0;
  for (const ip of [...S.today.keys()]) {
    if (acted >= 5) break;
    if (!isIPv4(ip) || !isPrivate(ip) || quotaSkip(ip, Q, prot, ign) || tsec - (S.quotaFail.get(ip) || 0) < 300) continue;
    const [up, down] = quotaUsage(ip, Q), why = quotaWhy(Q, up, down); if (!why) continue;
    acted++;
    try { await qosSetDevice(ip, { profile: Q.profile, minutes: Q.forMinutes, source: 'quota', note: 'quota: ' + why }); QSTATE[ip] = S.todayDay; saveQState(); }
    catch (e) { S.quotaFail.set(ip, tsec); console.error('usage quota:', e.message); }
  }
}
function quotaReport() {            // devices closest to / over the quota, for the configuration page
  const Q = QOS.quota, prot = protectedIps(), ign = new Set(CONF.sec.ignore), rows = [];
  for (const ip of S.today.keys()) {
    if (!isIPv4(ip) || !isPrivate(ip) || !Q.groups.includes(groupOf(ip))) continue;
    const [up, down] = quotaUsage(ip, Q); if (up + down < 1e8) continue;
    const pct = Math.max(Q.downGB ? down / (Q.downGB * 1e9) : 0, Q.upGB ? up / (Q.upGB * 1e9) : 0, Q.totalGB ? (up + down) / (Q.totalGB * 1e9) : 0);
    const dev = QOS.devices[ip];
    rows.push({ ip, name: nameOf(ip) || '', group: groupOf(ip), up, down, pct, limited: !!dev, quotaLimited: !!dev && dev.source === 'quota', until: dev ? dev.until : 0, exempt: quotaSkip(ip, Q, prot, ign) && !dev });
  }
  return rows.sort((a, b) => b.pct - a.pct).slice(0, 25);
}
async function qosTick() {
  const tsec = now();
  await qosActual();
  if (!S.qosState.applied) return;
  for (const [ip, d] of Object.entries(QOS.devices)) if (d.until && d.until <= tsec) { try { await qosClearDevice(ip, 'expired'); } catch (e) { console.error('qos expire:', e.message); } }
  try { await quotaTick(tsec); } catch (e) { console.error('usage quota:', e.message); }
  const a = QOS.auto; if (!QOS.enabled || !a.enabled) return;
  const n = Math.min(RING - 5, a.minutes * 20); let acted = 0;
  for (const [ip, ring] of S.ring) {
    if (acted >= 3) break;
    if (ring.length < n * 0.9 || QOS.devices[ip] || qos.profileOfUserIp(QOS, ip) || protectedIps().has(ip) || new Set(CONF.sec.ignore).has(ip)) continue;
    if (!a.groups.includes(groupOf(ip))) continue;
    const win = ring.slice(-n), avg = win.reduce((s, x) => s + x[2], 0) / win.length * 8 / 1e6;
    if (avg >= a.downMbps) { acted++; try { await qosSetDevice(ip, { profile: a.profile, minutes: a.forMinutes, source: 'auto', note: `auto: avg ${avg.toFixed(1)} Mbps for ${a.minutes} min` }); } catch (e) { console.error('auto-throttle:', e.message); } }
  }
}
const qosLimitOf = (ip) => { const q = (S.qosState.queues || []).find((x) => x.name === 'mtc-dev-' + ip); if (!q || q.disabled === 'true') return null; const [u, d] = String(q['max-limit'] || '0/0').split('/'); const dv = QOS.devices[ip] || {}; return { down: qos.fmtRate(Number(d) || 0), up: qos.fmtRate(Number(u) || 0), rate: q.rate || '', source: dv.source || '', until: dv.until || 0 }; };
// Default bandwidth groups from the networks chosen as staff / guest (only while no group exists yet; edit them afterwards in Configuration)
const cidrOf = (n) => [n.base >>> 24, (n.base >> 16) & 255, (n.base >> 8) & 255, n.base & 255].join('.') + '/' + n.bits;
function ensureQosGroups() {
  if (QOS.groups.length || !info.nets.length) return;
  const mk = (id, name, ifaces, profile) => { const targets = [...new Set(info.nets.filter((n) => ifaces.includes(n.iface)).map(cidrOf))]; return targets.length ? { id, name, targets, profile, enabled: true } : null; };
  const groups = [mk('staff', 'Staff', CONF.staffNetworks, 'staff-default'), mk('guest', 'Guests', CONF.guestNetworks, 'guest-default')].filter(Boolean);
  if (!groups.length) return;
  try { QOS = qos.normalize(Object.assign({}, QOS, { groups })); saveQos(); } catch (e) { console.error('default groups:', e.message); }
}
function qosReport() {
  ensureQosGroups();
  return { config: QOS, wan: qosWan(), applied: S.qosState.applied, fastTrack: !!S.fastTrack, at: S.qosState.at,
    queues: S.qosState.queues.map((q) => ({ name: q.name, target: q.target, max: q['max-limit'], disabled: q.disabled === 'true', rate: q.rate || '', bytes: q.bytes || '', comment: q.comment || '' })),
    recent: db.prepare('SELECT ts, ip, action, detail FROM qev ORDER BY id DESC LIMIT 40').all().map((r) => Object.assign(r, { name: r.ip ? nameOf(r.ip) : '' })),
    groups: [...new Set(['Staff', 'Guest', 'Other', 'AP', 'Server', 'VoIP phone'])], quota: quotaReport() };
}

// ---------------------------------------------------------------- router base setup (block rules, FastTrack, optional guest network)
const setup = require('./setup');
const setupFile = path.join(CFG.dataDir, 'setup.json'), setupStateFile = path.join(CFG.dataDir, 'setup-state.json');
let SU; try { SU = setup.normalize(JSON.parse(fs.readFileSync(setupFile, 'utf8'))); } catch { SU = setup.normalize({}); }
let SUSTATE; try { SUSTATE = JSON.parse(fs.readFileSync(setupStateFile, 'utf8')); } catch { SUSTATE = { ftDisabled: [] }; }
const saveSU = () => fs.writeFileSync(setupFile, JSON.stringify(SU, null, 2));
const saveSUState = () => fs.writeFileSync(setupStateFile, JSON.stringify(SUSTATE));
const setupWan = () => SU.wan || S.wan || '';
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
async function setupPlan() {
  if (!apiConn) throw new Error('Router is not connected');
  const des = setup.desired(SU, setupWan()), act = await setup.readActual((w) => apiConn.run(w), des);
  return Object.assign({ des, act }, setup.plan(SU, des, act), { status: setup.status(des, act) });
}
async function setupReport() {
  const out = { config: SU, wan: setupWan(), connected: !!apiConn, fastTrack: !!S.fastTrack };
  if (!apiConn) return out;
  try {
    const p = await setupPlan(); out.status = p.status; out.ops = p.ops.map((o) => o.text); out.warnings = p.warnings; out.rsc = setup.toRsc(p.ops, 'Mikrotik Traffic Control - router base setup');
    const ifs = await apiConn.run(['/interface/print', '=.proplist=name,type,running,disabled,comment']);
    const addr = new Set((await apiConn.run(['/ip/address/print', '=.proplist=interface'])).map((r) => r.interface));
    out.interfaces = ifs.filter((i) => i.disabled !== 'true').map((i) => ({ name: i.name, type: i.type, running: i.running === 'true', hasAddress: addr.has(i.name), comment: i.comment || '' }));
  } catch (e) { out.error = e.message; }
  return out;
}
async function setupApply() {
  const p = await setupPlan(); if (!p.ops.length) return { ops: 0 };
  try { await apiConn.run(['/export', '=file=mtc-before-setup-' + stamp()]); } catch (e) { throw new Error('Could not save a router backup first: ' + e.message); }
  for (const op of p.ops) {
    const words = op.words.slice();
    if (op.place === 'top-forward') { const r = await apiConn.run(['/ip/firewall/filter/print', '=.proplist=.id', '?chain=forward']); if (r[0]) words.push('=place-before=' + r[0]['.id']); }
    if (op.place === 'top-input') { const r = await apiConn.run(['/ip/firewall/filter/print', '=.proplist=.id', '?chain=input']); if (r[0]) words.push('=place-before=' + r[0]['.id']); }
    if (op.place === 'top-raw') { const r = await apiConn.run(['/ip/firewall/raw/print', '=.proplist=.id', '?chain=prerouting']); if (r[0]) words.push('=place-before=' + r[0]['.id']); }
    await apiConn.run(words);
    if (op.where === 'fasttrack') { SUSTATE.ftDisabled = [...new Set([...(SUSTATE.ftDisabled || []), op.ftId])]; saveSUState(); }
  }
  audit('setup-apply', '', p.ops.length + ' router change(s): ' + p.ops.map((o) => o.text.slice(2, 60)).join('; ').slice(0, 250), 'dashboard');
  await refreshInfo(apiConn); return { ops: p.ops.length };
}
async function setupRemove() {
  const act = await setup.readActual((w) => apiConn.run(w), setup.ALL), ops = setup.rollbackOps(act, SUSTATE.ftDisabled);
  try { await apiConn.run(['/export', '=file=mtc-before-remove-' + stamp()]); } catch (e) { throw new Error('Could not save a router backup first: ' + e.message); }
  for (const op of ops) { try { await apiConn.run(op.words); } catch (e) { console.error('setup remove:', e.message); } }
  SUSTATE.ftDisabled = []; saveSUState();
  audit('setup-remove', '', ops.length + ' setup object(s) removed from the router', 'dashboard'); await refreshInfo(apiConn); return { ops: ops.length };
}

// ---------------------------------------------------------------- guest hotspot preparation (captive portal on the guest WiFi VLAN)
const hotspot = require('./hotspot');
const hsFile = path.join(CFG.dataDir, 'hotspot.json');
let HS; try { HS = hotspot.normalize(JSON.parse(fs.readFileSync(hsFile, 'utf8'))); } catch { HS = hotspot.normalize({}); }
const saveHs = () => fs.writeFileSync(hsFile, JSON.stringify(HS, null, 2));
S.hs = { actual: null, at: 0, portalOk: null, portalAt: 0 };
const upMac = (m) => String(m || '').toUpperCase();
async function hsActual() {
  const run = (w) => apiConn.run(w);
  const servers = await run(['/ip/hotspot/print', '=.proplist=.id,name,interface,profile,disabled,address-pool']);
  const profiles = await run(['/ip/hotspot/profile/print', '=.proplist=.id,name,hotspot-address,login-by,html-directory,http-cookie-lifetime,use-radius']);
  const userProfiles = await run(['/ip/hotspot/user/profile/print', '=.proplist=.id,name,rate-limit,shared-users']);
  const wh = (await run(['/ip/hotspot/walled-garden/print', '=.proplist=.id,dst-host,action,comment'])).map((e) => Object.assign(e, { kind: 'host' }));
  const wi = (await run(['/ip/hotspot/walled-garden/ip/print', '=.proplist=.id,dst-address,dst-port,protocol,action,comment'])).map((e) => Object.assign(e, { kind: 'ip' }));
  const bindings = await run(['/ip/hotspot/ip-binding/print', '=.proplist=.id,mac-address,address,type,comment,server']);
  const files = new Set((await run(['/file/print', '=.proplist=name,type,size'])).map((f) => f.name));
  const server = servers.find((s) => s.name === HS.server) || null;
  S.hs.actual = { server, profiles, userProfiles, walled: wh.concat(wi).filter((e) => e['dst-host'] || e['dst-address']), bindings, files, at: now() };
  return S.hs.actual;
}
function hsFacts(a) {
  const apMacs = new Set(HS.bypass.map((b) => upMac(b.mac)).filter(Boolean)), t = now();
  const iface = a.server ? a.server.interface : HS.iface;
  const guestClients = [...S.lastSeen].filter(([ip, ts]) => t - ts < 300 && isGuestNet(vlanOf(ip))).length;
  const mine = (a.bindings || []).filter((b) => b.type === 'bypassed');
  const qosGuest = !!(QOS.enabled && QOS.groups.some((g) => g.enabled && g.id === 'guest'));
  return { isProd: true, iface, apMacs, boundMacs: new Set(mine.map((b) => upMac(b['mac-address'])).filter(Boolean)), boundIps: new Set(mine.map((b) => b.address).filter(Boolean)), files: a.files, guestClients, qosGuest, portalOk: S.hs.portalOk };
}
async function hsPortalProbe() {
  if (!HS.portalUrl) { S.hs.portalOk = null; return; }
  if (Date.now() - S.hs.portalAt < 60000) return; S.hs.portalAt = Date.now();
  try { const u = new URL(HS.portalUrl); await new Promise((res, rej) => { const r = require(u.protocol === 'https:' ? 'https' : 'http').get({ host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: '/', timeout: 3000 }, (x) => { x.resume(); res(); }); r.on('error', rej); r.on('timeout', () => { r.destroy(); rej(new Error('timeout')); }); }); S.hs.portalOk = true; }
  catch { S.hs.portalOk = false; }
}
function hsAddress(iface) { const x = info.nets.find((n) => n.iface === iface); return x ? x.addr : ''; }
async function hsPlan() {
  if (!apiConn) throw new Error('Router is not connected');
  const a = await hsActual();
  const iface = a.server ? a.server.interface : HS.iface;
  if (!iface) throw new Error('Choose the guest network interface first (Guest Wi-Fi > Settings)');
  const addr = hsAddress(iface); if (!addr) throw new Error('Could not find the router address on ' + iface + ' (the interface needs an IP address)');
  let pool = a.server ? a.server['address-pool'] : HS.pool;
  if (!pool) { const ds = await apiConn.run(['/ip/dhcp-server/print', '=.proplist=interface,address-pool,disabled', '?interface=' + iface]); const d = ds.find((x) => x['address-pool'] && x['address-pool'] !== 'static-only'); pool = d ? d['address-pool'] : ''; }
  const legacyMacs = new Set(a.bindings.filter((b) => !String(b.comment || '').startsWith('[mtc-hotspot')).map((b) => upMac(b['mac-address'])).filter(Boolean));
  const apBypass = [];
  return hotspot.plan(HS, hotspot.desired(HS, { address: addr, iface, pool, apBypass, isProd: true }), a);
}
async function hsReport() {
  const out = { config: HS, connected: !!apiConn, defaults: hotspot.DEFAULTS.orgName };
  if (!apiConn) return out;
  await hsPortalProbe(); const a = await hsActual();
  out.server = a.server ? { name: a.server.name, interface: a.server.interface, profile: a.server.profile, disabled: a.server.disabled === 'true' } : null;
  out.checks = hotspot.checks(HS, { server: a.server, userProfiles: a.userProfiles, bindings: a.bindings, profiles: a.profiles }, hsFacts(a));
  out.packagesOnRouter = a.userProfiles.filter((p) => String(p.name).startsWith('mtc-')).map((p) => ({ name: p.name, rate: p['rate-limit'], devices: p['shared-users'] }));
  out.legacy = { bindings: a.bindings.filter((b) => !String(b.comment || '').startsWith('[mtc-hotspot')).length, walled: a.walled.filter((e) => !String(e.comment || '').startsWith('[mtc-hotspot')).length };
  try {
    out.active = (await apiConn.run(['/ip/hotspot/active/print', '=.proplist=user,address,mac-address,uptime,session-time-left,bytes-in,bytes-out,login-by'])).map((r) => Object.assign(r, { name: nameOf(r.address) || '' }));
    out.accounts = (await apiConn.run(['/ip/hotspot/user/print', '=.proplist=.id,name,profile,comment,uptime,disabled'])).filter((u) => String(u.comment || '').startsWith('[mtc-hotspot] acct')).map(hsAcct);
  } catch { out.active = []; out.accounts = []; }
  return out;
}
const hsAcct = (u) => { const g = (k) => { const m = new RegExp(k + '=([^|]*?)(?= \\w+=|$)').exec(u.comment || ''); return m ? m[1].trim() : ''; }; return { code: u.name, profile: u.profile, room: g('room'), guest: g('guest'), until: Number(g('until')) || 0, uptime: u.uptime || '' }; };
async function hsApply() {
  const plan = await hsPlan();
  try { await apiConn.run(['/export', '=file=before-hotspot-' + new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')]); } catch (e) { throw new Error('Could not save a router backup first: ' + e.message); }
  for (const op of plan.ops) await apiConn.run(op.words);
  audit('hotspot-apply', '', `${plan.ops.length} changes (server stays as it was)`, 'dashboard'); await hsActual();
  return { ops: plan.ops.length };
}
async function hsUploadPages() {
  if (!apiConn) throw new Error('Router is not connected');
  const files = hotspot.pages(HS), dir = HS.htmlDir; let n = 0; const problems = [];
  try { await apiConn.run(['/file/add', '=name=' + dir, '=type=directory']); } catch { /* exists or not supported: files may still create it */ }
  const have = new Map((await apiConn.run(['/file/print', '=.proplist=.id,name,size'])).map((f) => [f.name, f]));
  for (const [name, html] of Object.entries(files)) {
    if (name === 'logo-url.txt') continue; const full = dir + '/' + name, ex = have.get(full);
    try { if (ex) await apiConn.run(['/file/set', '=numbers=' + ex['.id'], '=contents=' + html]); else await apiConn.run(['/file/add', '=name=' + full, '=contents=' + html]); n++; }
    catch (e) { problems.push(`${name}: ${String(e.message).slice(0, 80)}`); }
  }
  let logo = 'not requested';
  if (HS.logoUrl) { try { await apiConn.run(['/tool/fetch', '=url=' + HS.logoUrl, '=dst-path=' + dir + '/logo.png', '=mode=http']); logo = 'fetched'; } catch (e) { logo = 'could not fetch the logo (' + String(e.message).slice(0, 60) + '): pages show without it'; } }
  const after = new Map((await apiConn.run(['/file/print', '=.proplist=name,size'])).map((f) => [f.name, Number(f.size) || 0]));
  for (const [name, html] of Object.entries(files)) {
    if (name === 'logo-url.txt') continue;
    const sz = after.get(dir + '/' + name) || 0, want = Buffer.byteLength(html);
    if (!(sz > 0)) problems.push(`${name}: not on the router or empty - copy it by hand (Winbox > Files)`);
    else if (name === 'fa.css' && sz < want * 0.98) problems.push(`fa.css: only ${sz} of ${want} bytes arrived - Persian pages fall back to Tahoma; copy public\\assets\\fonts to the router by hand or tell me`);
  }
  audit('hotspot-pages', '', `${n} page(s) uploaded to ${dir}/, logo ${logo}${problems.length ? ', problems: ' + problems.join('; ') : ''}`, 'dashboard'); await hsActual();
  return { uploaded: n, logo, problems };
}
async function hsEnable(grandMinutes) {
  if (!apiConn) throw new Error('Router is not connected');
  const a = await hsActual(), c = hotspot.checks(HS, { server: a.server, userProfiles: a.userProfiles, bindings: a.bindings, profiles: a.profiles }, hsFacts(a));
  const blockers = c.filter((x) => !x.ok && ['server', 'profile', 'aps', 'pages', 'fixed'].includes(x.id)).map((x) => x.text);
  if (blockers.length) throw new Error('Not ready: ' + blockers.join(' | '));
  let gf = 0;
  if (grandMinutes > 0) {                     // let everybody who is online now keep their internet for a while
    const until = now() + grandMinutes * 60, have = new Set(a.bindings.map((b) => upMac(b['mac-address'])));
    for (const [ip, r] of info.arp) { const m = upMac(r['mac-address']); if (!m || have.has(m) || !S.lastSeen.has(ip) || now() - S.lastSeen.get(ip) > 300 || !isGuestNet(vlanOf(ip))) continue;
      try { await apiConn.run(['/ip/hotspot/ip-binding/add', '=mac-address=' + m, '=type=bypassed', '=server=' + HS.server, `=comment=[mtc-hotspot-gf] until=${until} grandfathered at enable`]); gf++; } catch { /* ignore */ } }
  }
  await apiConn.run(['/ip/hotspot/enable', '=numbers=' + a.server['.id']]);
  audit('hotspot-enable', '', `guest hotspot ENABLED on ${a.server.interface}, ${gf} online devices grandfathered for ${grandMinutes} min`, 'dashboard'); await hsActual();
  return { enabled: true, grandfathered: gf };
}
async function hsDisable() {
  if (!apiConn) throw new Error('Router is not connected');
  const a = await hsActual(); if (!a.server) throw new Error('server not found');
  await apiConn.run(['/ip/hotspot/disable', '=numbers=' + a.server['.id']]);
  for (const b of a.bindings) if (String(b.comment || '').startsWith('[mtc-hotspot-gf]')) { try { await apiConn.run(['/ip/hotspot/ip-binding/remove', '=numbers=' + b['.id']]); } catch { /* ignore */ } }
  audit('hotspot-disable', '', 'guest hotspot DISABLED (everybody has the internet again)', 'dashboard'); await hsActual();
  return { disabled: true };
}
async function hsRemove() {          // rollback: our objects out, server back to its old profile, still disabled
  if (!apiConn) throw new Error('Router is not connected');
  const a = await hsActual(); let n = 0;
  if (a.server) {
    await apiConn.run(['/ip/hotspot/disable', '=numbers=' + a.server['.id']]);
    if (String(a.server.name).startsWith('mtc-')) { await apiConn.run(['/ip/hotspot/remove', '=numbers=' + a.server['.id']]); n++; }      // a server this program created: remove it
    else { const old = a.profiles.find((p) => p.name === 'default'); if (old && a.server.profile === HS.profileName) await apiConn.run(['/ip/hotspot/set', '=numbers=' + a.server['.id'], '=profile=default']); }   // an existing server: back to the default profile, still disabled
  }
  for (const b of a.bindings) if (String(b.comment || '').startsWith('[mtc-hotspot')) { await apiConn.run(['/ip/hotspot/ip-binding/remove', '=numbers=' + b['.id']]); n++; }
  for (const e of a.walled) if (String(e.comment || '').startsWith('[mtc-hotspot]')) { await apiConn.run([e.kind === 'host' ? '/ip/hotspot/walled-garden/remove' : '/ip/hotspot/walled-garden/ip/remove', '=numbers=' + e['.id']]); n++; }
  const users = await apiConn.run(['/ip/hotspot/user/print', '=.proplist=.id,comment']);
  for (const u of users) if (String(u.comment || '').startsWith('[mtc-hotspot]')) { await apiConn.run(['/ip/hotspot/user/remove', '=numbers=' + u['.id']]); n++; }
  for (const p of a.userProfiles) if (String(p.name).startsWith('mtc-')) { try { await apiConn.run(['/ip/hotspot/user/profile/remove', '=numbers=' + p['.id']]); n++; } catch { /* in use */ } }
  const pr = a.profiles.find((p) => p.name === HS.profileName); if (pr) { try { await apiConn.run(['/ip/hotspot/profile/remove', '=numbers=' + pr['.id']]); n++; } catch { /* in use */ } }
  audit('hotspot-remove', '', `${n} hotspot objects removed, server back on its old profile and disabled`, 'dashboard'); await hsActual();
  return { removed: n };
}
async function hsKick(user) {
  if (!apiConn) throw new Error('Router is not connected');
  const rows = await apiConn.run(['/ip/hotspot/active/print', '=.proplist=.id,user,mac-address']);
  let n = 0; for (const r of rows) if (r.user === user || upMac(r['mac-address']) === upMac(user)) { await apiConn.run(['/ip/hotspot/active/remove', '=numbers=' + r['.id']]); n++; }
  return { kicked: n };
}
async function hsAccount(b) {
  if (!apiConn) throw new Error('Router is not connected');
  const a = await hsActual(); if (!a.server || !a.userProfiles.some((p) => p.name === 'mtc-' + b.package)) throw new Error('Prepare the router first: that package is not on the router yet');
  const until = Math.floor(Number(b.until) || 0); if (until < now() + 300) throw new Error('"Valid until" must be in the future');
  const clean = (s) => String(s || '').replace(/[^\w .\-()]/g, '').slice(0, 40);
  const existing = new Set((await apiConn.run(['/ip/hotspot/user/print', '=.proplist=name'])).map((u) => u.name));
  let code; do { code = String(require('crypto').randomInt(10000000, 99999999)); } while (existing.has(code));
  await apiConn.run(['/ip/hotspot/user/add', '=name=' + code, '=password=' + code, '=profile=mtc-' + b.package, '=server=' + HS.server, `=comment=[mtc-hotspot] acct room=${clean(b.room)} guest=${clean(b.guest)} until=${until} pkg=${b.package}`]);
  audit('hotspot-account', '', `Wi-Fi code issued: room ${clean(b.room)}, ${clean(b.guest)}, package ${b.package}, valid until ${new Date(until * 1000).toLocaleString()}`, 'dashboard');
  return { code, until };
}
async function hsRevoke(code) {
  if (!apiConn) throw new Error('Router is not connected');
  const users = await apiConn.run(['/ip/hotspot/user/print', '=.proplist=.id,name,comment', '?name=' + code]); let n = 0;
  for (const u of users) if (String(u.comment || '').startsWith('[mtc-hotspot] acct')) { await apiConn.run(['/ip/hotspot/user/remove', '=numbers=' + u['.id']]); n++; }
  await hsKick(code); if (n) audit('hotspot-account-revoke', '', `Wi-Fi code ${code} revoked`, 'dashboard');
  return { revoked: n };
}
async function hsTick() {            // expire guest codes and grandfather bindings
  if (!apiConn) return;
  const t = now();
  const users = await apiConn.run(['/ip/hotspot/user/print', '=.proplist=.id,name,comment']);
  for (const u of users) { const m = /^\[mtc-hotspot\] acct .*until=(\d+)/.exec(u.comment || ''); if (m && Number(m[1]) <= t) { await apiConn.run(['/ip/hotspot/user/remove', '=numbers=' + u['.id']]); await hsKick(u.name); audit('hotspot-account-expire', '', `Wi-Fi code ${u.name} expired and was removed`, 'system'); } }
  const bind = await apiConn.run(['/ip/hotspot/ip-binding/print', '=.proplist=.id,comment']);
  for (const b of bind) { const m = /^\[mtc-hotspot-gf\] until=(\d+)/.exec(b.comment || ''); if (m && Number(m[1]) <= t) await apiConn.run(['/ip/hotspot/ip-binding/remove', '=numbers=' + b['.id']]); }
}

// ---------------------------------------------------------------- security events
const stSecIns = db.prepare('INSERT INTO sec (ts,last,kind,sev,ip,detail) VALUES (?,?,?,?,?,?)');
const stSecUpd = db.prepare('UPDATE sec SET last=?, count=count+1, detail=?, sev=? WHERE id=?');
function fireEvent(ip, c, tsec) {
  const key = c.kind + '|' + ip, f = S.fired.get(key);
  try {
    if (f && tsec - f.ts < 900) { if (tsec - f.upd >= 30) { stSecUpd.run(tsec, c.detail, c.sev, f.id); f.upd = tsec; } return; }
    if (c.kind === 'router-login-fail') {          // same log lines are re-read after a restart: do not repeat the alert
      const dup = db.prepare('SELECT id FROM sec WHERE kind=? AND ip=? AND detail=? AND ts>?').get(c.kind, ip, c.detail, tsec - 7 * 86400);
      if (dup) { S.fired.set(key, { id: dup.id, ts: tsec, upd: tsec }); return; }
    }
    const r = stSecIns.run(tsec, tsec, c.kind, c.sev, ip, c.detail);
    S.fired.set(key, { id: Number(r.lastInsertRowid), ts: tsec, upd: tsec });
  } catch (e) { console.error('event failed:', e.message); }
}
function runSecurity(secStats, tsec) {
  const T = CONF.sec, ign = new Set(T.ignore), adm = new Set(T.adminIps), seenKeys = new Set();
  for (const [ip, st] of secStats) {
    if (ign.has(ip)) continue;
    const isAdmin = adm.has(ip) || (info.routerIps && info.routerIps.has(ip));
    for (const c of detect(st, T, { isPrivate, isAdmin })) {
      const key = c.kind + '|' + ip; seenKeys.add(key);
      const n = (S.streak.get(key) || 0) + 1; S.streak.set(key, n);
      if (n >= c.minStreak) fireEvent(ip, c, tsec);
    }
  }
  for (const k of S.streak.keys()) if (!seenKeys.has(k)) S.streak.delete(k);
}
// router log: failed logins to the router and IPsec probing (read-only), summarised per source address
async function parseLog(api) {
  const rows = await api.run(['/log/print', '=.proplist=time,topics,message']);
  const fails = new Map(), ike = new Map(), seenExt = new Map(); let newest = S.logCursor;
  for (const r of rows) {
    const t = r.time || '', msg = r.message || '';
    if (!/^\d{4}-\d{2}-\d{2} /.test(t)) continue;
    if (t > newest) newest = t;
    if (t > S.logCursor) tallyLogIps(seenExt, t, r.topics || '', msg);
    let m = /login failure for user (\S+) from (\d+\.\d+\.\d+\.\d+) via (\S+)/.exec(msg);
    if (m) {
      let f = fails.get(m[2]); if (!f) fails.set(m[2], f = { n: 0, fresh: 0, users: new Set(), via: new Set(), last: '' });
      f.n++; f.users.add(m[1]); f.via.add(m[3]); if (t > f.last) f.last = t; if (t > S.logCursor) f.fresh++;
      continue;
    }
    m = /phase1 negotiation failed.*<=>(\d+\.\d+\.\d+\.\d+)\[/.exec(msg);
    if (m) { let f = ike.get(m[1]); if (!f) ike.set(m[1], f = { n: 0, last: '' }); f.n++; if (t > f.last) f.last = t; }
  }
  const sum = [];
  for (const [ip, f] of fails) sum.push({ ip, kind: 'router login failures', n: f.n, via: [...f.via], users: [...f.users].slice(0, 6), last: f.last, internal: isPrivate(ip) });
  for (const [ip, f] of ike) sum.push({ ip, kind: 'IPsec/VPN probing', n: f.n, via: ['ipsec'], users: [], last: f.last, internal: isPrivate(ip) });
  S.logSummary = sum.sort((a, b) => b.n - a.n).slice(0, 200);
  const adm = new Set(CONF.sec.adminIps), tsec = now();
  for (const [ip, f] of fails) {
    if (!isPrivate(ip) || adm.has(ip) || f.fresh === 0) continue;
    fireEvent(ip, { kind: 'router-login-fail', sev: 'high', detail: `${f.fresh} failed login attempts to the router (${[...f.via].join('/')}, users: ${[...f.users].slice(0, 4).join(', ')})` }, tsec);
  }
  S.logCursor = newest;
  saveLogIps(seenExt);
}
function securityReport(q) {
  const days = Math.min(400, Math.max(1, Number(q.get('days')) || 7)), since = now() - days * 86400;
  const events = db.prepare('SELECT id,ts,last,kind,sev,ip,detail,count,ack FROM sec WHERE ts>=? ORDER BY last DESC LIMIT 500').all(since)
    .map((e) => Object.assign({}, e, { dev: devInfo(e.ip, {}) }));
  const lists = {};
  for (const [name, arr] of Object.entries(S.routerLists || {})) lists[name] = arr.slice(0, 200);
  return { events, router: { lists, log: S.logSummary }, ignore: CONF.sec.ignore, adminIps: CONF.sec.adminIps };
}
function secCounts() {
  const r = db.prepare("SELECT COUNT(*) n, COALESCE(MAX(id),0) mx FROM sec WHERE ack=0 AND sev='high' AND last>=?").get(now() - 86400);
  return { high: r.n, lastId: r.mx };
}

// ---------------------------------------------------------------- block / unblock (the ONLY writes this monitor makes)
const rosTime = (m) => { const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60; return (d ? d + 'd' : '') + (h ? h + 'h' : '') + (mm || (!d && !h) ? mm + 'm' : ''); };
function protectedIps() { return new Set([...(CONF.sec.adminIps || []), ...(info.routerIps ? [...info.routerIps] : [])]); }
S.expect = new Map(); S.blockedInit = false;
async function refreshBlocked() {
  if (!apiConn) return;
  const bl = await apiConn.run(['/ip/firewall/address-list/print', '=.proplist=.id,address,comment,timeout', '?list=MTC-Blocked-Clients']);
  const next = new Map(bl.map((r) => [r.address, { id: r['.id'], comment: r.comment || '', timeout: r.timeout || '' }]));
  const t = now();
  for (const [k, ts] of S.expect) if (t - ts > 90) S.expect.delete(k);
  if (S.blockedInit) {            // changes we did not make: timeout expired, or done on the router by hand
    for (const [ip, v] of next) if (!S.blocked.has(ip) && !S.expect.has('b' + ip)) audit('block-external', ip, 'added on the router (Winbox / script): ' + v.comment, 'router');
    for (const ip of S.blocked.keys()) if (!next.has(ip) && !S.expect.has('u' + ip)) audit('unblock-auto', ip, 'removed on the router (timeout ended or removed by hand)', 'router');
  }
  S.blocked = next; S.blockedInit = true;
}
async function doBlock(ip, minutes, note) {
  if (!apiConn) throw new Error('Router is not connected');
  if (!isIPv4(ip) || !isPrivate(ip)) throw new Error('Only LAN addresses can be blocked');
  if (protectedIps().has(ip)) throw new Error('This address is protected (admin PC / router address)');
  if (!S.blockRule) throw new Error('The block rule is not on the router yet: run internet-block.ps1 first');
  await refreshBlocked();
  if (S.blocked.has(ip)) return { already: true };
  S.expect.set('b' + ip, now());
  const label = (String(note || nameOf(ip) || '').replace(/[^\w .\-()]/g, '') || 'client').slice(0, 40);
  const w = ['/ip/firewall/address-list/add', '=list=MTC-Blocked-Clients', '=address=' + ip, `=comment=[mtc-block] ${label} (blocked from Traffic Monitor ${new Date().toISOString().slice(0, 16).replace('T', ' ')})`];
  if (minutes > 0) w.push('=timeout=' + rosTime(minutes));
  await apiConn.run(w);
  const ids = (S.lastRows || []).filter((r) => hostOf(r['src-address'] || '') === ip && !isPrivate(hostOf(r['dst-address'] || '0.0.0.0'))).map((r) => r['.id']);
  for (let i = 0; i < ids.length; i += 100) { try { await apiConn.run(['/ip/firewall/connection/remove', '=numbers=' + ids.slice(i, i + 100).join(',')]); } catch { /* ignore */ } }
  await refreshBlocked();
  audit('block', ip, (minutes > 0 ? 'for ' + rosTime(minutes) : 'until unblocked') + ', ' + ids.length + ' internet connections cut' + (note ? ' - ' + String(note).slice(0, 60) : ''), 'dashboard');
  return { blocked: true, cut: ids.length };
}
async function doUnblock(ip) {
  if (!apiConn) throw new Error('Router is not connected');
  S.expect.set('u' + ip, now());
  const rows = await apiConn.run(['/ip/firewall/address-list/print', '=.proplist=.id', '?list=MTC-Blocked-Clients', '?address=' + ip]);
  for (const r of rows) await apiConn.run(['/ip/firewall/address-list/remove', '=numbers=' + r['.id']]);
  await refreshBlocked();
  if (rows.length) audit('unblock', ip, 'unblocked from the dashboard', 'dashboard');
  return { unblocked: rows.length };
}
function blockedReport() {
  return { ruleOk: S.blockRule, items: [...S.blocked].map(([ip, v]) => Object.assign(devInfo(ip, {}), { comment: v.comment, timeout: v.timeout })),
    ipRuleOk: !!S.ipRule, ipDropped: S.ipDropped || 0, ips: [...S.ipBlocked].map(([addr, v]) => ({ addr, comment: v.comment, timeout: v.timeout, name: wanRdns.get(addr.split('/')[0]) || '' })) };
}

// ---------- block INTERNET addresses (knockers / attackers): address list MTC-Blocked-IPs + two raw drop rules ([mtc-ipblock], script ip-block.ps1)
S.ipBlocked = new Map(); S.ipRule = false; S.ipDropped = 0; S.ipInit = false;
async function refreshIpBlocked() {
  if (!apiConn) return;
  const bl = await apiConn.run(['/ip/firewall/address-list/print', '=.proplist=.id,address,comment,timeout', '?list=MTC-Blocked-IPs']);
  const next = new Map(bl.map((r) => [r.address, { id: r['.id'], comment: r.comment || '', timeout: r.timeout || '' }]));
  const t = now();
  if (S.ipInit) {
    for (const [a, v] of next) if (!S.ipBlocked.has(a) && !S.expect.has('ib' + a) && t - (S.expect.get('x') || 0) > 0) audit('ipblock-external', '', `address ${a} added on the router: ${v.comment}`, 'router');
    for (const a of S.ipBlocked.keys()) if (!next.has(a) && !S.expect.has('iu' + a)) audit('ipunblock-auto', '', `address ${a} removed on the router (timeout ended or removed by hand)`, 'router');
  }
  S.ipBlocked = next; S.ipInit = true;
}
function parseNet(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/.exec(String(s).trim());
  if (!m || [m[1], m[2], m[3], m[4]].some((x) => +x > 255)) return null;
  const bits = m[5] === undefined ? 32 : +m[5]; if (bits < 16 || bits > 32) return null;           // ranges smaller than /16 are refused
  const base = ((+m[1] << 24) >>> 0) + (+m[2] << 16) + (+m[3] << 8) + +m[4], size = 2 ** (32 - bits), start = base - (base % size);
  return { text: `${m[1]}.${m[2]}.${m[3]}.${m[4]}` + (m[5] === undefined ? '' : '/' + bits), start, end: start + size - 1, single: bits === 32 };
}
function protectedPublicIps() {
  return new Set([...(CONF.sec.protectedPublic || []), ...(info.routerIps ? [...info.routerIps] : []), ...(info.wanPeers ? [...info.wanPeers] : [])].filter((x) => isIPv4(x) && !isPrivate(x)));
}
async function doIpBlock(addr, minutes, note) {
  if (!apiConn) throw new Error('Router is not connected');
  const n = parseNet(addr); if (!n) throw new Error('Enter an IPv4 address (a.b.c.d) or a range a.b.c.d/16 .. /32');
  const first = n.start, last = n.end, toIp = (x) => [x >>> 24, (x >> 16) & 255, (x >> 8) & 255, x & 255].join('.');
  if (isPrivate(toIp(first)) || isPrivate(toIp(last)) || isPrivate(addr.split('/')[0])) throw new Error('Only internet (public) addresses can be blocked here, not LAN addresses');
  for (const p of protectedPublicIps()) { const v = ip2n(p); if (v >= first && v <= last) throw new Error(`This would block ${p}, which this network needs (the router's own address, the ISP gateway or a DNS server)`); }
  if (!S.ipRule) throw new Error('The address-block rules are not on the router yet: run ip-block.ps1 first');
  await refreshIpBlocked();
  if (S.ipBlocked.has(n.text)) return { already: true };
  S.expect.set('ib' + n.text, now());
  const label = String(note || '').replace(/[^\w .\-()@:/]/g, '').slice(0, 60) || 'attacker';
  const w = ['/ip/firewall/address-list/add', '=list=MTC-Blocked-IPs', '=address=' + n.text, `=comment=[mtc-ipblock] ${label} (blocked from Traffic Monitor ${new Date().toISOString().slice(0, 16).replace('T', ' ')})`];
  if (minutes > 0) w.push('=timeout=' + rosTime(minutes));
  await apiConn.run(w); await refreshIpBlocked();
  audit('ipblock', '', `${n.text} blocked ${minutes > 0 ? 'for ' + rosTime(minutes) : 'until unblocked'}${note ? ' - ' + String(note).slice(0, 80) : ''}`, 'dashboard');
  return { blocked: true, addr: n.text };
}
async function doIpUnblock(addr) {
  if (!apiConn) throw new Error('Router is not connected');
  const n = parseNet(addr); if (!n) throw new Error('bad address');
  S.expect.set('iu' + n.text, now());
  const rows = await apiConn.run(['/ip/firewall/address-list/print', '=.proplist=.id', '?list=MTC-Blocked-IPs', '?address=' + n.text]);
  for (const r of rows) await apiConn.run(['/ip/firewall/address-list/remove', '=numbers=' + r['.id']]);
  await refreshIpBlocked();
  if (rows.length) audit('ipunblock', '', `${n.text} unblocked from the dashboard`, 'dashboard');
  return { unblocked: rows.length };
}

// ---------------------------------------------------------------- audit trail + printable reports
function auditReport(q) {
  const t = now(), f = q.get('from'), to = q.get('to');
  const fromTs = dateOk(f) ? (f < '2001-01-01' ? 0 : localMidnight(f)) : t - 90 * 86400, toTs = dateOk(to) ? localMidnight(to) + 86400 : t + 60;
  const rows = db.prepare('SELECT id,ts,action,ip,name,mac,grp,detail,actor FROM aud WHERE ts>=? AND ts<? ORDER BY ts DESC, id DESC LIMIT 3000').all(fromTs, toTs);
  const open = new Map();                                    // pair each unblock with the block before it -> how long it lasted
  for (const r of [...rows].reverse()) {
    if (r.action === 'block' || r.action === 'block-external') open.set(r.ip, r.ts);
    else if (r.action === 'unblock' || r.action === 'unblock-auto') { const b = open.get(r.ip); r.duration = b ? r.ts - b : null; open.delete(r.ip); }
  }
  return { rows: rows.map((r) => Object.assign(r, { name: r.name || nameOf(r.ip) || '' })), blockedNow: blockedReport().items.length };
}
function reportData(q) {
  const { from, to } = rangeFromQ(q), qs = new URLSearchParams({ from, to }), fromTs = localMidnight(from), toTs = localMidnight(to) + 86400;
  const dr = db.prepare('SELECT ip, SUM(iu) iu, SUM(id) id, SUM(lu) lu, SUM(ld) ld, COUNT(*) days FROM d WHERE day>=? AND day<=? GROUP BY ip').all(from, to);
  const tot = { up: 0, down: 0, lanUp: 0, lanDown: 0, active: 0, staff: 0, guest: 0, other: 0 }, all = [], guests = [];
  for (const r of dr) {
    if (info.routerIps && info.routerIps.has(r.ip)) continue;
    const d = devInfo(r.ip, {}), grp = d.staff ? 'staff' : isGuestNet(d.vlan) ? 'guest' : 'other';
    tot.up += r.iu; tot.down += r.id; tot.lanUp += r.lu; tot.lanDown += r.ld;
    const row = { ip: r.ip, name: d.name, mac: d.mac, vlan: d.vlan, group: grp, up: r.iu, down: r.id, total: r.iu + r.id, days: r.days };
    if (row.total >= 1e6) { tot.active++; tot[grp]++; all.push(row); if (grp === 'guest') guests.push(row); }
  }
  const people = staffReport(qs).people.map((p) => ({ name: p.name, ips: p.ips, mac: p.mac, vlan: p.vlan, up: p.iu, down: p.id, total: p.iu + p.id, days: p.days })).filter((p) => p.total >= 1e6);
  const byTotal = (a, b) => b.total - a.total;
  const dest = destReport(qs), cc = db.prepare('SELECT MAX(total) t, MAX(inet) i FROM cc WHERE ts>=? AND ts<?').get(fromTs, toTs), pk = db.prepare('SELECT MAX(mr) r, MAX(mc) c FROM x WHERE day>=? AND day<=?').get(from, to);
  const flag = (g) => { const a = abuseReport(new URLSearchParams({ group: g, from, to })); return { median: a.median, config: a.config, checked: a.rows.length, flagged: a.rows.filter((r) => r.reasons.length).slice(0, 12) }; };
  const events = db.prepare('SELECT id,ts,last,kind,sev,ip,detail,count FROM sec WHERE ts>=? AND ts<? ORDER BY last DESC LIMIT 300').all(fromTs, toTs).map((e) => Object.assign(e, { name: nameOf(e.ip) || '' }));
  const evKinds = {}; for (const e of events) { const k = e.kind + '|' + e.sev; evKinds[k] = (evKinds[k] || 0) + 1; }
  const aud = db.prepare('SELECT ts,action,ip,name,grp,detail,actor FROM aud WHERE ts>=? AND ts<? ORDER BY ts DESC LIMIT 200').all(fromTs, toTs);
  const off = [...pres.values()].filter((p) => p.state === 'offline' && p.watch && p.first).sort((a, b) => b.since - a.since)
    .map((p) => ({ ip: p.ip, name: nameOf(p.ip), group: p.group, since: p.since, last: p.last }));
  const lists = {}; for (const [n, a] of Object.entries(S.routerLists || {})) lists[n] = a.length;
  return { from, to, generated: now(), host: CFG.router, days: Math.round((localMidnight(to) - localMidnight(from)) / 86400) + 1,
    totals: Object.assign(tot, { peakConns: (cc && cc.t) || 0, peakInetConns: (cc && cc.i) || 0, peakRate: (pk && pk.r) || 0 }),
    topStaff: people.sort(byTotal).slice(0, 15), topGuests: guests.sort(byTotal).slice(0, 15), topUpload: [...all].sort((a, b) => b.up - a.up).slice(0, 10), topAll: all.sort(byTotal).slice(0, 15),
    types: dest.types.slice(0, 12), remotes: dest.remotes.slice(0, 12), abuse: { staff: flag('staff'), guest: flag('guest'), config: CONF.abuse },
    security: { events: events.slice(0, 15), kinds: evKinds, total: events.length, routerLists: lists, internalLogin: S.logSummary.filter((l) => l.internal).length },
    audit: aud, blockedNow: blockedReport().items.map((d) => ({ ip: d.ip, name: d.name, vlan: d.vlan, comment: d.comment, timeout: d.timeout })),
    offline: off.slice(0, 30), offlineTotal: off.length };
}

// ---------------------------------------------------------------- abuse (working hours / guests)
const isGuestNet = (vlan) => CONF.guestNetworks.includes(vlan);
function periodDays(p) {
  const t = new Date(), d = (n) => { const x = new Date(t); x.setDate(x.getDate() + n); return dayStr(x); };
  if (p === 'week') return { from: d(-((t.getDay() + 1) % 7)), to: d(0) };                      // week starts on Saturday
  if (p === 'month') return { from: dayStr(new Date(t.getFullYear(), t.getMonth(), 1)), to: d(0) };
  if (p === 'lmonth') return { from: dayStr(new Date(t.getFullYear(), t.getMonth() - 1, 1)), to: dayStr(new Date(t.getFullYear(), t.getMonth(), 0)) };
  if (p === 'yesterday') return { from: d(-1), to: d(-1) };
  if (p === '7d') return { from: d(-6), to: d(0) };
  if (p === '30d') return { from: d(-30), to: d(0) };
  return { from: d(0), to: d(0) };
}
// explicit ?from=YYYY-MM-DD&to=... wins over ?period=...
function rangeFromQ(q) {
  const f = q.get('from'), t = q.get('to'), today = dayStr(new Date());
  if (dateOk(f) && dateOk(t)) { const to = t > today ? today : t; return { from: f > to ? to : f, to }; }
  return periodDays(q.get('period') || 'today');
}
// Working hours: mode '24x7' = every minute counts (hotels, hospitals, shops that never close); mode 'schedule' = a window per weekday (0 = Sunday ... 6 = Saturday).
const T_OK = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v));
function workHours(A) {
  const h = (A && A.hours) || {}, week = {};
  for (let d = 0; d < 7; d++) { const w = (h.week && h.week[d]) || {}; week[d] = { on: !!w.on, start: T_OK(w.start) ? w.start : '08:00', end: T_OK(w.end) ? w.end : '17:00' }; }
  return { mode: h.mode === '24x7' ? '24x7' : 'schedule', week };
}
/** SQL condition on column ts for the working minutes of a schedule (end < start = overnight window, counted on the day it starts) */
function hoursCond(H) {
  const parts = [], params = [];
  for (let d = 0; d < 7; d++) {
    const w = H.week[d]; if (!w.on) continue;
    const t = "time(ts,'unixepoch','localtime')", wd = "strftime('%w',ts,'unixepoch','localtime')";
    if (w.start < w.end) { parts.push(`(${wd}='${d}' AND ${t}>=? AND ${t}<?)`); params.push(w.start + ':00', w.end + ':00'); }
    else if (w.start > w.end) { parts.push(`((${wd}='${d}' AND ${t}>=?) OR (${wd}='${(d + 1) % 7}' AND ${t}<?))`); params.push(w.start + ':00', w.end + ':00'); }
    else { parts.push(`${wd}='${d}'`); }
  }
  return { sql: parts.length ? 'AND (' + parts.join(' OR ') + ')' : 'AND 0', params };
}
function abuseReport(q) {
  const group = q.get('group') === 'guest' ? 'guest' : 'staff', period = q.get('period') || 'today', A = CONF.abuse;
  let { from, to } = rangeFromQ(q); const oldest = periodDays('30d').from; if (from < oldest) from = oldest;     // per-minute data is kept 31 days
  const fromTs = localMidnight(from), toTs = localMidnight(to) + 86400;
  const H = workHours(A), win = group === 'staff' && H.mode === 'schedule';      // 24/7: nothing is "outside working hours"
  const hc = win ? hoursCond(H) : { sql: '', params: [] }, cond = hc.sql;
  const busyBytes = A.busyMB * 1e6;
  const params = [busyBytes, fromTs, toTs].concat(hc.params);
  const rows = db.prepare(`SELECT ip, date(ts,'unixepoch','localtime') day, SUM(iu) iu, SUM(id) id, SUM(CASE WHEN iu+id>=? THEN 1 ELSE 0 END) busy, MAX(iu+id) pk FROM m WHERE ts>=? AND ts<? ${cond} GROUP BY ip, day`).all(...params);
  const allDay = new Map(db.prepare('SELECT ip, SUM(iu+id) t FROM m WHERE ts>=? AND ts<? GROUP BY ip').all(fromTs, toTs).map((r) => [r.ip, r.t]));
  const peaks = new Map(db.prepare('SELECT ip, MAX(mc) mc, MAX(mr) mr, MAX(mh) mh FROM x WHERE day>=? AND day<=? GROUP BY ip').all(from, to).map((r) => [r.ip, r]));
  const per = new Map();
  for (const r of rows) {
    if (info.routerIps && info.routerIps.has(r.ip)) continue;
    let p = per.get(r.ip);
    if (!p) {
      const d = devInfo(r.ip, {}); const grp = d.staff ? 'staff' : isGuestNet(d.vlan) ? 'guest' : 'other';
      if (grp !== group) { per.set(r.ip, null); continue; }
      per.set(r.ip, p = { ip: r.ip, name: d.name, mac: d.mac, vlan: d.vlan, up: 0, down: 0, busy: 0, pk: 0, days: new Set(), worst: 0, worstUp: 0 });
    }
    if (!p) continue;
    p.up += r.iu; p.down += r.id; p.busy += r.busy; p.pk = Math.max(p.pk, r.pk);
    if (r.iu + r.id > 1e6) p.days.add(r.day);
    p.worst = Math.max(p.worst, r.iu + r.id); p.worstUp = Math.max(p.worstUp, r.iu);
  }
  const list = [...per.values()].filter(Boolean);
  // "typical" = median of the devices that were really used (>= 50 MB), so idle phones do not drag the baseline to ~0
  const tots = list.map((p) => p.up + p.down).filter((x) => x >= 50e6).sort((a, b) => a - b);
  const median = tots.length ? tots[Math.floor(tots.length / 2)] : 0;
  const GB = 1e9, fmt = (b) => (b >= GB ? (b / GB).toFixed(1) + ' GB' : (b / 1e6).toFixed(0) + ' MB');
  const out = list.map((p) => {
    const total = p.up + p.down, nd = Math.max(1, p.days.size), pk = peaks.get(p.ip) || {}, reasons = []; let score = 0;
    const add = (txt, ratio) => { reasons.push(txt); score = Math.max(score, ratio); };
    if (win) {
      if (total / nd >= A.staffDayGB * GB) add(`${fmt(total / nd)} per ${H.mode === '24x7' ? 'day' : 'working day'} (limit ${A.staffDayGB} GB)`, total / nd / (A.staffDayGB * GB));
      if (p.busy / nd >= A.busyMinWarn) add(`${Math.round(p.busy / nd)} busy minutes per working day (>= ${A.busyMB} MB/min, limit ${A.busyMinWarn})`, p.busy / nd / A.busyMinWarn);
    } else {
      if (p.worst >= A.guestDayGB * GB) add(`${fmt(p.worst)} in one day (limit ${A.guestDayGB} GB)`, p.worst / (A.guestDayGB * GB));
      if (p.busy / nd >= 360) add(`${Math.round(p.busy / nd)} busy minutes per day (streaming / downloading all day)`, p.busy / nd / 360);
      if ((pk.mc || 0) >= A.connWarn) add(`peak ${pk.mc} concurrent connections (limit ${A.connWarn}): torrent / flood pattern`, pk.mc / A.connWarn);
    }
    if (p.up / nd >= A.uploadGB * GB) add(`heavy upload: ${fmt(p.up / nd)} per day (limit ${A.uploadGB} GB)`, p.up / nd / (A.uploadGB * GB));
    if (median > 0 && total >= A.peerMult * median && total >= A.minPeerMB * 1e6) add(`${(total / median).toFixed(1)}x the ${win ? 'staff' : 'guest'} median (${fmt(median)})`, total / median / A.peerMult);
    return { ip: p.ip, name: p.name, mac: p.mac, vlan: p.vlan, down: p.down, up: p.up, total, days: p.days.size, busy: p.busy, peakMbps: p.pk * 8 / 60 / 1e6,
      peakConns: pk.mc || 0, peakHosts: pk.mh || 0, offHours: win ? Math.max(0, (allDay.get(p.ip) || 0) - total) : 0, reasons, score, blocked: S.blocked.has(p.ip) };
  }).sort((a, b) => b.score - a.score || b.total - a.total).slice(0, 300);
  return { from, to, group, median, config: Object.assign({}, A, { hours: H }), hoursMode: H.mode, rows: out, blockRule: S.blockRule };
}

// ---------------------------------------------------------------- external IPs: whois + everything the router saw (read-only)
const whoisLib = require('./whois');
db.exec(`CREATE TABLE IF NOT EXISTS ipw (ip TEXT PRIMARY KEY, j TEXT, ts INTEGER);
CREATE TABLE IF NOT EXISTS extlog (ip TEXT, day TEXT, n INTEGER, last TEXT, topics TEXT, sample TEXT, PRIMARY KEY (ip, day)) WITHOUT ROWID;`);
const stIpw = db.prepare('INSERT OR REPLACE INTO ipw (ip,j,ts) VALUES (?,?,?)');
const W = new Map(), PFX = [];                                   // whois cache: exact ip -> record, and network blocks found by RDAP
function pfxAdd(rec) {
  const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/.exec((rec.cidr || '').split(',')[0].trim());
  if (!m || rec.error) return;
  const bits = +m[2]; if (bits < 8 || bits > 32) return;
  const mask = (~0 << (32 - bits)) >>> 0, base = (ip2n(m[1]) & mask) >>> 0;
  if (!PFX.some((p) => p.base === base && p.mask === mask)) PFX.push({ base, mask, rec });
}
for (const r of db.prepare('SELECT ip,j FROM ipw').all()) { try { const rec = JSON.parse(r.j); W.set(r.ip, rec); pfxAdd(rec); } catch { /* skip */ } }
const publicIp = (s) => isIPv4(s) && s.split('.').every((x) => +x <= 255) && !isPrivate(s);
const wfresh = (rec) => rec && (rec.error ? now() - rec.ts < 3600 : now() - rec.ts < 90 * 86400);
function whoisCached(ip) {
  const e = W.get(ip); if (e && wfresh(e)) return e;
  const n = ip2n(ip);
  for (const p of PFX) if (((n & p.mask) >>> 0) === p.base && wfresh(p.rec)) return Object.assign({}, p.rec, { ip, viaBlock: true });
  return null;
}
const wQueue = [], wPending = new Map(); let wRunning = 0;
function whoisGet(ip, force) {                                   // -> Promise<record>
  if (!force) { const c = whoisCached(ip); if (c) return Promise.resolve(c); }
  if (wPending.has(ip)) return wPending.get(ip);
  const p = new Promise((resolve) => { wQueue.push({ ip, resolve }); wPump(); });
  wPending.set(ip, p); p.then(() => wPending.delete(ip));
  return p;
}
function wPump() {
  while (wRunning < 3 && wQueue.length) {
    const job = wQueue.shift(); wRunning++;
    whoisLib.lookup(job.ip).catch((e) => ({ ip: job.ip, error: String(e.message || e), ts: now() })).then((rec) => {
      W.set(job.ip, rec); pfxAdd(rec);
      try { stIpw.run(job.ip, JSON.stringify(rec), rec.ts || now()); } catch { /* ignore */ }
      wRunning--; job.resolve(rec); setTimeout(wPump, 250);
    });
  }
}
const rawCache = new Map();
async function whoisRaw(ip) {
  const c = rawCache.get(ip); if (c && Date.now() - c.t < 3600e3) return c.v;
  let v; try { v = await whoisLib.rawWhois(ip); } catch (e) { v = { server: '', text: '', error: String(e.message || e) }; }
  if (!v.error) { rawCache.set(ip, { t: Date.now(), v }); if (rawCache.size > 200) rawCache.delete(rawCache.keys().next().value); }
  return v;
}

// every public address in a router log line (ignores the router's own and its ISP peer addresses)
function tallyLogIps(map, t, topics, msg) {
  const re = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/g; let m;
  while ((m = re.exec(msg))) {
    const ip = m[1];
    if (!publicIp(ip) || (info.routerIps && info.routerIps.has(ip)) || (info.wanPeers && info.wanPeers.has(ip))) continue;
    let e = map.get(ip); if (!e) map.set(ip, e = { n: 0, last: '', topics: new Set(), sample: '', day: t.slice(0, 10) });
    e.n++; if (t > e.last) { e.last = t; e.sample = msg.slice(0, 200); } for (const x of topics.split(',')) if (x) e.topics.add(x);
  }
}
const stExtlog = db.prepare(`INSERT INTO extlog (ip,day,n,last,topics,sample) VALUES (?,?,?,?,?,?)
  ON CONFLICT(ip,day) DO UPDATE SET n=n+excluded.n, last=MAX(last,excluded.last), topics=excluded.topics, sample=CASE WHEN excluded.last>=last THEN excluded.sample ELSE sample END`);
function saveLogIps(map) {
  if (!map.size) return;
  db.exec('BEGIN');
  try { for (const [ip, e] of map) stExtlog.run(ip, e.day, e.n, e.last, [...e.topics].join(','), e.sample); db.exec('COMMIT'); } catch { try { db.exec('ROLLBACK'); } catch { /* ignore */ } }
  db.prepare("DELETE FROM extlog WHERE day<?").run(dayStr(new Date(Date.now() - 400 * 86400e3)));
}

// All internet addresses seen: contacted by local devices (rm), written to the router log (extlog), in the router's trap lists.
function extReport(q) {
  const days = Math.min(120, Math.max(1, Number(q.get('days')) || 7)), from = dayStr(new Date(Date.now() - (days - 1) * 86400e3));
  const map = new Map();
  const get = (ip) => { let e = map.get(ip); if (!e) map.set(ip, e = { ip, devices: 0, bytes: 0, hits: 0, port: 0, lastDay: '', logN: 0, logLast: '', topics: [], sample: '', lists: [] }); return e; };
  for (const r of db.prepare('SELECT remote, SUM(iu+id) b, SUM(hits) h, COUNT(DISTINCT ip) devs, MAX(day) last, MAX(port) port FROM rm WHERE day>=? GROUP BY remote').all(from)) {
    if (!publicIp(r.remote)) continue;
    const e = get(r.remote); e.devices = r.devs; e.bytes = r.b; e.hits = r.h; e.port = r.port; e.lastDay = r.last;
  }
  const tp = new Map();
  for (const r of db.prepare('SELECT ip, day, n, last, topics, sample FROM extlog WHERE day>=? ORDER BY day').all(from)) {
    const e = get(r.ip); e.logN += r.n; if (r.last >= e.logLast) { e.logLast = r.last; e.sample = r.sample; }
    let s = tp.get(r.ip); if (!s) tp.set(r.ip, s = new Set()); for (const x of r.topics.split(',')) if (x) s.add(x);
  }
  for (const [ip, s] of tp) map.get(ip).topics = [...s];
  for (const [name, arr] of Object.entries(S.routerLists || {})) for (const r of arr) if (publicIp(r.address)) { const e = get(r.address); if (!e.lists.includes(name)) e.lists.push(name); }
  const src = q.get('src') || 'all', text = (q.get('q') || '').toLowerCase();
  let rows = [...map.values()].map((e) => {
    const w = whoisCached(e.ip), c = classify(e.ip, wanRdns.get(e.ip) || '', e.port, 'tcp');
    return Object.assign(e, { name: wanRdns.get(e.ip) || '', type: c.type, w: w ? { country: w.country || '', org: w.org || '', net: w.net || '', asn: w.asn || '', asnName: w.asnName || '', prefix: w.prefix || '', abuse: w.abuse || '', error: w.error || '' } : null });
  });
  if (src === 'router') rows = rows.filter((e) => e.logN || e.lists.length);
  else if (src === 'devices') rows = rows.filter((e) => e.devices);
  else if (src === 'scanners') rows = rows.filter((e) => e.lists.length);
  if (text) rows = rows.filter((e) => (e.ip + ' ' + e.name + ' ' + e.type + ' ' + (e.w ? e.w.org + ' ' + e.w.country + ' ' + e.w.asn + ' ' + e.w.net + ' ' + e.w.asnName : '')).toLowerCase().includes(text));
  rows.sort((a, b) => ((b.lists.length ? 1e15 : 0) + b.logN * 1e9 + b.bytes) - ((a.lists.length ? 1e15 : 0) + a.logN * 1e9 + a.bytes));
  const total = rows.length, shown = rows.slice(0, 1500);
  const todo = shown.filter((e) => !e.w).length;
  if (q.get('lookup') !== '0') for (const e of shown.filter((x) => !x.w).slice(0, 60)) whoisGet(e.ip).catch(() => {});      // fill in the top of the list in the background
  return { days, from, total, todo, queued: wQueue.length + wRunning, cached: W.size, rows: shown, logOldest: (db.prepare('SELECT MIN(day) d FROM extlog').get() || {}).d || '' };
}
function extCsv(rep) {
  const esc = (v) => { v = String(v == null ? '' : v); return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const head = ['ip', 'country', 'organisation', 'network', 'asn', 'as_name', 'prefix', 'abuse_contact', 'reverse_dns', 'type', 'local_devices', 'bytes', 'router_log_lines', 'router_log_last', 'router_lists', 'router_log_sample'];
  return [head.join(',')].concat(rep.rows.map((e) => [e.ip, e.w && e.w.country, e.w && e.w.org, e.w && e.w.net, e.w && e.w.asn, e.w && e.w.asnName, e.w && e.w.prefix, e.w && e.w.abuse, e.name, e.type, e.devices, e.bytes, e.logN, e.logLast, e.lists.join(' '), e.sample].map(esc).join(','))).join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------- destinations ("the other side")
function destReport(q) {
  const { from, to } = rangeFromQ(q), ip = q.get('ip');
  const ipOk = ip && isIPv4(ip);
  const rows = db.prepare(`SELECT remote, SUM(iu) iu, SUM(id) id, SUM(hits) hits, COUNT(DISTINCT ip) devs, MAX(port) port FROM rm WHERE day>=? AND day<=? ${ipOk ? 'AND ip=?' : ''} GROUP BY remote`).all(...[from, to].concat(ipOk ? [ip] : []));
  const types = new Map(); const remotes = [];
  for (const r of rows) {
    const ptr = wanRdns.get(r.remote) || '', c = classify(r.remote, ptr, r.port, 'tcp');
    let t = types.get(c.type); if (!t) types.set(c.type, t = { type: c.type, up: 0, down: 0, remotes: 0 });
    t.up += r.iu; t.down += r.id; t.remotes++;
    remotes.push({ ip: r.remote, name: ptr, org: c.org, type: c.type, up: r.iu, down: r.id, hits: r.hits, devices: r.devs, port: r.port });
  }
  remotes.sort((a, b) => (b.up + b.down) - (a.up + a.down));
  const top = remotes.slice(0, 250); for (const r of top.slice(0, 80)) lookupWan(r.ip);
  return { from, to, types: [...types.values()].sort((a, b) => (b.up + b.down) - (a.up + a.down)), remotes: top, total: remotes.length };
}
function destNow() {
  const types = new Map();
  const remotes = S.remoteNow.slice(0, 60).map((r) => { const ptr = wanRdns.get(r.ip) || '', c = classify(r.ip, ptr, r.port, r.proto); return Object.assign({}, r, { name: ptr, org: c.org, type: c.type }); });
  for (const r of S.remoteNow) { const c = classify(r.ip, wanRdns.get(r.ip) || '', r.port, r.proto); let t = types.get(c.type); if (!t) types.set(c.type, t = { type: c.type, up: 0, down: 0, conns: 0 }); t.up += r.up; t.down += r.down; t.conns += r.conns; }
  const byConns = [...S.remoteNow].sort((a, b) => b.conns - a.conns).slice(0, 30).map((r) => { const ptr = wanRdns.get(r.ip) || '', c = classify(r.ip, ptr, r.port, r.proto); return Object.assign({}, r, { name: ptr, org: c.org, type: c.type }); });
  return { types: [...types.values()].sort((a, b) => (b.up + b.down) - (a.up + a.down)), remotes, byConns };
}
function remoteDevices(q) {
  const { from, to } = periodDays(q.get('period') || 'today'), r = q.get('ip');
  if (!isIPv4(r || '')) return [];
  return db.prepare('SELECT ip, SUM(iu) iu, SUM(id) id, SUM(hits) hits FROM rm WHERE day>=? AND day<=? AND remote=? GROUP BY ip ORDER BY SUM(iu)+SUM(id) DESC LIMIT 50').all(from, to, r).map((x) => devInfo(x.ip, { up: x.iu, down: x.id, hits: x.hits }));
}
function concurrency(q) {
  const range = q.get('range') || '1h', span = { '1h': 3600, '24h': 86400, '7d': 7 * 86400 }[range] || 3600, step = span <= 3600 ? 60 : span <= 86400 ? 900 : 3600;
  const rows = db.prepare(`SELECT (ts/${step})*${step} b, MAX(total) total, MAX(inet) inet FROM cc WHERE ts>=? GROUP BY b ORDER BY b`).all(now() - span).map((r) => [r.b, r.total, r.inet]);
  const today = new Map(db.prepare('SELECT ip, mc, mr, mh FROM x WHERE day=?').all(dayStr(new Date())).map((r) => [r.ip, r]));
  const devices = [...(S.conns_by || new Map())].map(([ip, c]) => { const p = today.get(ip) || {}; return devInfo(ip, { conns: c, iconn: (S.iconn && S.iconn.get(ip)) || 0, remotes: (S.remsets && S.remsets.get(ip)) || 0, peakConns: p.mc || 0, peakHosts: p.mh || 0 }); })
    .sort((a, b) => b.iconn - a.iconn).slice(0, 100);
  return { live: S.cc, history: rows, step, devices };
}

// ---------------------------------------------------------------- queries
const RANGES = {
  '1h': { t: 'm', span: 3600, step: 60 },
  '6h': { t: 'm', span: 6 * 3600, step: 300 },
  '24h': { t: 'm', span: 86400, step: 900 },
  '7d': { t: 'm', span: 7 * 86400, step: 3600 },
  '30d': { t: 'd', days: 30 },
  '90d': { t: 'd', days: 90 },
  '1y': { t: 'd', days: 365 },
};
function localMidnight(ds) { const [y, m, d] = ds.split('-').map(Number); return Math.floor(new Date(y, m - 1, d).getTime() / 1000); }
function history(ip, range) {
  const R = RANGES[range] || RANGES['24h'];
  const all = ip === 'all';
  const out = [];
  if (R.t === 'm') {
    const t = now(), from = t - R.span, st = R.step;
    const sql = `SELECT (ts/${st})*${st} AS b, SUM(iu) iu, SUM(id) id, SUM(lu) lu, SUM(ld) ld FROM m WHERE ts>=? ${all ? '' : 'AND ip=?'} GROUP BY b`;
    const rows = all ? db.prepare(sql).all(from) : db.prepare(sql).all(from, ip);
    const mp = new Map(rows.map((r) => [r.b, r]));
    for (let b = Math.floor(from / st) * st; b <= t; b += st) { const r = mp.get(b); out.push([b, r ? r.iu : 0, r ? r.id : 0, r ? r.lu : 0, r ? r.ld : 0]); }
    return { step: st, rows: out };
  }
  const d0 = new Date(); d0.setDate(d0.getDate() - R.days + 1);
  const from = dayStr(d0);
  const sql = `SELECT day, SUM(iu) iu, SUM(id) id, SUM(lu) lu, SUM(ld) ld FROM d WHERE day>=? ${all ? '' : 'AND ip=?'} GROUP BY day`;
  const rows = all ? db.prepare(sql).all(from) : db.prepare(sql).all(from, ip);
  const mp = new Map(rows.map((r) => [r.day, r]));
  const c = new Date(d0);
  for (let i = 0; i < R.days; i++) { const ds = dayStr(c); const r = mp.get(ds); out.push([localMidnight(ds), r ? r.iu : 0, r ? r.id : 0, r ? r.lu : 0, r ? r.ld : 0]); c.setDate(c.getDate() + 1); }
  return { step: 86400, rows: out };
}
function ranking(range) {
  let rows;
  if (range === 'today') rows = db.prepare('SELECT ip, iu, id, lu, ld FROM d WHERE day=?').all(dayStr(new Date()));
  else if (range === '24h') rows = db.prepare('SELECT ip, SUM(iu) iu, SUM(id) id, SUM(lu) lu, SUM(ld) ld FROM m WHERE ts>=? GROUP BY ip').all(now() - 86400);
  else if (range === '7d') rows = db.prepare('SELECT ip, SUM(iu) iu, SUM(id) id, SUM(lu) lu, SUM(ld) ld FROM m WHERE ts>=? GROUP BY ip').all(now() - 7 * 86400);
  else {
    const days = range === '90d' ? 90 : range === '1y' ? 365 : 30;
    const d0 = new Date(); d0.setDate(d0.getDate() - days + 1);
    rows = db.prepare('SELECT ip, SUM(iu) iu, SUM(id) id, SUM(lu) lu, SUM(ld) ld FROM d WHERE day>=? GROUP BY ip').all(dayStr(d0));
  }
  return rows.map((r) => devInfo(r.ip, { iu: r.iu, id: r.id, lu: r.lu, ld: r.ld }));
}
// ---- VPN / tunnel usage per device (by protocol and well-known port; other tunnels are found by the single-remote heuristic in vpnReport)
db.exec(`CREATE TABLE IF NOT EXISTS vpn (day TEXT, ip TEXT, kind TEXT, remote TEXT, up INTEGER, down INTEGER, hits INTEGER, port INTEGER, PRIMARY KEY (day, ip, kind, remote)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS macs (mac TEXT PRIMARY KEY, first INTEGER, last INTEGER, ip TEXT, host TEXT, iface TEXT);`);
const VPN_PORTS = { 1194: 'OpenVPN', 51820: 'WireGuard', 500: 'IPsec / IKE', 4500: 'IPsec / IKE', 1723: 'PPTP', 1701: 'L2TP', 8388: 'Shadowsocks', 9001: 'Tor', 9030: 'Tor', 9050: 'Tor', 1080: 'SOCKS proxy', 5555: 'OpenVPN (alt)' };
function vpnKind(proto, port) {
  if (proto === 'gre') return 'PPTP / GRE';
  if (proto === 'ipsec-esp' || proto === 'esp' || proto === 'ipsec-ah') return 'IPsec';
  if (proto === 'tcp' || proto === 'udp') { if (port === 5555 && proto === 'tcp') return null; return VPN_PORTS[port] || null; }
  return null;
}
let VPNL = new Map();                       // this poll: device -> { kinds:Set, bytes }
S.vpnAcc = new Map();
function vpnNote(dev, kind, remote, port, up, down) {
  const k = dev + '|' + kind + '|' + remote; let a = S.vpnAcc.get(k); if (!a) S.vpnAcc.set(k, a = [0, 0, 0, port, dev, kind, remote]);
  a[0] += up; a[1] += down; a[2]++;
  let l = VPNL.get(dev); if (!l) VPNL.set(dev, l = { kinds: new Set(), bytes: 0 }); l.kinds.add(kind); l.bytes += up + down;
}
const stVpn = db.prepare('INSERT INTO vpn (day,ip,kind,remote,up,down,hits,port) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(day,ip,kind,remote) DO UPDATE SET up=up+excluded.up, down=down+excluded.down, hits=hits+excluded.hits, port=excluded.port');
setInterval(() => {
  const day = dayStr(new Date()), rows = [...S.vpnAcc.values()]; S.vpnAcc = new Map();
  try { for (const a of rows) stVpn.run(day, a[4], a[5], a[6], Math.round(a[0]), Math.round(a[1]), a[2], a[3] || 0); } catch (e) { /* ignore */ }
}, 60000);
function vpnReport(q) {
  const days = Math.max(1, Math.min(60, +(q.get('days') || 7))), from = dayStr(new Date(Date.now() - (days - 1) * 864e5));
  const per = new Map();
  const rows = db.prepare('SELECT ip,kind,remote,SUM(up) up,SUM(down) down,SUM(hits) hits,MAX(port) port FROM vpn WHERE day>=? GROUP BY ip,kind,remote').all(from);
  const tot = new Map(db.prepare('SELECT ip,SUM(iu+id) b FROM d WHERE day>=? GROUP BY ip').all(from).map((r) => [r.ip, r.b]));
  const get = (ip) => { let p = per.get(ip); if (!p) per.set(ip, p = { ip, kinds: new Set(), remotes: new Set(), up: 0, down: 0, hits: 0, possible: false }); return p; };
  for (const r of rows) { const p = get(r.ip); p.kinds.add(r.kind); p.remotes.add(r.remote); p.up += r.up; p.down += r.down; p.hits += r.hits; }
  // heuristic: one remote address carries nearly all of a busy device's internet traffic and is not a known service (looks like a tunnel or proxy)
  const rm = db.prepare('SELECT ip,remote,SUM(iu+id) b,MAX(port) port FROM rm WHERE day>=? GROUP BY ip,remote').all(from);
  const byIp = new Map(); for (const r of rm) { let a = byIp.get(r.ip); if (!a) byIp.set(r.ip, a = []); a.push(r); }
  for (const [ip, a] of byIp) {
    const sum = a.reduce((s, x) => s + x.b, 0); if (sum < 50e6) continue;
    const top = a.sort((x, y) => y.b - x.b)[0]; if (top.b / sum < 0.85) continue;
    const c = classify(top.remote, wanRdns.get(top.remote) || '', top.port, 'tcp');
    if (c.type !== 'Other / Unknown') continue;
    const p = get(ip); if (p.kinds.size) continue;
    p.possible = true; p.kinds.add('Possible tunnel'); p.remotes.add(top.remote); p.down += top.b; p.hits = 1; p.note = Math.round(top.b / sum * 100) + '% of its traffic goes to one unknown address';
  }
  const list = [...per.values()].map((p) => Object.assign(devInfo(p.ip, {}), { kinds: [...p.kinds], remotes: [...p.remotes].slice(0, 6), up: p.up, down: p.down, vpnBytes: p.up + p.down, share: tot.get(p.ip) ? Math.min(1, (p.up + p.down) / tot.get(p.ip)) : 0, total: tot.get(p.ip) || 0, possible: p.possible, note: p.note || '', live: VPNL.has(p.ip) || (S.vpnLive || new Map()).has(p.ip) }))
    .sort((a, b) => b.vpnBytes - a.vpnBytes);
  const kinds = new Map(); for (const r of rows) { const k = kinds.get(r.kind) || { kind: r.kind, bytes: 0, devices: new Set() }; k.bytes += r.up + r.down; k.devices.add(r.ip); kinds.set(r.kind, k); }
  const allInet = [...tot.values()].reduce((s, x) => s + x, 0), vpnAll = list.reduce((s, x) => s + x.vpnBytes, 0);
  return { days, devices: list, kinds: [...kinds.values()].map((k) => ({ kind: k.kind, bytes: k.bytes, devices: k.devices.size })).sort((a, b) => b.bytes - a.bytes), vpnBytes: vpnAll, share: allInet ? vpnAll / allInet : 0, live: [...(S.vpnLive || new Map())].map(([ip, l]) => ({ ip, name: nameOf(ip) || '', kinds: [...l.kinds] })) };
}
// ---- MAC addresses: private (randomized, "locally administered") addresses and devices that change address
const isLaa = (mac) => /^[0-9a-f][26ae]/i.test(String(mac || '').replace(/[^0-9a-f]/gi, ''));
function macsSeen() {
  const t = Math.floor(Date.now() / 1000), seen = new Map();
  for (const [ip, a] of info.arp) { const m = String(a['mac-address'] || '').toUpperCase(); if (m && isPrivate(ip)) seen.set(m, { ip, host: '', iface: a.interface || '' }); }
  for (const [ip, l] of info.lease) { const m = String(l['mac-address'] || '').toUpperCase(); if (!m) continue; const o = seen.get(m) || { ip, iface: '' }; o.host = l['host-name'] || ''; seen.set(m, o); }
  const st = db.prepare("INSERT INTO macs (mac,first,last,ip,host,iface) VALUES (?,?,?,?,?,?) ON CONFLICT(mac) DO UPDATE SET last=excluded.last, ip=excluded.ip, host=CASE WHEN excluded.host<>'' THEN excluded.host ELSE host END, iface=excluded.iface");
  try { db.exec('BEGIN'); for (const [m, o] of seen) st.run(m, t, t, o.ip, o.host || '', o.iface); db.exec('COMMIT'); } catch (e) { try { db.exec('ROLLBACK'); } catch { /* ignore */ } }
}
function macReport() {
  const now = Math.floor(Date.now() / 1000), rows = db.prepare('SELECT * FROM macs WHERE last>=?').all(now - 30 * 86400);
  const byHost = new Map();
  for (const r of rows) { const h = String(r.host || '').trim().toLowerCase(); if (!h) continue; let a = byHost.get(h); if (!a) byHost.set(h, a = []); a.push(r); }
  const changed = [];
  for (const [h, a] of byHost) {
    if (a.length < 2) continue;
    a.sort((x, y) => x.first - y.first);
    let seq = true; for (let i = 1; i < a.length; i++) if (a[i].first < a[i - 1].last - 3600) seq = false;   // a rotating phone replaces its old address, it does not use two at once
    if (!seq) continue;
    changed.push({ host: h, count: a.length, sameIp: new Set(a.map((x) => x.ip)).size === 1, macs: a.map((x) => ({ mac: x.mac, laa: isLaa(x.mac), ip: x.ip, first: x.first, last: x.last })) });
  }
  changed.sort((a, b) => b.count - a.count);
  const laa = rows.filter((r) => isLaa(r.mac)).map((r) => ({ mac: r.mac, ip: r.ip, host: r.host, name: nameOf(r.ip) || '', iface: r.iface, first: r.first, last: r.last, online: now - r.last < 600 })).sort((a, b) => b.last - a.last);
  return { total: rows.length, laaTotal: laa.length, laaOnline: laa.filter((x) => x.online).length, changed, laa: laa.slice(0, 500), since: (db.prepare('SELECT MIN(first) f FROM macs').get() || {}).f || 0 };
}
// ---- optional user labels (MAC -> user name, e.g. from 802.1X / Active Directory), file <data dir>/user-labels.json: {"AA:BB:..": "jsmith"}
const USERL = { map: new Map(), mtime: 0, chk: 0 };
function userLabels() {
  if (Date.now() - USERL.chk < 30000) return USERL.map;
  USERL.chk = Date.now();
  try {
    const f = path.join(CFG.dataDir, 'user-labels.json'), st = fs.statSync(f);
    if (st.mtimeMs !== USERL.mtime) { USERL.mtime = st.mtimeMs; USERL.map = new Map(Object.entries(JSON.parse(fs.readFileSync(f, 'utf8'))).map(([m, u]) => [m.toUpperCase(), String(u)])); }
  } catch { USERL.map = new Map(); USERL.mtime = 0; }
  return USERL.map;
}
function adUserOf(mac) { return userLabels().get(String(mac || '').toUpperCase()) || ''; }
function devInfo(ip, extra) {
  const dn = dbNames.get(ip) || {};
  const vlan = info.nets.length ? vlanOf(ip) : (dn.vlan || '');
  const mac = macOf(ip) || dn.mac || '';
  return Object.assign({ ip, name: nameOf(ip) || dn.name || '', mac, vlan, staff: isStaff(ip, vlan), adUser: adUserOf(mac) }, extra);
}
function isStaff(ip, vlan) {
  if (info.routerIps && info.routerIps.has(ip)) return false; // the router's own addresses are not staff
  const o = staffOv[ip]; return o !== undefined ? !!o : staffNets.includes(vlan); }

// ----- staff reports (daily rows, kept forever)
const dateOk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
function span(q) {
  let from = q.get('from'), to = q.get('to');
  const today = dayStr(new Date());
  if (!dateOk(to) || to > today) to = today;
  if (!dateOk(from)) from = to;
  if (from < '2000-01-01') { const r = db.prepare('SELECT MIN(day) d FROM d').get(); from = (r && r.d) || to; }
  if (from > to) [from, to] = [to, from];
  return { from, to };
}
function staffReport(q) {
  const { from, to } = span(q);
  const rows = db.prepare('SELECT day, ip, iu, id, lu, ld FROM d WHERE day>=? AND day<=?').all(from, to);
  const people = new Map(), days = new Map();
  for (const r of rows) {
    const d = devInfo(r.ip, {});
    if (!d.staff) continue;
    const key = d.mac || r.ip;               // merge IP changes of the same device by MAC
    let p = people.get(key);
    if (!p) people.set(key, p = { key, name: d.name, mac: d.mac, vlan: d.vlan, ips: [], iu: 0, id: 0, lu: 0, ld: 0, days: new Set(), last: '' });
    if (!p.ips.includes(r.ip)) p.ips.push(r.ip);
    if (d.name && (!p.name || r.day >= p.last)) p.name = d.name;
    if (r.day >= p.last) { p.last = r.day; p.vlan = d.vlan || p.vlan; }
    p.iu += r.iu; p.id += r.id; p.lu += r.lu; p.ld += r.ld;
    if (r.iu + r.id + r.lu + r.ld > 0) p.days.add(r.day);
    let t = days.get(r.day); if (!t) days.set(r.day, t = [0, 0, 0, 0]);
    t[0] += r.iu; t[1] += r.id; t[2] += r.lu; t[3] += r.ld;
  }
  const series = [];
  const [fy, fm, fd] = from.split('-').map(Number); const c = new Date(fy, fm - 1, fd);
  for (let i = 0; i < 4000; i++) { const ds = dayStr(c); if (ds > to) break; const t = days.get(ds) || [0, 0, 0, 0]; series.push([localMidnight(ds), ...t]); c.setDate(c.getDate() + 1); }
  return { from, to, series, people: [...people.values()].map((p) => Object.assign(p, { days: p.days.size })) };
}
function personDays(q) {
  const { from, to } = span(q);
  const ips = (q.get('ips') || '').split(',').filter(isIPv4).slice(0, 50);
  const out = [];
  if (ips.length) {
    const rows = db.prepare(`SELECT day, SUM(iu) iu, SUM(id) id, SUM(lu) lu, SUM(ld) ld FROM d WHERE day>=? AND day<=? AND ip IN (${ips.map(() => '?').join(',')}) GROUP BY day`).all(from, to, ...ips);
    const mp = new Map(rows.map((r) => [r.day, r]));
    const [fy, fm, fd] = from.split('-').map(Number); const c = new Date(fy, fm - 1, fd);
    for (let i = 0; i < 4000; i++) { const ds = dayStr(c); if (ds > to) break; const r = mp.get(ds); out.push([localMidnight(ds), r ? r.iu : 0, r ? r.id : 0, r ? r.lu : 0, r ? r.ld : 0]); c.setDate(c.getDate() + 1); }
  }
  return { from, to, rows: out };
}
function exportCsv(q) {
  const { from, to } = span(q);
  const staffOnly = q.get('staff') !== '0';
  const rows = db.prepare('SELECT day, ip, iu, id, lu, ld FROM d WHERE day>=? AND day<=? ORDER BY day, ip').all(from, to);
  const esc = (s) => '"' + String(s).replace(/"/g, '""') + '"';
  const out = ['date,ip,name,mac,network,staff,internet_down_bytes,internet_up_bytes,lan_down_bytes,lan_up_bytes'];
  for (const r of rows) {
    const d = devInfo(r.ip, {}); if (staffOnly && !d.staff) continue;
    out.push([r.day, r.ip, esc(d.name), d.mac, esc(d.vlan), d.staff ? 'yes' : 'no', r.id, r.iu, r.ld, r.lu].join(','));
  }
  return { csv: out.join('\r\n') + '\r\n', from, to };
}
function live() {
  const ips = new Set([...S.today.keys(), ...S.rate.keys(), ...S.blocked.keys()]);   // blocked devices stay in the list even without traffic
  const devices = [];
  for (const ip of ips) {
    const r = S.rate.get(ip) || [0, 0, 0, 0];
    const td = S.today.get(ip) || [0, 0, 0, 0];
    const ring = S.ring.get(ip) || [];
    devices.push(devInfo(ip, {
      rate: r, today: td, conns: (S.conns_by && S.conns_by.get(ip)) || 0, iconn: (S.iconn && S.iconn.get(ip)) || 0, remotes: (S.remsets && S.remsets.get(ip)) || 0, blocked: S.blocked.has(ip), blockInfo: S.blocked.has(ip) ? { timeout: S.blocked.get(ip).timeout, comment: S.blocked.get(ip).comment } : null, limit: qosLimitOf(ip),
      spark: ring.slice(-60).map((x) => x.slice(1)),
    }));
  }
  const last = S.total[S.total.length - 1] || [0, 0, 0, 0, 0];
  const tt = [0, 0, 0, 0]; for (const v of S.today.values()) for (let i = 0; i < 4; i++) tt[i] += v[i];
  return {
    status: { ok: S.ok, error: S.error, lastPoll: S.lastPoll, pollMs: S.pollMs, conns: S.conns, pollInterval: CFG.pollMs, router: CFG.router },
    total: { rate: last.slice(1), today: tt, ring: S.total },
    devices,
  };
}
function flowsFor(ip) {
  const list = (S.flows.get(ip) || []).slice();
  // merge by remote ip + port + proto
  const mp = new Map();
  for (const f of list) {
    const k = f.remote + '|' + f.port + '|' + f.proto;
    const e = mp.get(k); if (e) { e.up += f.up; e.down += f.down; } else mp.set(k, Object.assign({}, f));
  }
  const out = [...mp.values()].sort((a, b) => (b.up + b.down) - (a.up + a.down)).slice(0, 15);
  for (const f of out) { if (f.inet) lookupWan(f.remote); f.host = wanRdns.get(f.remote) || ''; }
  return out;
}

// ---------------------------------------------------------------- http
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const hostOk = (h) => h === `127.0.0.1:${CFG.httpPort}` || h === `localhost:${CFG.httpPort}`;
const sendJson = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(b); };

const server = http.createServer((req, res) => {
  if (!hostOk(req.headers.host || '')) { res.writeHead(403); return res.end('forbidden'); }
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname === '/api/live') return sendJson(res, 200, live());
    if (u.pathname === '/api/status') {
      const last = S.total[S.total.length - 1] || [0, 0, 0, 0, 0];
      const sc = secCounts();
      return sendJson(res, 200, { ok: S.ok, error: S.error, conns: S.conns, lastPoll: S.lastPoll, rate: last.slice(1), devices: S.today.size, secHigh: sc.high, secLastId: sc.lastId, blocked: S.blocked.size, offWatched: offlineCounts() });
    }
    if (u.pathname === '/api/hotspot' && req.method === 'GET') { hsReport().then((r) => sendJson(res, 200, r)).catch((e) => sendJson(res, 200, { config: HS, error: String(e.message || e).slice(0, 200) })); return; }
    if (u.pathname === '/api/hotspot/plan') { hsPlan().then((p) => sendJson(res, 200, { ops: p.ops.map((o) => o.text), warnings: p.warnings })).catch((e) => sendJson(res, 200, { error: String(e.message || e).slice(0, 200) })); return; }
    if (u.pathname === '/api/hotspot/preview') {
      const file = String(u.searchParams.get('file') || 'login.html'), all = hotspot.pages(HS);
      if (!Object.prototype.hasOwnProperty.call(all, file) || file === 'logo-url.txt' || file === 'fa.css') { res.writeHead(404); return res.end('no such page'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(hotspot.preview(all[file]));
    }
    if (u.pathname === '/api/setup' && req.method === 'GET') { setupReport().then((r) => sendJson(res, 200, r)).catch((e) => sendJson(res, 200, { error: e.message })); return; }
    if (u.pathname === '/api/setup/rsc' && req.method === 'GET') { setupPlan().then((p) => { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': 'attachment; filename="mtc-base-setup.rsc"', 'Cache-Control': 'no-store' }); res.end(setup.toRsc(p.ops, 'Mikrotik Traffic Control - router base setup')); }).catch((e) => sendJson(res, 200, { error: e.message })); return; }
    if (u.pathname === '/api/qos' && req.method === 'GET') return sendJson(res, 200, qosReport());
    if (u.pathname === '/api/qos/plan') {
      qosPlan().then((p) => sendJson(res, 200, { ops: p.ops.map((o) => o.text), warnings: p.warnings, wan: qosWan() })).catch((e) => sendJson(res, 200, { error: String(e.message || e).slice(0, 200) }));
      return;
    }
    if (u.pathname === '/api/presence') return sendJson(res, 200, presenceReport());
    if (u.pathname === '/api/presence/history') return sendJson(res, 200, presenceHistory(u.searchParams));
    if (u.pathname === '/api/audit') return sendJson(res, 200, auditReport(u.searchParams));
    if (u.pathname === '/api/report') return sendJson(res, 200, reportData(u.searchParams));
    if (u.pathname === '/api/abuse') return sendJson(res, 200, abuseReport(u.searchParams));
    if (u.pathname === '/api/vpn') return sendJson(res, 200, vpnReport(u.searchParams));
    if (u.pathname === '/api/macs') return sendJson(res, 200, macReport());
    if (u.pathname === '/api/dest') return sendJson(res, 200, destReport(u.searchParams));
    if (u.pathname === '/api/destnow') return sendJson(res, 200, destNow());
    if (u.pathname === '/api/whois' || u.pathname === '/api/whois/raw') {          // read-only: only the looked-up public address leaves this PC
      const ip = u.searchParams.get('ip') || '';
      if (!publicIp(ip)) return sendJson(res, 400, { error: 'Enter a public IPv4 address (private / local addresses have no whois record)' });
      if (u.pathname === '/api/whois/raw') { whoisRaw(ip).then((v) => sendJson(res, 200, v)); return; }
      whoisGet(ip, u.searchParams.get('refresh') === '1').then((rec) => {
        const dev = db.prepare('SELECT COUNT(DISTINCT ip) n, SUM(iu+id) b, MAX(day) last FROM rm WHERE remote=?').get(ip) || {};
        const lg = db.prepare('SELECT SUM(n) n, MAX(last) last, MIN(day) first FROM extlog WHERE ip=?').get(ip) || {};
        const logs = db.prepare('SELECT day, n, topics, sample FROM extlog WHERE ip=? ORDER BY day DESC LIMIT 10').all(ip);
        const lists = Object.entries(S.routerLists || {}).filter(([, a]) => a.some((r) => r.address === ip)).map(([k]) => k);
        sendJson(res, 200, { whois: rec, rdns: wanRdns.get(ip) || '', devices: dev.n || 0, bytes: dev.b || 0, lastDay: dev.last || '', routerLog: { n: lg.n || 0, last: lg.last || '', first: lg.first || '', days: logs }, lists });
        lookupWan(ip);
      });
      return;
    }
    if (u.pathname === '/api/extips') {
      const rep = extReport(u.searchParams);
      if (u.searchParams.get('format') === 'csv') { res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="external-ips-' + dayStr(new Date()) + '.csv"', 'Cache-Control': 'no-store' }); return res.end('﻿' + extCsv(rep)); }
      return sendJson(res, 200, rep);
    }
    if (u.pathname === '/api/remote') return sendJson(res, 200, remoteDevices(u.searchParams));
    if (u.pathname === '/api/concurrency') return sendJson(res, 200, concurrency(u.searchParams));
    if (u.pathname === '/api/security') return sendJson(res, 200, securityReport(u.searchParams));
    if (u.pathname === '/api/blocked') return sendJson(res, 200, blockedReport());
    if (u.pathname === '/api/ipblocked') return sendJson(res, 200, { rule: !!S.ipRule, dropped: S.ipDropped, ips: blockedReport().ips });
    if (u.pathname === '/api/config' && req.method === 'GET') return sendJson(res, 200, { abuse: CONF.abuse, sec: CONF.sec, guestNetworks: CONF.guestNetworks, staffNetworks: CONF.staffNetworks });
    if (['/api/setup/config', '/api/setup/apply', '/api/setup/remove', '/api/hotspot/config', '/api/hotspot/apply', '/api/hotspot/pages', '/api/hotspot/enable', '/api/hotspot/disable', '/api/hotspot/remove', '/api/hotspot/kick', '/api/hotspot/account', '/api/hotspot/account/revoke', '/api/block', '/api/unblock', '/api/secack', '/api/secignore', '/api/config', '/api/watch', '/api/qos/config', '/api/qos/apply', '/api/qos/off', '/api/qos/remove', '/api/qos/device', '/api/qos/device/clear', '/api/ipblock', '/api/ipunblock'].includes(u.pathname) && req.method === 'POST') {
      if ((req.headers['content-type'] || '').indexOf('application/json') !== 0 || (req.headers.origin && !hostOk(req.headers.origin.replace(/^https?:\/\//, '')))) { res.writeHead(403); return res.end('forbidden'); }
      let body = ''; req.on('data', (c) => { body += c; if (body.length > 5000) req.destroy(); });
      req.on('end', async () => {
        try {
          const b = JSON.parse(body);
          if (u.pathname === '/api/block') return sendJson(res, 200, Object.assign({ ok: true }, await doBlock(String(b.ip), Math.max(0, Math.min(60 * 24 * 30, Number(b.minutes) || 0)), b.note)));
          if (u.pathname === '/api/unblock') { if (!isIPv4(String(b.ip))) throw new Error('bad ip'); return sendJson(res, 200, Object.assign({ ok: true }, await doUnblock(String(b.ip)))); }
          if (u.pathname === '/api/ipblock') return sendJson(res, 200, Object.assign({ ok: true }, await doIpBlock(String(b.addr), Math.max(0, Math.min(60 * 24 * 365, Number(b.minutes) || 0)), b.note)));
          if (u.pathname === '/api/ipunblock') return sendJson(res, 200, Object.assign({ ok: true }, await doIpUnblock(String(b.addr))));
          if (u.pathname === '/api/hotspot/config') { HS = hotspot.normalize(b.config); saveHs(); return sendJson(res, 200, { ok: true }); }
          if (u.pathname === '/api/hotspot/apply') { if (b.confirm !== true) throw new Error('confirmation missing'); return sendJson(res, 200, Object.assign({ ok: true }, await hsApply())); }
          if (u.pathname === '/api/hotspot/pages') { if (b.confirm !== true) throw new Error('confirmation missing'); return sendJson(res, 200, Object.assign({ ok: true }, await hsUploadPages())); }
          if (u.pathname === '/api/hotspot/enable') { if (b.phrase !== 'ENABLE GUEST WIFI') throw new Error('Type the confirmation phrase exactly'); return sendJson(res, 200, Object.assign({ ok: true }, await hsEnable(Math.max(0, Math.min(1440, Number(b.grandfather) || 0))))); }
          if (u.pathname === '/api/hotspot/disable') return sendJson(res, 200, Object.assign({ ok: true }, await hsDisable()));
          if (u.pathname === '/api/hotspot/remove') { if (b.confirm !== true) throw new Error('confirmation missing'); return sendJson(res, 200, Object.assign({ ok: true }, await hsRemove())); }
          if (u.pathname === '/api/hotspot/kick') return sendJson(res, 200, Object.assign({ ok: true }, await hsKick(String(b.user || ''))));
          if (u.pathname === '/api/hotspot/account') return sendJson(res, 200, Object.assign({ ok: true }, await hsAccount({ room: b.room, guest: b.guest, package: String(b.package || ''), until: b.until })));
          if (u.pathname === '/api/hotspot/account/revoke') return sendJson(res, 200, Object.assign({ ok: true }, await hsRevoke(String(b.code || ''))));
          if (u.pathname === '/api/setup/config') { SU = setup.normalize(b.config); saveSU(); return sendJson(res, 200, { ok: true }); }
          if (u.pathname === '/api/setup/apply') { if (b.confirm !== true) throw new Error('confirmation missing'); return sendJson(res, 200, Object.assign({ ok: true }, await setupApply())); }
          if (u.pathname === '/api/setup/remove') { if (b.confirm !== true) throw new Error('confirmation missing'); return sendJson(res, 200, Object.assign({ ok: true }, await setupRemove())); }
          if (u.pathname === '/api/qos/config') { QOS = qos.normalize(b.config); saveQos(); return sendJson(res, 200, { ok: true }); }
          if (u.pathname === '/api/qos/apply') { if (b.confirm !== true) throw new Error('confirmation missing'); return sendJson(res, 200, Object.assign({ ok: true }, await qosApply(true))); }
          if (u.pathname === '/api/qos/off') { await qosOff(); return sendJson(res, 200, { ok: true }); }
          if (u.pathname === '/api/qos/remove') { if (b.confirm !== true) throw new Error('confirmation missing'); await qosRemoveAll(); return sendJson(res, 200, { ok: true }); }
          if (u.pathname === '/api/qos/device') {
            const spec = { profile: b.profile ? String(b.profile) : '', custom: b.custom ? { down: String(b.custom.down), up: String(b.custom.up) } : null, minutes: b.minutes, note: String(b.note || '').slice(0, 60), source: 'manual' };
            return sendJson(res, 200, await qosSetDevice(String(b.ip), spec));
          }
          if (u.pathname === '/api/qos/device/clear') { if (!isIPv4(String(b.ip))) throw new Error('bad ip'); await qosClearDevice(String(b.ip), 'removed by admin'); return sendJson(res, 200, { ok: true }); }
          if (u.pathname === '/api/watch') {
            for (const ip of b.ips) { if (!isIPv4(String(ip))) throw new Error('bad ip'); if (b.watch === null) delete watchOv[ip]; else watchOv[ip] = !!b.watch; const p = pres.get(ip); if (p) p.watch = b.watch === null ? WATCH_GROUPS.has(p.group) : !!b.watch; }
            fs.writeFileSync(watchFile, JSON.stringify(watchOv, null, 2)); return sendJson(res, 200, { ok: true });
          }
          if (u.pathname === '/api/whois/all') {          // queue whois for every listed address that has no record yet (read-only, slow: ~3 at a time)
            const q = new URLSearchParams({ days: String(Number(b.days) || 7), src: String(b.src || 'all'), q: String(b.q || ''), lookup: '0' });
            const todo = extReport(q).rows.filter((e) => !e.w); for (const e of todo.slice(0, 1500)) whoisGet(e.ip).catch(() => {});
            return sendJson(res, 200, { ok: true, queued: todo.length });
          }
          if (u.pathname === '/api/secack') { if (b.all) db.prepare('UPDATE sec SET ack=1 WHERE ack=0').run(); else if (b.ip) { if (!isIPv4(String(b.ip))) throw new Error('bad ip'); db.prepare('UPDATE sec SET ack=1 WHERE ack=0 AND ip=?').run(String(b.ip)); } else db.prepare('UPDATE sec SET ack=1 WHERE id=?').run(Number(b.id) || 0); return sendJson(res, 200, { ok: true }); }
          if (u.pathname === '/api/secignore') {
            if (!isIPv4(String(b.ip))) throw new Error('bad ip');
            const cur = new Set(CONF.sec.ignore); if (b.ignore) cur.add(b.ip); else cur.delete(b.ip);
            saveConf({ sec: { ignore: [...cur] } }); return sendJson(res, 200, { ok: true });
          }
          if (u.pathname === '/api/config') {
            const num = (v, lo, hi) => { const n = Number(v); if (!Number.isFinite(n) || n < lo || n > hi) throw new Error('bad number'); return n; };
            const a = b.abuse || {}, patch = { abuse: {} };
            for (const [k, lo, hi] of [['busyMB', 0.1, 1000], ['busyMinWarn', 1, 1440], ['staffDayGB', 0.01, 5000], ['guestDayGB', 0.01, 5000], ['uploadGB', 0.01, 5000], ['peerMult', 1, 100], ['minPeerMB', 0, 1e6], ['connWarn', 10, 1e6]]) if (a[k] !== undefined) patch.abuse[k] = num(a[k], lo, hi);
            if (a.hours) {
              const hh = a.hours; if (!['24x7', 'schedule'].includes(hh.mode)) throw new Error('bad working-hours mode');
              const week = {}; for (let d = 0; d < 7; d++) { const w = (hh.week || {})[d] || {}; if (w.on && !(T_OK(w.start) && T_OK(w.end))) throw new Error('bad time (use HH:MM)'); week[d] = { on: !!w.on, start: T_OK(w.start) ? w.start : '08:00', end: T_OK(w.end) ? w.end : '17:00' }; }
              patch.abuse.hours = { mode: hh.mode, week };
            }
            const names = (v) => { if (!Array.isArray(v) || v.length > 20) throw new Error('bad network list'); return v.map((s) => String(s).trim().slice(0, 60)).filter((s) => s && !/[=\n\r]/.test(s)); };
            const ips = (v) => { if (!Array.isArray(v) || v.length > 100) throw new Error('bad address list'); return v.map((s) => String(s).trim()).filter(Boolean).map((s) => { if (!isIPv4(s)) throw new Error('bad address ' + s); return s; }); };
            if (b.staffNetworks) patch.staffNetworks = names(b.staffNetworks);
            if (b.guestNetworks) patch.guestNetworks = names(b.guestNetworks);
            if (b.sec) { patch.sec = {}; if (b.sec.ignore) patch.sec.ignore = ips(b.sec.ignore); if (b.sec.adminIps) patch.sec.adminIps = ips(b.sec.adminIps); }
            saveConf(patch); return sendJson(res, 200, { ok: true });
          }
        } catch (e) { sendJson(res, 200, { ok: false, error: String(e.message || 'failed').slice(0, 200) }); }
      });
      return;
    }
    if (u.pathname === '/api/ring') {
      const ip = u.searchParams.get('ip');
      return sendJson(res, 200, { rows: ip === 'all' ? S.total : (S.ring.get(ip) || []), flows: ip === 'all' ? [] : flowsFor(ip), dev: ip === 'all' ? null : devInfo(ip, {}) });
    }
    if (u.pathname === '/api/history') return sendJson(res, 200, history(u.searchParams.get('ip') || 'all', u.searchParams.get('range') || '24h'));
    if (u.pathname === '/api/ranking') return sendJson(res, 200, ranking(u.searchParams.get('range') || 'today'));
    if (u.pathname === '/api/staff') return sendJson(res, 200, staffReport(u.searchParams));
    if (u.pathname === '/api/persondays') return sendJson(res, 200, personDays(u.searchParams));
    if (u.pathname === '/api/export.csv') {
      const e = exportCsv(u.searchParams);
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="usage-${e.from}_${e.to}.csv"` });
      return res.end('﻿' + e.csv);
    }
    if (u.pathname === '/api/setstaff' && req.method === 'POST') {
      if ((req.headers['content-type'] || '').indexOf('application/json') !== 0 || (req.headers.origin && !hostOk(req.headers.origin.replace(/^https?:\/\//, '')))) { res.writeHead(403); return res.end('forbidden'); }
      let body = ''; req.on('data', (c) => { body += c; if (body.length > 2000) req.destroy(); });
      req.on('end', () => {
        try {
          const { ips, staff } = JSON.parse(body);
          for (const ip of ips) { if (!isIPv4(ip)) throw new Error('bad ip'); if (staff === null) delete staffOv[ip]; else staffOv[ip] = !!staff; }
          fs.writeFileSync(staffFile, JSON.stringify(staffOv, null, 2));
          sendJson(res, 200, { ok: true });
        } catch (e) { sendJson(res, 400, { ok: false }); }
      });
      return;
    }
    if (u.pathname === '/api/name' && req.method === 'POST') {
      if ((req.headers['content-type'] || '').indexOf('application/json') !== 0 || (req.headers.origin && !hostOk(req.headers.origin.replace(/^https?:\/\//, '')))) { res.writeHead(403); return res.end('forbidden'); }
      let body = ''; req.on('data', (c) => { body += c; if (body.length > 2000) req.destroy(); });
      req.on('end', () => {
        try {
          const { ip, name } = JSON.parse(body);
          if (!isIPv4(ip)) throw new Error('bad ip');
          const n = String(name || '').trim().slice(0, 60);
          if (n) overrides[ip] = n; else delete overrides[ip];
          fs.writeFileSync(namesFile, JSON.stringify(overrides, null, 2));
          sendJson(res, 200, { ok: true });
        } catch (e) { sendJson(res, 400, { ok: false }); }
      });
      return;
    }
    // static
    let f = u.pathname === '/' ? '/index.html' : u.pathname;
    const full = path.normalize(path.join(CFG.publicDir, f));
    if (!full.startsWith(CFG.publicDir) || !fs.existsSync(full) || !fs.statSync(full).isFile()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(full).pipe(res);
  } catch (e) { sendJson(res, 500, { error: 'server error' }); }
});
server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `Port ${CFG.httpPort} is already in use (is the monitor already running?)` : e.message); process.exit(1); });
server.listen(CFG.httpPort, '127.0.0.1', () => { console.log(`Collector on http://127.0.0.1:${CFG.httpPort}  (router ${CFG.router}, poll ${CFG.pollMs} ms)`); main(); });
// when started by manager.js, stop if the manager goes away
process.on('disconnect', () => { try { flush(); } catch { /* ignore */ } process.exit(0); });

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { flush(); } catch { /* ignore */ } process.exit(0); });
process.on('exit', () => { try { flush(); } catch { /* ignore */ } });
