'use strict';
// Shared configuration stored ON the router, so every PC that connects to the router gets the same settings
// (organisation, logo, networks, IP / user management, limits, names ...) without running the setup guide again.
//
// Where: /system/script entries named  mtc-cfg-<rev>-<nnn>  (tagged "[mtc-config]"). They live in the router's own configuration
// storage, are never executed (policy=read), and survive reboots. The bundle is JSON -> gzip -> base64, split into chunks small enough
// for every RouterOS version. A new revision is written completely before the older one is removed, so a reader never sees half a file.
// Router logins / passwords are never stored here.

const zlib = require('zlib');
const crypto = require('crypto');

const TAG = '[mtc-config]', CHUNK = 3000, NAME = /^mtc-cfg-([0-9a-z]+)-(\d{3})$/;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

const pack = (obj) => zlib.gzipSync(Buffer.from(JSON.stringify(obj), 'utf8')).toString('base64');
const unpack = (b64) => JSON.parse(zlib.gunzipSync(Buffer.from(b64, 'base64')).toString('utf8'));
const parseComment = (c) => { const o = {}; for (const m of String(c || '').matchAll(/(\w+)=(\S+)/g)) o[m[1]] = m[2]; return o; };
/** hash of the shared content (what must be equal on every PC) */
const contentHash = (content) => sha(JSON.stringify(content));

/** revisions present on the router: [{rev, chunks:[{name,id,i}], n, h, c, by}] newest first, complete ones only */
async function revisions(api, withSource) {
  const rows = await api.run(['/system/script/print', '=.proplist=.id,name,comment' + (withSource ? ',source' : '')]);
  const by = new Map();
  for (const r of rows) {
    const m = NAME.exec(r.name || ''); if (!m) continue;
    const e = by.get(m[1]) || { rev: m[1], chunks: [] }; e.chunks.push({ name: r.name, id: r['.id'], i: +m[2], source: r.source, comment: r.comment }); by.set(m[1], e);
  }
  const list = [...by.values()].map((e) => {
    e.chunks.sort((a, b) => a.i - b.i);
    const meta = parseComment((e.chunks[0] || {}).comment);
    return Object.assign(e, { n: +meta.n || 0, h: meta.h || '', c: meta.c || '', by: meta.by || '', at: +meta.at || 0 });
  });
  const done = list.filter((e) => e.n && e.chunks.length === e.n).sort((a, b) => b.at - a.at || (a.rev < b.rev ? 1 : -1));
  return { done, all: list };
}

/** {rev, c (content hash), by, at} of the newest complete revision, or null. Cheap: no script bodies are read. */
async function meta(api) {
  const { done } = await revisions(api, false);
  const e = done[0]; return e ? { rev: e.rev, c: e.c, by: e.by, at: e.at } : null;
}

/** the newest complete revision, verified: {rev, c, by, at, bundle} or null */
async function read(api) {
  const { done } = await revisions(api, true);
  for (const e of done) {
    const b64 = e.chunks.map((x) => x.source || '').join('');
    if (sha(b64) !== e.h) continue;                     // damaged: try the previous revision
    try { return { rev: e.rev, c: e.c, by: e.by, at: e.at, bundle: unpack(b64) }; } catch { /* next */ }
  }
  return null;
}

/** store bundle = {content, router, lang}; returns {rev, chunks} */
async function write(api, bundle, by) {
  const b64 = pack(bundle), parts = []; for (let i = 0; i < b64.length; i += CHUNK) parts.push(b64.slice(i, i + CHUNK));
  const rev = Date.now().toString(36), at = Date.now(), h = sha(b64), c = contentHash(bundle.content);
  const who = String(by || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 30) || 'pc';
  for (let i = 0; i < parts.length; i++) {
    await api.run(['/system/script/add', '=name=mtc-cfg-' + rev + '-' + String(i).padStart(3, '0'), '=source=' + parts[i], '=policy=read',
      '=comment=' + TAG + (i === 0 ? ` n=${parts.length} h=${h} c=${c} by=${who} at=${at}` : ' part')]);
  }
  const { all } = await revisions(api, false);
  for (const e of all) if (e.rev !== rev) for (const x of e.chunks) { try { await api.run(['/system/script/remove', '=numbers=' + x.id]); } catch { /* ignore */ } }
  return { rev, chunks: parts.length, c };
}

/** remove everything this module stored */
async function clear(api) {
  const { all } = await revisions(api, false); let n = 0;
  for (const e of all) for (const x of e.chunks) { await api.run(['/system/script/remove', '=numbers=' + x.id]); n++; }
  return n;
}

module.exports = { meta, read, write, clear, contentHash, pack, unpack, CHUNK };
