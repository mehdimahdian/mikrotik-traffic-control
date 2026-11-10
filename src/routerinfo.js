'use strict';
// Router discovery used by the first-run wizard (manager.js) and by the collector (server.js).

const isIPv4 = (s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(String(s));

/** The internet-facing interface = interface of the active default route (PPPoE, DHCP, static, LTE, VLAN, bridge...). '' if none is found. */
async function detectWan(api) {
  try {
    const rt = await api.run(['/ip/route/print', '=.proplist=dst-address,gateway,immediate-gw,gateway-status,active,distance,vrf-interface,routing-table', '?dst-address=0.0.0.0/0']);
    const act = rt.filter((r) => r.active === 'true' && (!r['routing-table'] || r['routing-table'] === 'main')).sort((a, b) => (+a.distance || 0) - (+b.distance || 0));
    for (const r of act) {
      const gw = String(r['immediate-gw'] || ''), i = gw.indexOf('%'); if (i >= 0) return gw.slice(i + 1);
      const m = /via (\S+)/.exec(String(r['gateway-status'] || '')); if (m) return m[1];
      if (r['vrf-interface']) return r['vrf-interface'];
      if (r.gateway && !isIPv4(r.gateway)) return r.gateway;
    }
  } catch { /* fall through */ }
  try { const pp = await api.run(['/interface/pppoe-client/print', '=.proplist=name,running']); const run = pp.find((r) => r.running === 'true'); if (run) return run.name; } catch { /* ignore */ }
  try { const dc = await api.run(['/ip/dhcp-client/print', '=.proplist=interface,status']); const b = dc.find((r) => r.status === 'bound'); if (b) return b.interface; } catch { /* ignore */ }
  return '';
}

const NEEDED = ['read', 'write', 'api'];
/** Everything the wizard shows about a router. `api` is a connected RosApi; `user` is the login in use. Read-only. */
async function inspect(api, user) {
  const out = { identity: '', version: '', board: '', wan: '', pcAddress: '', networks: [], dhcp: [], fastTrack: 0, mtcObjects: 0, policy: { group: '', missing: [], ok: true }, warnings: [] };
  const safe = async (words) => { try { return await api.run(words); } catch { return null; } };
  const id = await safe(['/system/identity/print']); out.identity = (id && id[0] && id[0].name) || '';
  const res = await safe(['/system/resource/print']); if (res && res[0]) { out.version = res[0].version || ''; out.board = res[0]['board-name'] || ''; }
  out.pcAddress = (api.sock && api.sock.localAddress) || '';
  out.wan = await detectWan(api);
  const ifs = (await safe(['/interface/print', '=.proplist=name,type,running,disabled,comment'])) || [];
  const addr = (await safe(['/ip/address/print', '=.proplist=address,network,interface,disabled'])) || [];
  const dhcp = (await safe(['/ip/dhcp-server/print', '=.proplist=name,interface,address-pool,disabled'])) || [];
  out.dhcp = dhcp.map((d) => ({ name: d.name, interface: d.interface, pool: d['address-pool'], disabled: d.disabled === 'true' }));
  const byIf = new Map(ifs.map((i) => [i.name, i]));
  for (const a of addr.filter((r) => r.disabled !== 'true' && r.address)) {
    const i = byIf.get(a.interface) || {}, [ip, bits] = a.address.split('/');
    out.networks.push({ iface: a.interface, address: a.address, ip, bits: +bits, network: a.network, type: i.type || '', running: i.running === 'true', comment: i.comment || '',
      isWan: a.interface === out.wan, hasDhcp: dhcp.some((d) => d.interface === a.interface && d.disabled !== 'true'),
      private: /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) });
  }
  const ft = await safe(['/ip/firewall/filter/print', '=.proplist=action,disabled', '?action=fasttrack-connection']); out.fastTrack = (ft || []).filter((r) => r.disabled !== 'true').length;
  let mtc = 0;
  for (const [cmd] of [['/ip/firewall/filter/print'], ['/ip/firewall/raw/print'], ['/ip/firewall/nat/print'], ['/queue/simple/print']]) { const r = await safe([cmd, '=.proplist=comment,name']); mtc += (r || []).filter((x) => /^\[mtc-/.test(x.comment || '') || /^mtc-/.test(x.name || '')).length; }
  out.mtcObjects = mtc;
  // permissions of the login in use
  const u = await safe(['/user/print', '=.proplist=name,group', '?name=' + user]);
  if (u && u[0]) {
    out.policy.group = u[0].group;
    const g = await safe(['/user/group/print', '=.proplist=name,policy', '?name=' + u[0].group]);
    if (g && g[0]) { const have = new Set(String(g[0].policy).split(',').map((s) => s.trim())); out.policy.missing = NEEDED.filter((p) => !have.has(p)); out.policy.ok = out.policy.missing.length === 0; }
  }
  const ntp = await safe(['/system/ntp/client/print']);
  if (ntp && ntp[0] && ntp[0].enabled === 'false') out.warnings.push('ntp-off');
  if (!out.wan) out.warnings.push('no-wan');
  if (out.fastTrack) out.warnings.push('fasttrack');
  if (!out.policy.ok) out.warnings.push('policy');
  return out;
}

/** Create the least-privilege group + user for this program (needs a login that may manage users). Returns {user}. */
async function provisionUser(api, { user, password, address }) {
  const grp = 'mtc';
  const g = await api.run(['/user/group/print', '=.proplist=.id,name,policy', '?name=' + grp]);
  const policy = 'read,write,api,test,ftp,policy,sensitive';
  if (g[0]) await api.run(['/user/group/set', '=numbers=' + g[0]['.id'], '=policy=' + policy]);
  else await api.run(['/user/group/add', '=name=' + grp, '=policy=' + policy, '=comment=Mikrotik Traffic Control']);
  const ex = await api.run(['/user/print', '=.proplist=.id,name', '?name=' + user]);
  const words = ['=name=' + user, '=group=' + grp, '=password=' + password, '=comment=Mikrotik Traffic Control (API only)'];
  if (address) words.push('=address=' + address);
  if (ex[0]) await api.run(['/user/set', '=numbers=' + ex[0]['.id'], ...words.filter((w) => !w.startsWith('=name='))]);
  else await api.run(['/user/add', ...words]);
  return { user };
}

module.exports = { detectWan, inspect, provisionUser, NEEDED };
