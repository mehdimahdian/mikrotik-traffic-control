'use strict';
// Whois / registry information for INTERNET addresses (read-only; nothing is written to the router).
//   lookup(ip)  -> { ip, net, range, country, org, asn, asnName, prefix, abuse, created, changed, source }  (RDAP via rdap.org + ASN via Team Cymru DNS)
//   rawWhois(ip)-> the classic text whois answer (IANA refers to the registry: ARIN / RIPE / APNIC / LACNIC / AFRINIC)
// Only the public address being looked up leaves this PC. Answers are cached by the caller (table ipw).

const https = require('https');
const net = require('net');
const dns = require('dns');

const resolver = new dns.Resolver({ timeout: 3000, tries: 2 });
if (process.env.TM_WHOIS_DNS) resolver.setServers(process.env.TM_WHOIS_DNS.split(','));   // optional: default = system DNS

function getJson(url, redirects = 4) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { Accept: 'application/rdap+json, application/json', 'User-Agent': 'MikroTik-TrafficMonitor/1.0' }, timeout: 8000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume(); return resolve(getJson(new URL(res.headers.location, url).toString(), redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('RDAP HTTP ' + res.statusCode)); }
      let b = ''; res.setEncoding('utf8'); res.on('data', (d) => { b += d; if (b.length > 2e6) req.destroy(new Error('too large')); });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('RDAP timeout')));
    req.on('error', reject);
  });
}

const vcard = (e, key) => { const v = ((e.vcardArray || [])[1] || []).find((x) => x[0] === key); return v ? (Array.isArray(v[3]) ? v[3].join(' ') : String(v[3] || '')) : ''; };
function walkEntities(list, out = []) { for (const e of list || []) { out.push(e); walkEntities(e.entities, out); } return out; }

function parseRdap(j) {
  const ents = walkEntities(j.entities);
  const withRole = (r) => ents.find((e) => (e.roles || []).includes(r));
  const owner = withRole('registrant') || withRole('administrative') || ents.find((e) => vcard(e, 'fn')) || null;
  const abuseEnt = withRole('abuse');
  const ev = (a) => ((j.events || []).find((e) => e.eventAction === a) || {}).eventDate || '';
  const cidr = (j.cidr0_cidrs || []).map((c) => (c.v4prefix || c.v6prefix) + '/' + c.length).join(', ');
  return {
    net: j.name || '', range: j.startAddress && j.endAddress ? j.startAddress + ' - ' + j.endAddress : '', cidr,
    country: j.country || '', type: j.type || '', handle: j.handle || '',
    org: owner ? vcard(owner, 'fn') : '', abuse: abuseEnt ? (vcard(abuseEnt, 'email') || '') : '',
    remarks: ((j.remarks || []).flatMap((r) => r.description || []).join(' ')).slice(0, 300),
    created: ev('registration').slice(0, 10), changed: ev('last changed').slice(0, 10),
  };
}

function txt(name) {
  return new Promise((resolve) => resolver.resolveTxt(name, (err, r) => resolve(err || !r || !r[0] ? '' : r[0].join(''))));
}
// "13335 | 104.16.0.0/13 | US | arin | 2014-03-28"  then  "13335 | US | arin | 2010-07-14 | CLOUDFLARENET, US"
async function asnOf(ip) {
  const rev = ip.split('.').reverse().join('.');
  const a = (await txt(rev + '.origin.asn.cymru.com')).split('|').map((s) => s.trim());
  if (!a[0]) return { asn: '', prefix: '', asnName: '' };
  const asn = a[0].split(' ')[0];
  const b = (await txt('AS' + asn + '.asn.cymru.com')).split('|').map((s) => s.trim());
  return { asn: 'AS' + asn, prefix: a[1] || '', asnName: b[4] || '', cc: a[2] || '' };
}

async function lookup(ip) {
  const out = { ip, net: '', range: '', cidr: '', country: '', org: '', asn: '', asnName: '', prefix: '', abuse: '', created: '', changed: '', remarks: '', error: '' };
  const [r, a] = await Promise.allSettled([getJson('https://rdap.org/ip/' + ip), asnOf(ip)]);
  if (r.status === 'fulfilled') Object.assign(out, parseRdap(r.value)); else out.error = String(r.reason && r.reason.message || r.reason);
  if (a.status === 'fulfilled') { Object.assign(out, a.value); if (!out.country && a.value.cc) out.country = a.value.cc; }
  delete out.cc;
  if (!out.org && out.asnName) out.org = out.asnName.replace(/,\s*[A-Z]{2}$/, '');
  if (r.status === 'rejected' && a.status === 'fulfilled' && out.asn) out.error = '';   // ASN answer is enough to be useful
  out.ts = Math.floor(Date.now() / 1000);
  return out;
}

function whoisQuery(server, query, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: server, port: 43, timeout }); let b = '';
    s.on('connect', () => s.write(query + '\r\n'));
    s.on('data', (d) => { b += d.toString('utf8'); if (b.length > 200000) s.destroy(); });
    s.on('end', () => resolve(b)); s.on('close', () => resolve(b));
    s.on('timeout', () => s.destroy(new Error('whois timeout'))); s.on('error', reject);
  });
}
async function rawWhois(ip) {
  const iana = await whoisQuery('whois.iana.org', ip);
  const m = /^(?:refer|whois):\s*(\S+)/im.exec(iana);
  const server = m ? m[1] : 'whois.iana.org';
  if (!m) return { server, text: iana };
  // ARIN wants "n + <ip>" for a plain network answer; the others take the address as is
  const q = /arin/i.test(server) ? 'n + ' + ip : /ripe|apnic|afrinic/i.test(server) ? ip : ip;
  let text = await whoisQuery(server, q);
  const re = /^ReferralServer:\s*r?whois:\/\/([^\s:/]+)/im.exec(text);      // ARIN may hand over to another registry
  if (re && re[1] !== server) { try { text = await whoisQuery(re[1], ip); return { server: re[1], text }; } catch { /* keep ARIN text */ } }
  return { server, text };
}

module.exports = { lookup, rawWhois };
