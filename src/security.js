'use strict';
// Detects scanning / intrusion-like behaviour of one INTERNAL device from one poll of the router's connection table.
// st = { conns, unrep, udsts:Set, lanUnrep:Set, lan:Set, perDst:Map('ip:port'->n), unrepPorts:Map(port->n), routerHits:Map(port->n) }
// Returns a list of { kind, sev, detail, minStreak } (minStreak = polls in a row before an event is raised).

const SENSITIVE = new Set([21, 22, 23, 445, 1433, 3306, 3389, 5432, 5900, 8291, 8728, 8729, 6870]);
const COMMON = new Set([53, 80, 123, 443, 8080]);

function topPorts(map, n = 5) { return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([p]) => p).join(','); }

function detect(st, T, ctx) {
  const out = [];
  if (st.unrep >= T.scanUnrep && st.udsts.size >= T.scanHosts) {
    out.push({ kind: 'scan', sev: st.unrep >= T.scanUnrep * 5 ? 'high' : 'medium', minStreak: 2,
      detail: `${st.unrep} unanswered connection attempts to ${st.udsts.size} different hosts (ports ${topPorts(st.unrepPorts)}) - looks like a port/host scan` });
  }
  if (st.lanUnrep.size >= T.lanHosts) {
    out.push({ kind: 'lan-scan', sev: 'high', minStreak: 2,
      detail: `${st.lanUnrep.size} internal hosts did not answer this device's connection attempts (ports ${topPorts(st.unrepPorts)}) - scanning the local network` });
  } else if (st.lan.size >= T.fanout) {
    out.push({ kind: 'lan-sweep', sev: 'medium', minStreak: 3, detail: `talking to ${st.lan.size} different internal hosts at once` });
  }
  let best = null;
  for (const [k, n] of st.perDst) {
    const port = +k.slice(k.lastIndexOf(':') + 1);
    const limit = SENSITIVE.has(port) ? T.bruteConns : COMMON.has(port) ? Infinity : T.bruteConns * 8;
    if (n >= limit && (!best || n > best.n)) best = { k, n, port };
  }
  if (best) {
    const dst = best.k.slice(0, best.k.lastIndexOf(':'));
    out.push({ kind: 'brute-force', sev: ctx.isPrivate(dst) && SENSITIVE.has(best.port) ? 'high' : 'medium', minStreak: 2,
      detail: `${best.n} simultaneous connections to ${dst}:${best.port} - brute-force / flood pattern` });
  }
  if (st.conns >= T.maxConns) out.push({ kind: 'many-connections', sev: 'medium', minStreak: 3, detail: `${st.conns} concurrent connections (torrent, flood or infected device)` });
  if (st.routerHits.size && !ctx.isAdmin) {
    out.push({ kind: 'router-probe', sev: 'high', minStreak: 1, detail: `connecting to router management ports (${topPorts(st.routerHits, 8)}) - not an admin PC` });
  }
  return out;
}

module.exports = { detect, SENSITIVE };
