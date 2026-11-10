'use strict';
// Bandwidth control through MikroTik simple queues (INTERNET ONLY: every queue has dst = the PPPoE/WAN interface).
//   group queue  "mtc-group-<id>"  target = the group's networks, queue type PCQ per address = every device in the network
//                                  gets its own default rate (the "regular rule for each user"); new devices are covered at once.
//   device queue "mtc-dev-<ip>"    one device (manual, auto-throttle or from a user entry); placed ABOVE the group queues
//                                  so it wins; max-limit 0/0 = exempt (unlimited).
//   queue types  "mtc-up-<profile>" / "mtc-down-<profile>" (kind pcq, pcq-rate = the profile rate).
// Everything created has a comment starting with "[mtc-qos]" and a name starting with "qos-".

const RATE = /^(\d+(?:\.\d+)?)([kKmMgG]?)$/;
const ID = /^[a-z0-9][a-z0-9-]{0,23}$/;
const NET = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/;

function rateBps(s) {
  if (typeof s === 'number') return s;
  const m = RATE.exec(String(s).trim()); if (!m) return NaN;
  const u = m[2].toLowerCase();
  return Math.round(+m[1] * (u === 'g' ? 1e9 : u === 'm' ? 1e6 : u === 'k' ? 1e3 : 1));
}
const fmtRate = (bps) => (bps === 0 ? 'unlimited' : bps >= 1e9 ? +(bps / 1e9).toFixed(2) + 'G' : bps >= 1e6 ? +(bps / 1e6).toFixed(2) + 'M' : bps >= 1e3 ? +(bps / 1e3).toFixed(0) + 'k' : bps + 'bps');
function isPrivateNet(s) {
  const m = NET.exec(s); if (!m) return false;
  const a = +m[1], b = +m[2], bits = m[5] === undefined ? 32 : +m[5];
  if ([a, b, +m[3], +m[4]].some((x) => x > 255) || bits > 32 || bits < 8) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

const DEFAULTS = {
  enabled: false,                       // master switch: while false every [mtc-qos] queue on the router is disabled
  wan: '',                              // '' = detect the running PPPoE client
  profiles: {
    'staff-default': { name: 'Staff default (per device)', down: '20M', up: '10M' },
    'guest-default': { name: 'Guest default (per device)', down: '4M', up: '2M' },
    vip: { name: 'VIP', down: '50M', up: '25M' },
    throttled: { name: 'Throttled', down: '1M', up: '512k' },
    unlimited: { name: 'Unlimited (exempt)', down: '0', up: '0' },
  },
  groups: [],                           // created from the networks you mark as staff / guest (see server.js ensureQosGroups) and editable in Configuration
  devices: {},                          // ip -> {profile, custom:{down,up}|null, note, until(epoch s, 0 = no end), source: manual|auto}
  users: {},                            // name -> {ips:[], profile, note}
  auto: { enabled: false, downMbps: 15, minutes: 5, profile: 'throttled', forMinutes: 60, groups: ['Guest'] },
  // Usage quota: a device whose INTERNET download or upload in the period passes a limit gets the profile for forMinutes (default 24 h).
  // days = 1 -> the calendar day (resets at midnight); days = N -> today + the previous N-1 days. A limit of 0 = not checked.
  quota: { enabled: false, days: 1, downGB: 20, upGB: 5, totalGB: 0, profile: 'throttled', forMinutes: 1440, groups: ['Guest'], exempt: [] },
};

/** Validate + normalise a config; throws Error(message) on bad input. */
function normalize(input) {
  const c = JSON.parse(JSON.stringify(DEFAULTS)), x = input || {};
  if (x.enabled !== undefined) c.enabled = !!x.enabled;
  if (x.wan !== undefined) { const w = String(x.wan).trim(); if (w.length > 60 || /[=\n\r]/.test(w)) throw new Error('bad WAN interface name'); c.wan = w; }
  if (x.profiles) {
    c.profiles = {}; const ids = Object.keys(x.profiles); if (ids.length > 30) throw new Error('too many profiles');
    for (const id of ids) {
      if (!ID.test(id)) throw new Error('profile id must be a-z, 0-9, dash: ' + id);
      const p = x.profiles[id], down = String(p.down).trim(), up = String(p.up).trim();
      if (!Number.isFinite(rateBps(down)) || !Number.isFinite(rateBps(up))) throw new Error(`bad rate in profile ${id} (use e.g. 4M, 512k, 0 = unlimited)`);
      c.profiles[id] = { name: String(p.name || id).slice(0, 40), down, up };
    }
  }
  const hasProfile = (id) => Object.prototype.hasOwnProperty.call(c.profiles, id);
  if (x.groups) {
    if (!Array.isArray(x.groups) || x.groups.length > 10) throw new Error('too many groups');
    const seen = new Set();
    c.groups = x.groups.map((g) => {
      if (!ID.test(g.id) || seen.has(g.id)) throw new Error('bad or duplicate group id: ' + g.id); seen.add(g.id);
      const targets = (g.targets || []).map((t) => String(t).trim()).filter(Boolean);
      if (!targets.length || targets.length > 10 || !targets.every(isPrivateNet)) throw new Error(`group ${g.id}: targets must be private networks like 192.168.88.0/24`);
      if (!hasProfile(g.profile)) throw new Error(`group ${g.id}: unknown profile ${g.profile}`);
      return { id: g.id, name: String(g.name || g.id).slice(0, 40), targets, profile: g.profile, enabled: g.enabled !== false };
    });
  }
  if (x.devices) {
    const ips = Object.keys(x.devices); if (ips.length > 500) throw new Error('too many device overrides');
    c.devices = {};
    for (const ip of ips) {
      const d = x.devices[ip];
      if (!isPrivateNet(ip) || ip.includes('/')) throw new Error('bad device address ' + ip);
      let custom = null;
      if (d.custom) { if (!Number.isFinite(rateBps(d.custom.down)) || !Number.isFinite(rateBps(d.custom.up))) throw new Error('bad custom rate for ' + ip); custom = { down: String(d.custom.down), up: String(d.custom.up) }; }
      else if (!hasProfile(d.profile)) throw new Error(`device ${ip}: unknown profile ${d.profile}`);
      c.devices[ip] = { profile: custom ? '' : d.profile, custom, note: String(d.note || '').slice(0, 60), until: Math.max(0, Math.floor(Number(d.until) || 0)), source: d.source === 'auto' || d.source === 'quota' ? d.source : 'manual' };
    }
  }
  if (x.users) {
    const names = Object.keys(x.users); if (names.length > 200) throw new Error('too many users');
    c.users = {};
    for (const n of names) {
      const u = x.users[n]; if (!n.trim() || n.length > 40) throw new Error('bad user name');
      const ips = (u.ips || []).map((s) => String(s).trim()).filter(Boolean);
      if (ips.length > 20 || !ips.every((ip) => isPrivateNet(ip) && !ip.includes('/'))) throw new Error(`user ${n}: bad device address`);
      if (!hasProfile(u.profile)) throw new Error(`user ${n}: unknown profile ${u.profile}`);
      c.users[n] = { ips, profile: u.profile, note: String(u.note || '').slice(0, 60) };
    }
  }
  if (x.auto) {
    const a = x.auto, num = (v, lo, hi, nm) => { const n = Number(v); if (!Number.isFinite(n) || n < lo || n > hi) throw new Error('auto-throttle: bad ' + nm); return n; };
    if (!hasProfile(a.profile)) throw new Error('auto-throttle: unknown profile');
    c.auto = { enabled: !!a.enabled, downMbps: num(a.downMbps, 1, 10000, 'Mbps'), minutes: num(a.minutes, 1, 15, 'minutes (1-15)'), profile: a.profile, forMinutes: num(a.forMinutes, 5, 1440, 'duration'),
      groups: (Array.isArray(a.groups) ? a.groups : []).map(String).slice(0, 12) };
  } else if (!hasProfile(c.auto.profile)) c.auto.profile = Object.keys(c.profiles)[0];
  if (x.quota) {
    const q = x.quota, num = (v, lo, hi, nm) => { const n = Number(v); if (!Number.isFinite(n) || n < lo || n > hi) throw new Error('usage quota: bad ' + nm); return n; };
    if (!hasProfile(q.profile)) throw new Error('usage quota: unknown profile');
    const exempt = (Array.isArray(q.exempt) ? q.exempt : []).map((s) => String(s).trim()).filter(Boolean).slice(0, 100);
    if (!exempt.every((ip) => isPrivateNet(ip) && !ip.includes('/'))) throw new Error('usage quota: exempt list must be device addresses like 192.168.88.55');
    c.quota = { enabled: !!q.enabled, days: Math.round(num(q.days, 1, 31, 'period (1-31 days)')), downGB: num(q.downGB, 0, 100000, 'download GB'), upGB: num(q.upGB, 0, 100000, 'upload GB'),
      totalGB: num(q.totalGB || 0, 0, 100000, 'total GB'), profile: q.profile, forMinutes: Math.round(num(q.forMinutes, 5, 10080, 'duration (5 min - 7 days)')),
      groups: (Array.isArray(q.groups) ? q.groups : []).map(String).slice(0, 12), exempt };
    if (c.quota.enabled && !c.quota.downGB && !c.quota.upGB && !c.quota.totalGB) throw new Error('usage quota: set at least one limit above 0');
  } else if (!hasProfile(c.quota.profile)) c.quota.profile = hasProfile(c.auto.profile) ? c.auto.profile : Object.keys(c.profiles)[0];
  return c;
}

const devMax = (cfg, d) => { const p = d.custom || cfg.profiles[d.profile]; return { down: p.down, up: p.up }; };
const profileOfUserIp = (cfg, ip) => { for (const [n, u] of Object.entries(cfg.users)) if (u.ips.includes(ip)) return { name: n, profile: u.profile }; return null; };

/** What should exist on the router. */
function desired(cfg, wan, nowSec) {
  const types = new Map(), groups = [], devices = [];
  for (const g of cfg.groups) {
    const p = cfg.profiles[g.profile];
    for (const [dir, rate, cls] of [['up', p.up, 'src-address'], ['down', p.down, 'dst-address']]) types.set(`qos-${dir}-${g.profile}`, { name: `qos-${dir}-${g.profile}`, rate: rateBps(rate), cls });
    groups.push({ name: `mtc-group-${g.id}`, target: g.targets.join(','), dst: wan, queue: `mtc-up-${g.profile}/mtc-down-${g.profile}`, disabled: !(cfg.enabled && g.enabled),
      comment: `[mtc-qos] group ${g.id}: ${g.name} - default ${p.down} down / ${p.up} up per device, internet only` });
  }
  const eff = new Map();
  for (const [name, u] of Object.entries(cfg.users)) for (const ip of u.ips) eff.set(ip, { profile: u.profile, custom: null, until: 0, label: `user ${name}`, source: 'user' });
  for (const [ip, d] of Object.entries(cfg.devices)) if (!d.until || d.until > nowSec) eff.set(ip, { profile: d.profile, custom: d.custom, until: d.until, label: d.note || 'device', source: d.source });
  for (const [ip, d] of eff) {
    const m = devMax(cfg, d);
    devices.push({ name: `mtc-dev-${ip}`, ip, target: ip + '/32', dst: wan, max: `${rateBps(m.up)}/${rateBps(m.down)}`, disabled: !cfg.enabled,
      comment: `[mtc-qos] dev ${String(d.label).replace(/[^\w .\-()]/g, '')} (${d.source}${d.until ? ', until ' + d.until : ''}) ${d.profile || 'custom'} ${m.down} down / ${m.up} up` });
  }
  return { types: [...types.values()], groups, devices };
}

const pair = (s) => String(s || '0/0').split('/').map((v) => (Number.isFinite(rateBps(v)) ? rateBps(v) : 0)).join('/');
const asBool = (v) => v === true || v === 'true' || v === 'yes';

/** Compare desired with the router's actual [mtc-qos] objects; returns operations in a safe order. */
function plan(des, actual) {
  const ops = [], warnings = [];
  const aTypes = new Map(actual.types.map((t) => [t.name, t])), aQ = new Map(actual.queues.map((q) => [q.name, q]));
  for (const t of des.types) {
    const a = aTypes.get(t.name);
    if (!a) ops.push({ text: `+ queue type ${t.name}: pcq per ${t.cls}, rate ${fmtRate(t.rate)}`, words: ['/queue/type/add', `=name=${t.name}`, '=kind=pcq', `=pcq-classifier=${t.cls}`, `=pcq-rate=${t.rate}`, '=pcq-limit=50', '=pcq-total-limit=2000'] });
    else if (rateBps(a['pcq-rate']) !== t.rate || a['pcq-classifier'] !== t.cls) ops.push({ text: `~ queue type ${t.name}: rate ${fmtRate(rateBps(a['pcq-rate']))} -> ${fmtRate(t.rate)}`, words: ['/queue/type/set', `=.id=${a['.id']}`, `=pcq-rate=${t.rate}`, `=pcq-classifier=${t.cls}`] });
  }
  for (const g of des.groups) {
    const a = aQ.get(g.name), dis = g.disabled ? 'yes' : 'no';
    if (!a) ops.push({ text: `+ group queue ${g.name}: ${g.target} -> internet (${g.queue}), ${g.disabled ? 'DISABLED' : 'ENABLED'}`, words: ['/queue/simple/add', `=name=${g.name}`, `=target=${g.target}`, `=dst=${g.dst}`, `=queue=${g.queue}`, '=max-limit=0/0', `=disabled=${dis}`, `=comment=${g.comment}`] });
    else if (a.target !== g.target || a.dst !== g.dst || a.queue !== g.queue || asBool(a.disabled) !== g.disabled) ops.push({ text: `~ group queue ${g.name}: ${g.disabled ? 'disable' : 'enable'}, ${g.target}, ${g.queue}`, words: ['/queue/simple/set', `=.id=${a['.id']}`, `=target=${g.target}`, `=dst=${g.dst}`, `=queue=${g.queue}`, `=disabled=${dis}`, `=comment=${g.comment}`] });
  }
  const wantDev = new Set(des.devices.map((d) => d.name));
  for (const d of des.devices) {
    const a = aQ.get(d.name), dis = d.disabled ? 'yes' : 'no';
    if (!a) ops.push({ text: `+ device queue ${d.name}: max ${d.max} (up/down, bit/s)${d.disabled ? ' DISABLED' : ''}`, place: 'first-group', words: ['/queue/simple/add', `=name=${d.name}`, `=target=${d.target}`, `=dst=${d.dst}`, `=max-limit=${d.max}`, `=disabled=${dis}`, `=comment=${d.comment}`] });
    else if (pair(a['max-limit']) !== d.max || a.dst !== d.dst || asBool(a.disabled) !== d.disabled) ops.push({ text: `~ device queue ${d.name}: max ${pair(a['max-limit'])} -> ${d.max}${d.disabled ? ' (disabled)' : ''}`, words: ['/queue/simple/set', `=.id=${a['.id']}`, `=max-limit=${d.max}`, `=dst=${d.dst}`, `=disabled=${dis}`, `=comment=${d.comment}`] });
  }
  const wantG = new Set(des.groups.map((g) => g.name)), wantT = new Set(des.types.map((t) => t.name));
  for (const q of actual.queues) if (!wantG.has(q.name) && !wantDev.has(q.name)) ops.push({ text: `- remove queue ${q.name}`, words: ['/queue/simple/remove', `=numbers=${q['.id']}`] });
  for (const t of actual.types) if (!wantT.has(t.name)) ops.push({ text: `- remove queue type ${t.name}`, after: true, words: ['/queue/type/remove', `=numbers=${t['.id']}`] });
  // removal of queues first would be unsafe for types in use: types are removed last (flag "after")
  ops.sort((a, b) => (a.after ? 1 : 0) - (b.after ? 1 : 0));
  const nets = des.groups.filter((g) => !g.disabled);
  if (des.groups.some((g) => g.target.split(',').some((t) => des.groups.some((h) => h !== g && h.target.split(',').includes(t))))) warnings.push('Two groups share the same network: the first queue in the list wins.');
  return { ops, warnings, enabledGroups: nets.length };
}

module.exports = { DEFAULTS, normalize, desired, plan, rateBps, fmtRate, devMax, profileOfUserIp, isPrivateNet };
