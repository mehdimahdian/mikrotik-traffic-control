'use strict';
// Guest hotspot (captive portal) for a guest Wi-Fi network on a MikroTik router.
// Everything created is tagged "[mtc-hotspot]" (comments) or named "mtc-*" so it can be found and removed again.
// On a fresh router the hotspot server, its profile, the packages (rate + device count), the walled garden and the bypass bindings are CREATED;
// an existing server is re-profiled, never deleted. The hotspot stays DISABLED until you enable it in a separate, confirmed step.

const RATE = /^(\d+(?:\.\d+)?)([kKmMgG]?)$/;
const ID = /^[a-z0-9][a-z0-9-]{0,19}$/;
const NAME = /^[^=\n\r]{1,60}$/;
const isIp = (s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s) && s.split('.').every((x) => +x <= 255);
const isMac = (s) => /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(s);
const rateBps = (s) => { const m = RATE.exec(String(s).trim()); if (!m) return NaN; const u = m[2].toLowerCase(); return Math.round(+m[1] * (u === 'g' ? 1e9 : u === 'm' ? 1e6 : u === 'k' ? 1e3 : 1)); };

const PAGE_LANGS = ['en', 'fa', 'ar', 'ru', 'zh'], RTL = ['fa', 'ar'];
const DEFAULTS = {
  server: 'mtc-hotspot',                   // hotspot server name (created when it does not exist)
  iface: '',                               // the guest network interface (needs an IP address; pick it in the dashboard)
  pool: '',                                // address pool of the guest DHCP server ('' = taken from the DHCP server on that interface)
  profileName: 'mtc-guest',
  htmlDir: 'mtc-hotspot',
  mode: 'local',                           // local = branded login page on the router (access code); portal = redirect to your own captive web page
  portalUrl: '',                           // optional: your own guest web page (also shown as a link, and allowed in the walled garden)
  logoUrl: '',                             // optional logo (http/https URL) fetched by the router into the page folder
  orgName: { en: 'My Organization', local: '' },   // shown on the pages: the local-language name goes on top when the page language is not English
  pageLang: 'en',                          // language of the portal pages (shown above English): en, fa, ar, ru, zh
  ssids: [],                               // printed on guest cards
  cookieDays: 1,
  packages: {
    standard: { name: 'Standard', down: '4M', up: '2M', devices: 3 },
    comfort: { name: 'Comfort', down: '10M', up: '5M', devices: 4 },
    premium: { name: 'Premium', down: '25M', up: '10M', devices: 6 },
  },
  defaultPackage: 'standard',
  walled: [],                              // sites reachable before login: {kind: ip|host, value, port, note}
  bypass: [],                              // fixed devices on the guest network that must never see the portal (access points, controllers): {mac, ip, note}
};

function normalize(input) {
  const c = JSON.parse(JSON.stringify(DEFAULTS)), x = input || {};
  const str = (v, d, max) => (v === undefined ? d : String(v).trim().slice(0, max || 200));
  c.server = str(x.server, c.server, 40); c.iface = str(x.iface, c.iface, 60); c.pool = str(x.pool, c.pool, 60);
  if (/[=\n\r]/.test(c.iface + c.pool)) throw new Error('bad interface or pool name');
  if (!NAME.test(c.server)) throw new Error('bad server name');
  if (x.mode !== undefined) { if (!['local', 'portal'].includes(x.mode)) throw new Error('bad mode'); c.mode = x.mode; }
  for (const k of ['portalUrl', 'logoUrl']) if (x[k] !== undefined) { const v = String(x[k]).trim(); if (v && !/^https?:\/\/[^\s"'<>]+$/.test(v)) throw new Error('bad ' + k); c[k] = v; }
  if (x.orgName) c.orgName = { en: str(x.orgName.en, c.orgName.en, 60).replace(/[<>"]/g, ''), local: str(x.orgName.local, c.orgName.local, 60).replace(/[<>"]/g, '') };
  if (x.pageLang !== undefined) { if (!PAGE_LANGS.includes(x.pageLang)) throw new Error('bad page language'); c.pageLang = x.pageLang; }
  if (x.ssids) c.ssids = (Array.isArray(x.ssids) ? x.ssids : String(x.ssids).split(',')).map((s) => String(s).trim().replace(/[<>"]/g, '')).filter(Boolean).slice(0, 6);
  if (x.cookieDays !== undefined) { const n = Number(x.cookieDays); if (!(n >= 0 && n <= 30)) throw new Error('cookie days 0-30'); c.cookieDays = Math.floor(n); }
  if (x.packages) {
    const ids = Object.keys(x.packages); if (!ids.length || ids.length > 12) throw new Error('1-12 packages');
    c.packages = {};
    for (const id of ids) {
      if (!ID.test(id)) throw new Error('package id: a-z, 0-9, dash: ' + id);
      const p = x.packages[id], devices = Number(p.devices);
      if (!Number.isFinite(rateBps(p.down)) || !Number.isFinite(rateBps(p.up))) throw new Error('bad rate in package ' + id + ' (e.g. 4M, 512k, 0 = unlimited)');
      if (!(devices >= 1 && devices <= 20)) throw new Error('devices 1-20 in package ' + id);
      c.packages[id] = { name: String(p.name || id).slice(0, 40).replace(/[=<>"]/g, ''), down: String(p.down).trim(), up: String(p.up).trim(), devices: Math.floor(devices) };
    }
  }
  if (x.defaultPackage !== undefined) c.defaultPackage = String(x.defaultPackage);
  if (!c.packages[c.defaultPackage]) c.defaultPackage = Object.keys(c.packages)[0];
  if (x.walled) {
    if (!Array.isArray(x.walled) || x.walled.length > 40) throw new Error('too many walled garden entries');
    c.walled = x.walled.map((w) => {
      const kind = w.kind === 'host' ? 'host' : 'ip', value = String(w.value || '').trim(), port = String(w.port || '').trim();
      if (kind === 'ip' && !(isIp(value) || /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(value))) throw new Error('walled garden address must be an IPv4 address or network: ' + value);
      if (kind === 'host' && !/^[A-Za-z0-9*.\-]{3,100}$/.test(value)) throw new Error('walled garden host: ' + value);
      if (port && !/^\d{1,5}(,\d{1,5})*$/.test(port)) throw new Error('bad port ' + port);
      return { kind, value, port, note: String(w.note || '').slice(0, 80).replace(/[=<>"]/g, '') };
    });
  }
  if (x.bypass) {
    if (!Array.isArray(x.bypass) || x.bypass.length > 40) throw new Error('too many bypass entries');
    c.bypass = x.bypass.map((b) => {
      const mac = String(b.mac || '').trim().toUpperCase(), ip = String(b.ip || '').trim();
      if (!mac && !ip) throw new Error('bypass entry needs a MAC or an address');
      if (mac && !isMac(mac)) throw new Error('bad MAC ' + mac); if (ip && !isIp(ip)) throw new Error('bad address ' + ip);
      return { mac, ip, note: String(b.note || '').slice(0, 60).replace(/[=<>"]/g, '') };
    });
  }
  return c;
}

// ---------------------------------------------------------------- captive pages (router html directory)
const T = {
  en: { welcome: 'Welcome. Enter your Wi-Fi access code.', connect: 'Connect', help: 'Need help? Ask the staff.', connected: 'Connected', enjoy: 'Enjoy the internet.', myconn: 'My connection', yourconn: 'Your connection', online: 'Online time', left: 'Time left', used: 'Data used', disconnect: 'Disconnect', disconnected: 'Disconnected', again: 'Connect again', sorry: 'Sorry', retry: 'Try again', info: 'Information &amp; services' },
  fa: { welcome: 'خوش آمدید. کد دسترسی Wi-Fi خود را وارد کنید.', connect: 'اتصال', help: 'نیاز به راهنما دارید؟ با مسئول شبکه تماس بگیرید.', connected: 'متصل شدید', enjoy: 'از اینترنت لذت ببرید.', myconn: 'وضعیت اتصال', yourconn: 'وضعیت اتصال شما', online: 'مدت اتصال', left: 'زمان باقی‌مانده', used: 'حجم مصرف', disconnect: 'قطع اتصال', disconnected: 'اتصال قطع شد', again: 'اتصال مجدد', sorry: 'متأسفیم', retry: 'تلاش مجدد', info: 'اطلاعات و خدمات' },
  ar: { welcome: 'مرحباً بك. أدخل رمز الدخول إلى الواي فاي.', connect: 'اتصال', help: 'هل تحتاج إلى مساعدة؟ اسأل الموظفين.', connected: 'تم الاتصال', enjoy: 'استمتع بالإنترنت.', myconn: 'حالة الاتصال', yourconn: 'حالة اتصالك', online: 'مدة الاتصال', left: 'الوقت المتبقي', used: 'حجم الاستهلاك', disconnect: 'قطع الاتصال', disconnected: 'تم قطع الاتصال', again: 'اتصال مجدداً', sorry: 'عذراً', retry: 'حاول مرة أخرى', info: 'معلومات وخدمات' },
  ru: { welcome: 'Добро пожаловать. Введите код доступа к Wi-Fi.', connect: 'Подключиться', help: 'Нужна помощь? Обратитесь к персоналу.', connected: 'Подключено', enjoy: 'Приятного пользования интернетом.', myconn: 'Моё подключение', yourconn: 'Ваше подключение', online: 'Время в сети', left: 'Осталось времени', used: 'Использовано трафика', disconnect: 'Отключиться', disconnected: 'Отключено', again: 'Подключиться снова', sorry: 'Извините', retry: 'Повторить', info: 'Информация и услуги' },
  zh: { welcome: '欢迎。请输入您的 Wi-Fi 接入码。', connect: '连接', help: '需要帮助？请联系工作人员。', connected: '已连接', enjoy: '祝您上网愉快。', myconn: '我的连接', yourconn: '您的连接', online: '在线时长', left: '剩余时间', used: '已用流量', disconnect: '断开连接', disconnected: '已断开', again: '重新连接', sorry: '抱歉', retry: '重试', info: '信息与服务' },
};
const CSS = '*{box-sizing:border-box}body{margin:0;font:16px/1.7 Vazirmatn,Tahoma,"Segoe UI","Microsoft YaHei",Arial,sans-serif;background:#f4f6f9;color:#1b2430;-webkit-text-size-adjust:100%}.c{max-width:430px;margin:0 auto;padding:22px 18px;text-align:center}img{max-width:210px;height:auto;margin:8px auto}h1{font-size:22px;line-height:1.6;margin:6px 0 2px;color:#1f5fbf;font-weight:700}p{margin:10px 0;color:#3a4656}.loc{display:block;unicode-bidi:isolate;line-height:1.9}.en{display:block;direction:ltr;unicode-bidi:isolate;font-size:.88em;line-height:1.5;opacity:.82}h1 .en{font-size:.72em;font-weight:500}input,button{font:inherit;width:100%;padding:13px;border-radius:12px;border:1px solid #c5cedb;margin-top:10px}input{direction:ltr;text-align:center;letter-spacing:4px;font-size:22px;background:#fff}button{background:#1f5fbf;color:#fff;border:0;font-weight:700;line-height:1.4}button .en{opacity:.9}.e{background:#fbe3e0;color:#8a1c12;border-radius:10px;padding:9px;margin:10px 0}a{color:#1f5fbf}.s{margin-top:18px;font-size:12px;color:#6b7685}.s.l{direction:ltr}.r{margin:14px 0}.v{direction:ltr;unicode-bidi:isolate;font-size:19px;font-weight:600;color:#1b2430}.u{color:#6b7685;font-size:15px;font-weight:500}.t{display:inline-block;border:1px solid #c5cedb;border-radius:12px;padding:8px 14px;margin:5px;text-decoration:none;background:#fff}';
const langOf = (cfg) => cfg.pageLang || 'en';
const dirOf = (cfg) => (RTL.includes(langOf(cfg)) ? 'rtl' : 'ltr');
const useFont = (cfg) => ['fa', 'ar'].includes(langOf(cfg));
function head(cfg, title) { const L = langOf(cfg); return `<!doctype html><html lang="${L}" dir="${dirOf(cfg)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Cache-Control" content="no-cache"><title>${title}</title>${useFont(cfg) ? '<link rel="stylesheet" href="fa.css">' : ''}<style>${CSS}</style></head><body><div class="c"><img src="logo.png" alt="" onerror="this.style.display='none'">`; }
function foot(cfg, y) { return `<div class="s l">&copy; ${y} Kish IT &middot; kish-it.com<br>${cfg.orgName.en}</div></div></body></html>`; }
// local language on top, English underneath (English only when the page language is English)
const both = (cfg, k) => (langOf(cfg) === 'en' ? `<span class="en" lang="en" dir="ltr" style="font-size:1em;opacity:1">${T.en[k]}</span>` : `<span class="loc" lang="${langOf(cfg)}" dir="${dirOf(cfg)}">${T[langOf(cfg)][k]}</span><span class="en" lang="en" dir="ltr">${T.en[k]}</span>`);
const orgTitle = (cfg) => (langOf(cfg) !== 'en' && cfg.orgName.local ? `<span class="loc" dir="${dirOf(cfg)}">${cfg.orgName.local}</span><span class="en">${cfg.orgName.en}</span>` : `<span class="en" style="font-size:1em;opacity:1">${cfg.orgName.en}</span>`);

const fs = require('fs'), path = require('path');
const FONT_DIR = path.join(__dirname, 'public', 'assets', 'fonts');
const FA_RANGE = 'U+0600-06FF,U+200C-200F,U+2010-2011,U+204F,U+2E41,U+FB50-FDFF,U+FE70-FEFF', LA_RANGE = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215';
let faCssCache = null;
/** Vazirmatn (variable weight, SIL OFL) as one CSS file with the two font files inlined as base64 (Persian / Arabic pages). '' if the font files are missing. */
function fontCss() {
  if (faCssCache !== null) return faCssCache;
  try {
    const b64 = (f) => fs.readFileSync(path.join(FONT_DIR, f)).toString('base64');
    faCssCache = '/* Vazirmatn, SIL Open Font License 1.1, https://github.com/rastikerdar/vazirmatn */\n'
      + `@font-face{font-family:Vazirmatn;font-weight:100 900;font-display:swap;src:url(data:font/woff2;base64,${b64('vazirmatn-arabic-wght.woff2')}) format("woff2");unicode-range:${FA_RANGE}}\n`
      + `@font-face{font-family:Vazirmatn;font-weight:100 900;font-display:swap;src:url(data:font/woff2;base64,${b64('vazirmatn-latin-wght.woff2')}) format("woff2");unicode-range:${LA_RANGE}}\n`;
  } catch { faCssCache = ''; }
  return faCssCache;
}
const PREVIEW_FONT_CSS = `<style>@font-face{font-family:Vazirmatn;font-weight:100 900;src:url(/assets/fonts/vazirmatn-arabic-wght.woff2) format("woff2");unicode-range:${FA_RANGE}}@font-face{font-family:Vazirmatn;font-weight:100 900;src:url(/assets/fonts/vazirmatn-latin-wght.woff2) format("woff2");unicode-range:${LA_RANGE}}</style>`;

function pages(cfg, year) {
  const y = year || new Date().getFullYear(), out = {}, B = (k) => both(cfg, k), H = cfg.orgName;
  const portalLink = cfg.portalUrl ? `<p><a class="t" href="${cfg.portalUrl}">${B('info')}</a></p>` : '';
  if (cfg.mode === 'portal' && cfg.portalUrl) {
    out['login.html'] = `<!doctype html><html><head><meta charset="utf-8"><title>${H.en}</title></head><body><script>location.replace("${cfg.portalUrl.replace(/\/?$/, '/')}wifi?mac=$(mac-esc)&ip=$(ip)&login=$(link-login-only-esc)&orig=$(link-orig-esc)&error=$(error-orig)")</script><noscript><a href="${cfg.portalUrl}">Continue</a></noscript></body></html>`;
  } else {
    out['login.html'] = head(cfg, H.en + ' Wi-Fi') + `<h1>${orgTitle(cfg)}</h1><p>${B('welcome')}</p>$(if error)<div class="e">$(error)</div>$(endif)<form action="$(link-login-only)" method="post" onsubmit="var c=document.getElementById('k').value.replace(/\\s/g,'');if(!c)return false;document.getElementById('u').value=c;document.getElementById('p').value=c;return true"><input type="hidden" name="dst" value="$(link-orig)"><input type="hidden" name="popup" value="true"><input type="hidden" name="username" id="u"><input type="hidden" name="password" id="p"><input id="k" autocomplete="off" dir="ltr" placeholder="&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;"><button type="submit">${B('connect')}</button></form>${portalLink}<p class="s">${B('help')}</p>` + foot(cfg, y);
  }
  out['alogin.html'] = head(cfg, 'Wi-Fi').replace('<head>', '<head><meta http-equiv="refresh" content="2;url=$(link-redirect)">') + `<h1>${B('connected')}</h1><p>${B('enjoy')}</p><p><a class="t" href="$(link-status)">${B('myconn')}</a></p>` + foot(cfg, y);
  out['status.html'] = head(cfg, 'Wi-Fi') + `<h1>${B('yourconn')}</h1><div class="v u">$(username)</div><div class="r"><div>${B('online')}</div><div class="v">$(uptime)</div></div><div class="r"><div>${B('left')}</div><div class="v">$(session-time-left)</div></div><div class="r"><div>${B('used')}</div><div class="v">&darr; $(bytes-in-nice) &nbsp; &uarr; $(bytes-out-nice)</div></div><form action="$(link-logout)" method="post"><button type="submit">${B('disconnect')}</button></form>${portalLink}` + foot(cfg, y);
  out['logout.html'] = head(cfg, 'Wi-Fi') + `<h1>${B('disconnected')}</h1><p><a class="t" href="$(link-login)">${B('again')}</a></p>` + foot(cfg, y);
  out['error.html'] = head(cfg, 'Wi-Fi') + `<h1>${B('sorry')}</h1><div class="e">$(error)</div><p><a class="t" href="$(link-login)">${B('retry')}</a></p>` + foot(cfg, y);
  out['redirect.html'] = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=$(link-redirect)"></head><body></body></html>`;
  out['rlogin.html'] = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=$(link-login)"></head><body></body></html>`;
  if (cfg.mode !== 'portal' && useFont(cfg)) out['fa.css'] = fontCss();
  out['logo-url.txt'] = cfg.logoUrl || '';
  return out;
}
/** A page as a phone would see it (template variables replaced by sample values) - for the dashboard preview. */
function preview(html) {
  return html.replace('<link rel="stylesheet" href="fa.css">', PREVIEW_FONT_CSS).replace(/\$\(if error\)[\s\S]*?\$\(endif\)/g, '').replace(/src="logo\.png"/g, 'src="/assets/logo.png"')
    .replace(/\$\((link-[a-z-]+|mac-esc|ip|error-orig|username|uptime|session-time-left|bytes-in-nice|bytes-out-nice|error)\)/g, (_, k) => ({ username: 'guest-demo', uptime: '1h 12m', 'session-time-left': '2d 4h', 'bytes-in-nice': '312 MiB', 'bytes-out-nice': '18 MiB', error: 'invalid username or password' }[k] || '#'));
}

// ---------------------------------------------------------------- desired state and plan
/** facts: {address (router address on the interface), iface} */
function desired(cfg, facts) {
  const profile = { name: cfg.profileName, 'hotspot-address': facts.address, 'login-by': 'http-pap,cookie', 'html-directory': cfg.htmlDir, 'http-cookie-lifetime': cfg.cookieDays + 'd', 'use-radius': 'no' };
  const users = Object.entries(cfg.packages).map(([id, p]) => ({ name: 'mtc-' + id, 'rate-limit': `${rateBps(p.up)}/${rateBps(p.down)}`, 'shared-users': String(p.devices), 'keepalive-timeout': '2m', 'status-autorefresh': '1m',
    comment: `[mtc-hotspot] package ${p.name}: ${p.down} down / ${p.up} up, ${p.devices} devices` }));
  const walled = cfg.walled.map((w) => ({ kind: w.kind, value: w.value, port: w.port, comment: `[mtc-hotspot] ${w.note || w.value}` }));
  // bypass bindings only matter on the PRODUCTION guest interface (access points and controllers live there); a test server on its own network needs none
  const bindings = facts.isProd === false ? [] : cfg.bypass.map((b) => ({ mac: b.mac, ip: b.ip, comment: `[mtc-hotspot] bypass: ${b.note || 'fixed device'}` }))
    .concat((facts.apBypass || []).map((b) => ({ mac: b.mac, ip: '', comment: `[mtc-hotspot] bypass: ${b.note || 'access point'}` })));   // access points not already bypassed by a legacy binding
  return { profile, users, walled, bindings, server: { name: cfg.server, interface: facts.iface, 'address-pool': facts.pool } };
}
const sameRate = (a, b) => String(a || '') === String(b || '');
function plan(cfg, des, act) {
  const ops = [], warnings = [];
  const P = act.profiles.find((p) => p.name === des.profile.name);
  const pw = ['login-by', 'hotspot-address', 'html-directory', 'http-cookie-lifetime', 'use-radius'];
  const nv = (k, v) => { v = String(v === undefined ? '' : v); if (k === 'login-by') return v.split(',').map((s) => s.trim()).sort().join(','); return v === 'no' ? 'false' : v === 'yes' ? 'true' : v; };   // RouterOS prints no/yes as false/true and may reorder lists
  if (!P) ops.push({ text: `+ server profile ${des.profile.name}: ${des.profile['hotspot-address']}, login ${des.profile['login-by']}, pages in ${des.profile['html-directory']}`, words: ['/ip/hotspot/profile/add'].concat(Object.entries(des.profile).map(([k, v]) => `=${k}=${v}`)) });
  else if (pw.some((k) => nv(k, P[k]) !== nv(k, des.profile[k]))) ops.push({ text: `~ server profile ${des.profile.name}: update`, words: ['/ip/hotspot/profile/set', `=.id=${P['.id']}`].concat(pw.map((k) => `=${k}=${des.profile[k]}`)) });
  for (const u of des.users) {
    const a = act.userProfiles.find((p) => p.name === u.name);
    if (!a) ops.push({ text: `+ package ${u.name}: ${u['rate-limit']} (up/down bit/s), ${u['shared-users']} devices`, words: ['/ip/hotspot/user/profile/add'].concat(Object.entries(u).filter(([k]) => k !== 'comment').map(([k, v]) => `=${k}=${v}`)) });   // user profiles have no comment field
    else if (a['rate-limit'] !== u['rate-limit'] || String(a['shared-users']) !== u['shared-users']) ops.push({ text: `~ package ${u.name}: ${a['rate-limit']} -> ${u['rate-limit']}, devices ${a['shared-users']} -> ${u['shared-users']}`, words: ['/ip/hotspot/user/profile/set', `=.id=${a['.id']}`, `=rate-limit=${u['rate-limit']}`, `=shared-users=${u['shared-users']}`] });
  }
  const wk = (e) => (e.kind === 'host' ? 'h|' + e['dst-host'] : 'i|' + e['dst-address'] + '|' + (e['dst-port'] || ''));
  const have = new Map(act.walled.map((e) => [wk(e), e]));
  const want = new Set();
  for (const w of des.walled) {
    const k = w.kind === 'host' ? 'h|' + w.value : 'i|' + w.value + '|' + w.port; want.add(k);
    if (!have.has(k)) ops.push({ text: `+ walled garden ${w.kind === 'host' ? 'host ' + w.value : w.value + (w.port ? ':' + w.port : '')}  (${w.comment.slice(15)})`,
      words: w.kind === 'host' ? ['/ip/hotspot/walled-garden/add', `=dst-host=${w.value}`, '=action=allow', `=comment=${w.comment}`] : ['/ip/hotspot/walled-garden/ip/add', `=dst-address=${w.value}`, ...(w.port ? [`=dst-port=${w.port}`, '=protocol=tcp'] : []), '=action=accept', `=comment=${w.comment}`] });
  }
  const mine = (e) => String(e.comment || '').startsWith('[mtc-hotspot]');        // NEVER remove anything this preparation did not create
  for (const [k, e] of have) if (!want.has(k) && mine(e)) ops.push({ text: `- remove walled garden ${k.slice(2)}`, words: [e.kind === 'host' ? '/ip/hotspot/walled-garden/remove' : '/ip/hotspot/walled-garden/ip/remove', `=numbers=${e['.id']}`] });
  const bk = (b) => { const m = b.mac || b['mac-address']; return m ? 'm|' + String(m).toUpperCase() : 'a|' + (b.address || b.ip); };
  const forThisServer = act.bindings.filter((b) => !b.server || b.server === cfg.server);          // bindings are per hotspot server
  const haveB = new Map(forThisServer.map((b) => [bk(b), b])), wantB = new Set(), haveAddr = new Set(forThisServer.map((b) => b.address).filter(Boolean));
  for (const b of des.bindings) {
    const k = b.mac ? 'm|' + b.mac : 'a|' + b.ip; wantB.add(k);
    if (haveAddr.has(b.ip) && !b.mac) wantB.add('a|' + b.ip);               // an existing binding already covers this address
    if (!haveB.has(k) && !(b.ip && !b.mac && haveAddr.has(b.ip))) ops.push({ text: `+ bypass binding ${b.mac || b.ip}  (${b.comment.slice(15)})`, words: ['/ip/hotspot/ip-binding/add', ...(b.mac ? [`=mac-address=${b.mac}`] : [`=address=${b.ip}`]), '=type=bypassed', `=server=${cfg.server}`, `=comment=${b.comment}`] });
  }
  for (const [k, b] of haveB) if (!wantB.has(k) && mine(b)) ops.push({ text: `- remove bypass binding ${k.slice(2)}`, words: ['/ip/hotspot/ip-binding/remove', `=numbers=${b['.id']}`] });
  for (const u of act.userProfiles) if (String(u.name).startsWith('mtc-') && !des.users.some((d) => d.name === u.name)) ops.push({ text: `- remove package ${u.name}`, after: true, words: ['/ip/hotspot/user/profile/remove', `=numbers=${u['.id']}`] });
  if (!act.server) {
    if (!des.server.interface) warnings.push('Pick the guest network interface first: the hotspot server cannot be created without it.');
    else if (!des.server['address-pool']) warnings.push(`No DHCP address pool found on ${des.server.interface}: create a DHCP server for the guest network first (a hotspot needs one).`);
    else ops.push({ text: `+ hotspot server ${cfg.server} on ${des.server.interface}, pool ${des.server['address-pool']}, profile ${des.profile.name} (created DISABLED)`, words: ['/ip/hotspot/add', `=name=${cfg.server}`, `=interface=${des.server.interface}`, `=address-pool=${des.server['address-pool']}`, `=profile=${des.profile.name}`, '=disabled=yes'] });
  } else if (act.server.profile !== des.profile.name) ops.push({ text: `~ server ${cfg.server}: profile ${act.server.profile} -> ${des.profile.name} (stays ${act.server.disabled === 'true' ? 'DISABLED' : 'ENABLED'})`, words: ['/ip/hotspot/set', `=numbers=${act.server['.id']}`, `=profile=${des.profile.name}`] });
  ops.sort((a, b) => (a.after ? 1 : 0) - (b.after ? 1 : 0));
  // bypass bindings name the server, so the server must exist before them: move its creation in front of the binding operations
  const si = ops.findIndex((o) => o.words[0] === '/ip/hotspot/add');
  if (si >= 0) { const [so] = ops.splice(si, 1); const bi = ops.findIndex((o) => o.words[0] === '/ip/hotspot/ip-binding/add'); ops.splice(bi < 0 ? ops.length : bi, 0, so); }
  return { ops, warnings };
}

// ---------------------------------------------------------------- readiness checks
/** facts: {apMacs:Set, boundMacs:Set, boundIps:Set, fixedOk, files:Set, active, guestClients, qosGuest, portalOk} */
function checks(cfg, act, f) {
  const r = [], add = (id, ok, text, level) => r.push({ id, ok, level: level === 'info' ? 'info' : ok ? 'ok' : (level || 'bad'), text });
  add('server', !!act.server, act.server ? `Hotspot server "${cfg.server}" exists on ${act.server.interface} (${act.server.disabled === 'true' ? 'currently disabled - guests are not affected' : 'ENABLED'})` : `Hotspot server "${cfg.server}" not found`);
  add('profile', !!act.server && act.server.profile === cfg.profileName, act.server && act.server.profile === cfg.profileName ? `Server uses profile ${cfg.profileName}` : `Server still uses profile ${act.server ? act.server.profile : '-'}: run Prepare`, 'warn');
  add('packages', Object.keys(cfg.packages).every((id) => act.userProfiles.some((p) => p.name === 'mtc-' + id)), 'Packages exist on the router', 'warn');
  const test = f.isProd === false;                 // a test server on its own network: access points and controllers are not involved
  if (test) add('testserver', true, `TEST server "${cfg.server}" on its own network (${act.server ? act.server.interface : '-'}): production guests and access points are not involved`, 'info');
  const miss = test ? [] : [...f.apMacs].filter((m) => !f.boundMacs.has(m));
  add('aps', miss.length === 0, test ? 'Access-point bypass is not needed on the test network' : miss.length === 0 ? `All ${f.apMacs.size} access points are bypassed (they will not see the portal)` : `${miss.length} access point(s) are NOT bypassed (${miss.slice(0, 3).join(', ')}${miss.length > 3 ? ', ...' : ''}): enabling would cut their management`);
  const ez = test || cfg.bypass.filter((b) => b.ip).every((b) => f.boundIps.has(b.ip) || [...act.bindings].some((x) => x.address === b.ip));
  add('fixed', ez, test ? 'Bypass is not needed on the test network' : ez ? 'Fixed devices (controllers etc.) are bypassed' : 'Some fixed devices are not bypassed yet: run Prepare', 'warn');
  add('pages', ['login.html', 'alogin.html', 'status.html', 'logout.html', 'error.html'].every((n) => f.files.has(`${cfg.htmlDir}/${n}`)), `Portal pages in ${cfg.htmlDir}/ on the router`, 'warn');
  add('walled', cfg.walled.length > 0, `${cfg.walled.length} walled-garden entr${cfg.walled.length === 1 ? 'y' : 'ies'} (always reachable without login)`, 'warn');
  if (cfg.portalUrl) add('portal', f.portalOk === true, f.portalOk ? 'Your guest web page answers (walled garden target)' : 'Your guest web page did not answer from this PC (it is the page guests see before login)', 'warn');
  add('qos', !f.qosGuest, f.qosGuest ? 'Bandwidth control also limits the guest network: limits would stack with the package speeds (turn the guest group off in Configuration)' : 'No conflicting bandwidth-control group on the guest network', 'warn');
  add('clients', true, test ? 'Enabling the test server affects only devices on the test port / test SSID, nobody else' : `${f.guestClients} guest devices are online now: enabling cuts their internet until they log in (use the grandfather minutes)`, 'info');
  return r;
}

module.exports = { PAGE_LANGS, DEFAULTS, normalize, pages, preview, desired, plan, checks, rateBps };
