'use strict';
// Router base setup for a fresh (or existing) MikroTik: one description of every router-side change this program needs, used two ways:
//   1. run through the API from the dashboard (preview -> backup export -> apply), and
//   2. exported as a RouterOS script (.rsc) to paste into a terminal or /import (npm run build:rsc writes routeros/mtc-base.rsc).
// Everything created carries a comment starting with "[mtc-...]" so it can be found, listed and removed again; nothing else is ever touched,
// except FastTrack rules, which are only DISABLED (never deleted) and remembered so the rollback can enable them again.
//
// Parts:  block   - "Block internet" for single devices: forward drop rule for the address list MTC-Blocked-Clients
//         ipblock - block internet addresses (attackers): two raw prerouting drop rules for the list MTC-Blocked-IPs
//         fasttrack - disable FastTrack rules (they bypass queues, so speed limits would not work)
//         guest   - an isolated guest network on a free interface: address, DHCP pool + server, NAT, isolation from the private networks

const IFACE = /^[A-Za-z0-9][A-Za-z0-9 ._\-]{0,40}$/;
const CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;
const IP = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const n2ip = (n) => [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255].join('.');
const ip2n = (s) => { const a = s.split('.').map(Number); return (((a[0] << 24) >>> 0) + (a[1] << 16) + (a[2] << 8) + a[3]) >>> 0; };

const DEFAULTS = {
  parts: { block: true, ipblock: true, fasttrack: false, guest: false },
  wan: '',                                // '' = detected default-route interface
  guest: { iface: '', address: '10.77.0.1/24', dns: '', leaseTime: '1h', isolate: true, masquerade: true },
};

function normalize(input) {
  const c = JSON.parse(JSON.stringify(DEFAULTS)), x = input || {};
  if (x.parts) for (const k of Object.keys(c.parts)) if (x.parts[k] !== undefined) c.parts[k] = !!x.parts[k];
  if (x.wan !== undefined) { const w = String(x.wan).trim(); if (w && !IFACE.test(w)) throw new Error('bad WAN interface name'); c.wan = w; }
  if (x.guest) {
    const g = x.guest, o = c.guest;
    if (g.iface !== undefined) { const v = String(g.iface).trim(); if (v && !IFACE.test(v)) throw new Error('bad guest interface name'); o.iface = v; }
    if (g.address !== undefined) {
      const m = CIDR.exec(String(g.address).trim());
      if (!m || [m[1], m[2], m[3], m[4]].some((v) => +v > 255) || +m[5] < 16 || +m[5] > 29) throw new Error('guest address must look like 10.77.0.1/24 (prefix 16-29)');
      const a = +m[1], b = +m[2]; if (!(a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168))) throw new Error('guest address must be a private address (10.x, 172.16-31.x or 192.168.x)');
      o.address = String(g.address).trim();
    }
    if (g.dns !== undefined) { const v = String(g.dns).trim(); if (v && !v.split(',').every((d) => IP.test(d.trim()))) throw new Error('DNS must be IPv4 addresses, comma separated'); o.dns = v.replace(/\s+/g, ''); }
    if (g.leaseTime !== undefined) { const v = String(g.leaseTime).trim(); if (!/^\d{1,3}[mhd]$/.test(v)) throw new Error('lease time like 30m, 1h or 1d'); o.leaseTime = v; }
    if (g.isolate !== undefined) o.isolate = !!g.isolate;
    if (g.masquerade !== undefined) o.masquerade = !!g.masquerade;
  }
  if (c.parts.guest && !c.guest.iface) throw new Error('Choose the interface of the guest network');
  return c;
}

/** network facts of the guest address: {net: '10.77.0.0/24', gw, first, last, bits} */
function guestNet(address) {
  const m = CIDR.exec(address), bits = +m[5], mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0, ip = ip2n(address.split('/')[0]), base = (ip & mask) >>> 0, bcast = (base | (~mask >>> 0)) >>> 0;
  return { net: n2ip(base) + '/' + bits, gw: n2ip(ip), first: n2ip(Math.min(base + 10, bcast - 2)), last: n2ip(bcast - 1), bits };
}

/** The wanted objects. wan = interface name (detected or from the config). */
function desired(cfg, wan) {
  const out = [], W = cfg.wan || wan;
  if (cfg.parts.block) {
    if (!W) throw new Error('Internet (WAN) interface not found: set it in Router setup');
    out.push({ id: 'block', where: 'filter', find: (r) => String(r.comment || '').startsWith('[mtc-block]'), place: 'top-forward',
      text: `+ filter forward: drop traffic of list MTC-Blocked-Clients to the internet (${W}); the list starts empty, nobody is blocked`,
      words: ['/ip/firewall/filter/add', '=chain=forward', '=action=drop', '=src-address-list=MTC-Blocked-Clients', `=out-interface=${W}`, '=comment=[mtc-block] Blocked clients (list MTC-Blocked-Clients) -> internet: drop (manual block from Mikrotik Traffic Control; LAN access unaffected)'] });
  }
  if (cfg.parts.ipblock) {
    if (!W) throw new Error('Internet (WAN) interface not found: set it in Router setup');
    out.push({ id: 'ipblock-in', where: 'raw', find: (r) => String(r.comment || '').startsWith('[mtc-ipblock]') && r['src-address-list'] === 'MTC-Blocked-IPs', place: 'top-raw',
      text: `+ raw prerouting: drop everything from list MTC-Blocked-IPs arriving on ${W}`,
      words: ['/ip/firewall/raw/add', '=chain=prerouting', '=action=drop', '=src-address-list=MTC-Blocked-IPs', `=in-interface=${W}`, '=comment=[mtc-ipblock] Internet -> router/LAN: drop everything from blocked addresses (list MTC-Blocked-IPs)'] });
    out.push({ id: 'ipblock-out', where: 'raw', find: (r) => String(r.comment || '').startsWith('[mtc-ipblock]') && r['dst-address-list'] === 'MTC-Blocked-IPs', place: 'top-raw',
      text: '+ raw prerouting: LAN devices cannot talk to addresses in list MTC-Blocked-IPs',
      words: ['/ip/firewall/raw/add', '=chain=prerouting', '=action=drop', '=dst-address-list=MTC-Blocked-IPs', `=in-interface=!${W}`, '=comment=[mtc-ipblock] LAN -> blocked internet addresses (list MTC-Blocked-IPs): drop'] });
  }
  if (cfg.parts.guest) {
    const g = cfg.guest, n = guestNet(g.address), dns = g.dns || g.address.split('/')[0];
    out.push({ id: 'g-addr', where: 'address', find: (r) => r.address === g.address && r.interface === g.iface || String(r.comment || '').startsWith('[mtc-guest]') && r.interface === g.iface,
      text: `+ address ${g.address} on ${g.iface} (guest network ${n.net})`, words: ['/ip/address/add', `=address=${g.address}`, `=interface=${g.iface}`, '=comment=[mtc-guest] guest network gateway'] });
    out.push({ id: 'g-pool', where: 'pool', find: (r) => r.name === 'mtc-guest-pool',
      text: `+ address pool mtc-guest-pool ${n.first}-${n.last}`, words: ['/ip/pool/add', '=name=mtc-guest-pool', `=ranges=${n.first}-${n.last}`, '=comment=[mtc-guest] guest DHCP pool'] });
    out.push({ id: 'g-net', where: 'dhcpnet', find: (r) => r.address === n.net,
      text: `+ DHCP network ${n.net} gateway ${n.gw} dns ${dns}`, words: ['/ip/dhcp-server/network/add', `=address=${n.net}`, `=gateway=${n.gw}`, `=dns-server=${dns}`, '=comment=[mtc-guest] guest DHCP network'] });
    out.push({ id: 'g-dhcp', where: 'dhcp', find: (r) => r.name === 'mtc-guest-dhcp' || r.interface === g.iface,
      text: `+ DHCP server mtc-guest-dhcp on ${g.iface}, lease ${g.leaseTime}`, words: ['/ip/dhcp-server/add', '=name=mtc-guest-dhcp', `=interface=${g.iface}`, '=address-pool=mtc-guest-pool', `=lease-time=${g.leaseTime}`, '=disabled=no', '=comment=[mtc-guest] guest DHCP server'] });
    if (g.masquerade) {
      if (!W) throw new Error('Internet (WAN) interface not found: set it in Router setup');
      out.push({ id: 'g-nat', where: 'nat', find: (r) => String(r.comment || '').startsWith('[mtc-guest]') && r.action === 'masquerade',
        text: `+ NAT masquerade for ${n.net} out ${W}`, words: ['/ip/firewall/nat/add', '=chain=srcnat', '=action=masquerade', `=src-address=${n.net}`, `=out-interface=${W}`, '=comment=[mtc-guest] guest network -> internet (NAT)'] });
    }
    if (g.isolate) {
      for (const p of ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']) out.push({ id: 'g-pl-' + p, where: 'addrlist', find: (r) => r.list === 'mtc-private' && r.address === p,
        text: `+ address list mtc-private: ${p}`, words: ['/ip/firewall/address-list/add', '=list=mtc-private', `=address=${p}`, '=comment=[mtc-guest] private networks (guests must not reach them)'] });
      out.push({ id: 'g-iso', where: 'filter', find: (r) => String(r.comment || '').startsWith('[mtc-guest]') && r.action === 'drop' && r['src-address'] === n.net, place: 'top-forward',
        text: `+ filter forward: guests (${n.net}) cannot open connections to private networks (internet and the router's hotspot/DNS stay available)`,
        words: ['/ip/firewall/filter/add', '=chain=forward', '=action=drop', `=src-address=${n.net}`, '=dst-address-list=mtc-private', '=comment=[mtc-guest] guests -> private networks: drop'] });
      out.push({ id: 'g-in-drop', where: 'filter', find: (r) => String(r.comment || '').startsWith('[mtc-guest]') && r.chain === 'input' && r.action === 'drop', place: 'top-input',
        text: `+ filter input: guests (${n.net}) can reach the router only for DNS and DHCP (everything else dropped; the hotspot login page keeps working)`,
        words: ['/ip/firewall/filter/add', '=chain=input', '=action=drop', `=src-address=${n.net}`, '=comment=[mtc-guest] guests -> router: drop (DNS/DHCP allowed above)'] });
      out.push({ id: 'g-in-dns', where: 'filter', find: (r) => String(r.comment || '').startsWith('[mtc-guest]') && r.chain === 'input' && r.action === 'accept', place: 'top-input',
        text: `+ filter input: guests (${n.net}) -> router DNS (udp/tcp 53) and DHCP (udp 67) accepted`,
        words: ['/ip/firewall/filter/add', '=chain=input', '=action=accept', `=src-address=${n.net}`, '=protocol=udp', '=dst-port=53,67', '=comment=[mtc-guest] guests -> router: DNS and DHCP accept'] });
    }
  }
  return out;
}

const RESOURCES = {   // where -> API list command + the fields we need
  filter: ['/ip/firewall/filter/print', 'comment,chain,action,disabled,src-address-list,dst-address-list,src-address,protocol,dst-port'],
  raw: ['/ip/firewall/raw/print', 'comment,chain,action,disabled,src-address-list,dst-address-list'],
  nat: ['/ip/firewall/nat/print', 'comment,chain,action,disabled,src-address'],
  addrlist: ['/ip/firewall/address-list/print', 'list,address,comment'],
  address: ['/ip/address/print', 'address,interface,comment'],
  pool: ['/ip/pool/print', 'name,ranges,comment'],
  dhcpnet: ['/ip/dhcp-server/network/print', 'address,gateway,comment'],
  dhcp: ['/ip/dhcp-server/print', 'name,interface,address-pool,disabled,comment'],
};
async function readActual(run, wanted) {
  const need = new Set(wanted.map((w) => w.where)), act = {};
  for (const k of need) { const [cmd, fields] = RESOURCES[k]; act[k] = await run([cmd, '=.proplist=.id,' + fields]); }
  act.fasttrack = (await run(['/ip/firewall/filter/print', '=.proplist=.id,comment,chain,action,disabled', '?action=fasttrack-connection'])).filter((r) => r.disabled !== 'true');
  return act;
}

/** operations still missing. cfg.parts.fasttrack -> one op per enabled FastTrack rule. */
function plan(cfg, des, act) {
  const ops = [], warnings = [];
  for (const d of des) {
    if ((act[d.where] || []).some(d.find)) continue;
    ops.push(d);
  }
  if (cfg.parts.fasttrack) for (const r of act.fasttrack || []) ops.push({ id: 'ft-' + r['.id'], where: 'fasttrack', ftId: r['.id'], text: `~ disable FastTrack rule ${r['.id']} (${String(r.comment || r.chain || '').slice(0, 50)}): it bypasses speed limits`, words: ['/ip/firewall/filter/disable', `=numbers=${r['.id']}`] });
  else if ((act.fasttrack || []).length) warnings.push(`${act.fasttrack.length} FastTrack rule(s) are enabled: fast-tracked traffic bypasses speed limits (queues). Tick "Disable FastTrack" to switch them off (they are only disabled, and can be enabled again).`);
  return { ops, warnings };
}

/** state of every wanted object, for the status table */
function status(des, act) { return des.map((d) => ({ id: d.id, ok: (act[d.where] || []).some(d.find), text: d.text.replace(/^\+ /, '') })); }

/** operations that remove everything we created (objects tagged [mtc-...] of the setup parts) and re-enable FastTrack rules we disabled */
function rollbackOps(act, ftIds) {
  const ops = [], tag = (r) => /^\[mtc-(block|ipblock|guest)\]/.test(String(r.comment || ''));
  const rm = (path, rows) => { for (const r of rows || []) ops.push({ text: `- remove ${path} ${r.comment || r.name || r.address}`.slice(0, 120), words: [path + '/remove', `=numbers=${r['.id']}`] }); };
  rm('/ip/firewall/filter', (act.filter || []).filter(tag)); rm('/ip/firewall/raw', (act.raw || []).filter(tag)); rm('/ip/firewall/nat', (act.nat || []).filter(tag));
  rm('/ip/firewall/address-list', (act.addrlist || []).filter(tag));
  rm('/ip/dhcp-server', (act.dhcp || []).filter(tag)); rm('/ip/dhcp-server/network', (act.dhcpnet || []).filter(tag)); rm('/ip/pool', (act.pool || []).filter(tag)); rm('/ip/address', (act.address || []).filter(tag));
  for (const id of ftIds || []) ops.push({ text: `~ enable FastTrack rule ${id} again`, words: ['/ip/firewall/filter/enable', `=numbers=${id}`] });
  return ops;
}

// ---------------------------------------------------------------- RouterOS script (.rsc) from the same operations
const rscQuote = (v) => '"' + String(v).replace(/(["\\$?])/g, '\\$1').replace(/\[/g, '\\5B').replace(/\]/g, '\\5D') + '"';   // [ ] as hex escapes: no command substitution inside the string
function opToRsc(op) {
  const w = op.words, cmd = w[0].replace(/\//g, ' ').trim(); const params = [];
  for (const x of w.slice(1)) { const m = /^=([^=]+)=(.*)$/.exec(x); if (!m) continue; params.push(m[1] === 'numbers' ? m[2] : `${m[1]}=${/^[A-Za-z0-9_.\/:,!\-]+$/.test(m[2]) ? m[2] : rscQuote(m[2])}`); }
  if (op.place && op.place.startsWith('top-')) params.push('place-before=0');
  return `/${cmd} ${params.join(' ')}`;
}
/** Complete script: safe to run more than once for the objects that have a stable key (existing ones are skipped by the dashboard; here /ip firewall rules are guarded with :if find). */
function toRsc(ops, title) {
  const L = [`# ${title}`, `# Generated by Mikrotik Traffic Control (https://kish-it.com). Review it, then paste it into a RouterOS terminal or upload it and run  /import file-name=<name>.rsc`, `# Every object carries a comment starting with "[mtc-" so it can be found and removed (see mtc-remove.rsc).`, '# Take a backup first:  /export file=before-mtc', ''];
  for (const op of ops) {
    const t = op.text.replace(/^[+~-] /, '');
    L.push(`# ${t}`);
    if (op.where === 'filter' || op.where === 'raw' || op.where === 'nat' || op.where === 'addrlist') {
      const key = (op.words.find((x) => x.startsWith('=comment=')) || '').slice(9);
      const path = op.words[0].replace(/\/add$/, '').replace(/\//g, ' ').trim();
      const extra = op.where === 'addrlist' ? ` address=${(op.words.find((x) => x.startsWith('=address=')) || '').slice(9)} list=${(op.words.find((x) => x.startsWith('=list=')) || '').slice(6)}` : ` comment=${rscQuote(key)}`;
      L.push(`:if ([:len [/${path} find where${extra}]] = 0) do={ ${opToRsc(op)} }`);
    } else L.push(`:do { ${opToRsc(op)} } on-error={ :put "skipped (already done or not possible)" }`);
  }
  return L.join('\n') + '\n';
}

const ALL = Object.keys(RESOURCES).map((where) => ({ where }));
module.exports = { ALL, DEFAULTS, normalize, guestNet, desired, readActual, plan, status, rollbackOps, toRsc, opToRsc };
