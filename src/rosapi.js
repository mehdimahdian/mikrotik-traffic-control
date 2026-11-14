'use strict';
const net = require('net');

// ---------------------------------------------------------------- RouterOS API client
function encLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  if (n < 0x4000) return Buffer.from([(n >> 8) | 0x80, n & 255]);
  if (n < 0x200000) return Buffer.from([(n >> 16) | 0xc0, (n >> 8) & 255, n & 255]);
  return Buffer.from([(n >> 24) | 0xe0, (n >> 16) & 255, (n >> 8) & 255, n & 255]);
}
function encSentence(words) {
  const parts = [];
  for (const w of words) { const b = Buffer.from(w, 'utf8'); parts.push(encLen(b.length), b); }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}
function parseSentence(buf) {
  let p = 0; const words = [];
  for (;;) {
    if (p >= buf.length) return null;
    const c = buf[p]; let len, n;
    if (c < 0x80) { len = c; n = 1; }
    else if (c < 0xc0) { if (p + 2 > buf.length) return null; len = ((c & 0x3f) << 8) | buf[p + 1]; n = 2; }
    else if (c < 0xe0) { if (p + 3 > buf.length) return null; len = ((c & 0x1f) << 16) | (buf[p + 1] << 8) | buf[p + 2]; n = 3; }
    else if (c < 0xf0) { if (p + 4 > buf.length) return null; len = ((c & 0x0f) << 24) | (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3]; n = 4; }
    else { if (p + 5 > buf.length) return null; len = buf.readUInt32BE(p + 1); n = 5; }
    p += n;
    if (len === 0) return { words, used: p };
    if (p + len > buf.length) return null;
    words.push(buf.toString('utf8', p, p + len)); p += len;
  }
}

class RosApi {
  constructor(host, port, user, pw) { Object.assign(this, { host, port, user, pw }); this.chain = Promise.resolve(); this.cur = null; this.sock = null; }
  connect() {
    return new Promise((resolve, reject) => {
      const s = net.connect({ host: this.host, port: this.port });
      this.sock = s; this.buf = Buffer.alloc(0); this.cur = null;
      let up = false;
      s.setNoDelay(true);
      s.setTimeout(30000, () => s.destroy(new Error('API timeout')));
      s.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this._drain(); });
      s.on('error', (e) => { if (!up) reject(e); this._fail(e); });
      s.on('close', () => { this._fail(new Error('API connection closed')); });
      s.on('connect', async () => {
        up = true;
        try { await this._exec(['/login', '=name=' + this.user, '=password=' + this.pw]); resolve(); }
        catch (e) { s.destroy(); reject(new Error('API login failed: ' + String(e.message || '').replace(/password=\S+/gi, ''))); }
      });
    });
  }
  close() { if (this.sock) this.sock.destroy(); }
  _fail(e) { const c = this.cur; this.cur = null; if (c) c.reject(e); }
  _drain() {
    for (;;) {
      const r = parseSentence(this.buf);
      if (!r) return;
      this.buf = this.buf.subarray(r.used);
      this._onSentence(r.words);
    }
  }
  _onSentence(words) {
    const c = this.cur; if (!c) return;
    const type = words[0];
    const o = {};
    for (let i = 1; i < words.length; i++) {
      const w = words[i];
      if (w[0] !== '=') continue;
      const j = w.indexOf('=', 1);
      if (j > 0) o[w.slice(1, j)] = w.slice(j + 1);
    }
    if (type === '!re') c.rows.push(o);
    else if (type === '!trap') c.err = o.message || 'trap';
    else if (type === '!done') { this.cur = null; c.err ? c.reject(new Error(c.err)) : c.resolve(c.rows); }
    else if (type === '!fatal') { this.cur = null; c.reject(new Error('fatal')); }
  }
  _exec(words) {
    return new Promise((resolve, reject) => {
      if (this.cur) return reject(new Error('busy'));
      this.cur = { resolve, reject, rows: [], err: null };
      this.sock.write(encSentence(words));
    });
  }
  run(words) { const p = this.chain.then(() => this._exec(words)); this.chain = p.catch(() => {}); return p; }
}

module.exports = { RosApi, encSentence, parseSentence };
