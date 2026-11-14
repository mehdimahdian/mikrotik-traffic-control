'use strict';
// RouterOS REST API client (RouterOS 7.1+, the "www" / "www-ssl" services = the same web interface WebFig uses).
// Used only to bootstrap: when the normal API (port 8728) is off or refuses the account, an administrator login over the web service
// can switch the API service on and create the program's own limited API user. After that everything runs over the normal API.
// Zero dependencies (node http / https). The router's HTTPS certificate is self-signed by default, so it is not verified here;
// the login is sent over the LAN to the address you typed, the same trust as plain API.

const http = require('http');
const https = require('https');

class RestApi {
  constructor(host, port, tls, user, pw) { Object.assign(this, { host, port, tls: !!tls, user, pw }); this.local = ''; }
  request(method, p, body) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
      const opts = { host: this.host, port: this.port, path: '/rest' + p, method, timeout: 7000,
        auth: this.user + ':' + this.pw, headers: Object.assign({ Accept: 'application/json' }, data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) };
      if (this.tls) opts.rejectUnauthorized = false;
      const req = (this.tls ? https : http).request(opts, (res) => {
        this.local = (res.socket && res.socket.localAddress) || this.local;
        let b = ''; res.on('data', (c) => (b += c));
        res.on('end', () => {
          let j; try { j = b ? JSON.parse(b) : null; } catch { j = null; }
          if (res.statusCode === 401) return reject(new Error('invalid user name or password (REST 401)'));
          if (res.statusCode === 404 && !j) return reject(new Error('REST API not available on this port'));
          if (res.statusCode >= 400) return reject(new Error((j && (j.detail || j.message)) || 'REST error ' + res.statusCode));
          resolve(j);
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }
  get(p) { return this.request('GET', p); }
}

/** Find a working REST endpoint for this login: [{port, tls}] tried in order. Returns the RestApi or throws the most useful error. */
async function connect(host, user, pw, ports) {
  let best = null;
  for (const [port, tls] of ports) {
    const r = new RestApi(host, port, tls, user, pw);
    try { await r.get('/system/identity'); return r; }
    catch (e) { if (/invalid user name or password/.test(e.message)) throw e; if (!best) best = e; }
  }
  throw best || new Error('REST API not available');
}

/** Switch the API service on (for this PC) and create the limited group + user. Returns {pcAddress}. */
async function bootstrap(rest, { user, password, policy }) {
  const pc = rest.local && rest.local.replace(/^::ffff:/, '');
  const one = async (p) => { const r = await rest.get(p); return Array.isArray(r) ? r[0] : r; };
  const g = await one('/user/group?name=mtc');
  if (g) await rest.request('PATCH', '/user/group/' + encodeURIComponent(g['.id']), { policy });
  else await rest.request('PUT', '/user/group', { name: 'mtc', policy, comment: 'Mikrotik Traffic Control' });
  const u = await one('/user?name=' + encodeURIComponent(user));
  const fields = { group: 'mtc', password, comment: 'Mikrotik Traffic Control (API only)' };
  if (u) await rest.request('PATCH', '/user/' + encodeURIComponent(u['.id']), fields);
  else await rest.request('PUT', '/user', Object.assign({ name: user }, fields));
  const svc = await one('/ip/service?name=api');
  if (svc) {
    const patch = { disabled: 'false' };
    const addr = String(svc.address || '').split(',').map((x) => x.trim()).filter(Boolean);   // keep an existing allow-list, but let this PC in
    if (addr.length && pc && !addr.some((a) => a === pc || a === pc + '/32')) patch.address = addr.concat(pc + '/32').join(',');
    await rest.request('PATCH', '/ip/service/' + encodeURIComponent(svc['.id']), patch);
  }
  return { pcAddress: pc || '' };
}

module.exports = { RestApi, connect, bootstrap };
