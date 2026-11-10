'use strict';
// Mikrotik Traffic Control - dashboard extensions that sit on top of index.html's script:
//   splash screen, language switcher, organisation branding, first-run wizard, working-hours editor, Router setup tab.
// Uses the helpers of the main script ($, $$, esc, j, postJson, toast, uiConfirm, loadRouters, showView, S, P).

const APP = { settings: null, started: Date.now() };
window.APP = APP;
const wk = (on, start, end, days) => Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, { on: days.includes(d), start, end }]));

// ================= working hours editor (24/7 or a window per weekday) =================
const HoursEditor = {
  render(el, hours) {
    const H = hours || { mode: 'schedule', week: wk(true, '08:00', '17:00', [1, 2, 3, 4, 5]) };
    const order = [0, 1, 2, 3, 4, 5, 6].map((i) => (I18N.weekStart + i) % 7);
    el.innerHTML = `<div class="tools"><b>Working hours</b>
      <label class="ipx"><input type="radio" name="hm-${el.id}" value="24x7" ${H.mode === '24x7' ? 'checked' : ''}> Open 24/7 (every minute counts as working time)</label>
      <label class="ipx"><input type="radio" name="hm-${el.id}" value="schedule" ${H.mode !== '24x7' ? 'checked' : ''}> Weekly schedule</label></div>
      <table class="hrs"><tbody>${order.map((d) => { const w = H.week[d] || { on: false, start: '08:00', end: '17:00' };
        return `<tr data-d="${d}"><td class="l"><label><input type="checkbox" class="h-on" ${w.on ? 'checked' : ''}> ${esc(I18N.dayName(d))}</label></td><td><input type="time" class="h-s" value="${w.start}"></td><td class="ipx">to</td><td><input type="time" class="h-e" value="${w.end}"></td></tr>`; }).join('')}</tbody></table>
      <div class="ipx">The Abuse tab judges staff devices only inside these hours (a window that ends before it starts, like 22:00 to 06:00, runs overnight). Guests are always judged all day.</div>`;
    const sync = () => { const sch = $('input[value="schedule"]', el).checked; $$('.hrs input', el).forEach((i) => { i.disabled = !sch; }); };
    el.addEventListener('change', sync); sync();
  },
  read(el) {
    const mode = $('input[type=radio]:checked', el).value, week = {};
    $$('.hrs tr', el).forEach((tr) => { week[tr.dataset.d] = { on: $('.h-on', tr).checked, start: $('.h-s', tr).value || '08:00', end: $('.h-e', tr).value || '17:00' }; });
    return { mode, week };
  },
  summary(h) {
    if (h.mode === '24x7') return __('24/7');
    const groups = new Map();
    for (let i = 0; i < 7; i++) { const d = (I18N.weekStart + i) % 7, w = h.week[d]; if (!w || !w.on) continue; const k = w.start + '-' + w.end; groups.set(k, [...(groups.get(k) || []), I18N.dayName(d, 'short')]); }
    return [...groups.entries()].map(([k, days]) => days.join(', ') + ' ' + k).join('; ') || __('(no working days)');
  },
};
window.HoursEditor = HoursEditor;

// business types -> default working hours + names (all editable afterwards)
const TYPE_NAMES = { office: 'Office / company', hotel: 'Hotel / hospitality (24/7)', restaurant: 'Restaurant / cafe', retail: 'Shop / retail', residential: 'Residential building / home', school: 'School / university / clinic', other: 'Other' };
function presetHours(type) {
  const lang = I18N.lang, workdays = lang === 'fa' ? [6, 0, 1, 2, 3] : lang === 'ar' ? [0, 1, 2, 3, 4] : [1, 2, 3, 4, 5], all = [0, 1, 2, 3, 4, 5, 6];
  if (type === 'hotel' || type === 'residential') return { mode: '24x7', week: wk(true, '00:00', '23:59', all) };
  if (type === 'restaurant') return { mode: 'schedule', week: wk(true, '10:00', '23:00', all) };
  if (type === 'retail') return { mode: 'schedule', week: wk(true, '09:00', '21:00', all) };
  if (type === 'school') return { mode: 'schedule', week: wk(true, '07:30', '15:30', workdays) };
  return { mode: 'schedule', week: wk(true, '08:00', '17:00', workdays) };
}

// ================= error codes -> messages =================
const ERR = { 'login-failed': 'Login failed: check the user name and password, and that the user may use the API.', refused: 'Connection refused: is the API service enabled on that port (IP > Services > api, port 8728)?',
  'no-answer': 'No answer from the router: check the address, the port and any firewall in between.', 'no-password': 'Enter the password.', 'bad-input': 'Check the address, port and user name.' };
const errText = (code, fallback) => (ERR[code] ? __(ERR[code]) : code && code.startsWith('error:') ? __('Cannot connect: {msg}', { msg: code.slice(6) }) : fallback || __('Something went wrong.'));

// ================= branding + splash + language =================
function applyBrand() {
  const o = (APP.settings && APP.settings.org) || {}, has = !!(o.name && o.name.trim());
  $('#orgname').textContent = has ? o.name : 'Mikrotik Traffic Control'; $('#orgname').setAttribute('data-noi18n', has ? '1' : '');
  $('#prodname').style.display = has ? '' : 'none';
  $('#brandlogo').src = APP.settings && APP.settings.hasLogo ? '/org-logo.png' : 'assets/mtc-logo.svg';
}
function hideSplash() {
  const s = $('#splash'); if (!s) return;
  const wait = Math.max(0, 1500 - (Date.now() - APP.started));
  setTimeout(() => { s.classList.add('out'); setTimeout(() => s.remove(), 700); }, wait);
}
$('#lang').addEventListener('change', async (e) => {
  await I18N.set(e.target.value); postJson('/api/settings', { lang: e.target.value }).catch(() => {});
  if (S.view === 'config' || S.view === 'setup' || S.view === 'wifi') showView(S.view);
});
document.querySelectorAll('.yr2').forEach((e) => { e.textContent = new Date().getFullYear(); });

// ================= first-run wizard =================
const WZ = { step: 0, data: { host: '192.168.88.1', port: 8728, mode: 'create', user: '', password: '', adminUser: 'admin', adminPassword: '', restrict: true, token: '', info: null, roles: {}, adminIp: '', dns: '', hours: null }, el: null };
const WSTEPS = ['Welcome', 'Router', 'Networks', 'Working hours', 'Finish'];
function wizOpen() {
  if (WZ.el) return;
  WZ.el = document.createElement('div'); WZ.el.className = 'modal'; WZ.el.style.zIndex = 150; document.body.appendChild(WZ.el);
  WZ.data.hours = presetHours(APP.settings.org.type); wizDraw();
}
function wizClose() { if (WZ.el) { WZ.el.remove(); WZ.el = null; } }
function wizDraw() {
  const d = WZ.data, s = WZ.step, body = {
    0: () => `<p>Welcome! This guide connects Mikrotik Traffic Control to your MikroTik router in a few minutes. Nothing on the router is changed until you say so.</p>
      <div class="form" style="grid-template-columns:1fr 1fr"><label>Language<select id="wz-lang">${Object.entries(I18N.langs).map(([c, l]) => `<option value="${c}" ${c === I18N.lang ? 'selected' : ''} data-noi18n="1">${l.name}</option>`).join('')}</select></label>
      <label>Organization name<input id="wz-org" value="${esc(APP.settings.org.name || '')}" placeholder="e.g. Sunrise Cafe"></label>
      <label>Type of business (sets default working hours)<select id="wz-type">${Object.entries(TYPE_NAMES).map(([c, n]) => `<option value="${c}" ${c === APP.settings.org.type ? 'selected' : ''}>${n}</option>`).join('')}</select></label></div>`,
    1: () => `<p>Enter the address of your router. The program talks to it through the RouterOS API (port 8728); it never needs the router's Winbox or web password stored.</p>
      <div class="form" style="grid-template-columns:2fr 1fr"><label>Router address<input id="wz-host" value="${esc(d.host)}" placeholder="192.168.88.1"></label><label>API port<input id="wz-port" value="${d.port}" inputmode="numeric"></label></div>
      <div class="tools" style="margin:10px 0"><label class="ipx"><input type="radio" name="wz-mode" value="create" ${d.mode === 'create' ? 'checked' : ''}> Create a dedicated API user for me (uses an administrator login once; recommended)</label></div>
      <div class="tools" style="margin:0 0 6px"><label class="ipx"><input type="radio" name="wz-mode" value="own" ${d.mode === 'own' ? 'checked' : ''}> I already have an API user</label></div>
      <div id="wz-create" class="form" style="grid-template-columns:1fr 1fr"><label>Router administrator user<input id="wz-au" value="${esc(d.adminUser)}" autocomplete="off"></label><label>Administrator password (used once, never saved)<input id="wz-ap" type="password" autocomplete="off"></label>
        <label class="ipx" style="grid-column:1/-1;flex-direction:row;gap:6px;align-items:center"><input type="checkbox" id="wz-rs" ${d.restrict ? 'checked' : ''}> Only allow the new user to log in from this PC</label></div>
      <div id="wz-own" class="form" style="grid-template-columns:1fr 1fr"><label>API user<input id="wz-u" value="${esc(d.user)}" autocomplete="off"></label><label>Password<input id="wz-p" type="password" autocomplete="off"></label></div>
      <details style="margin-top:10px"><summary class="ipx" style="cursor:pointer">The router refuses the connection / brand-new router</summary>
        <div class="ipx" style="margin-top:6px">On a new router the API service may be off or blocked. Download the preparation script, open <b>System &gt; Scripts</b> or the <b>New Terminal</b> in Winbox, paste it (or upload it and run <code>/import file-name=mtc-init.rsc</code>), then continue here. It enables the API service for this PC only and creates the API user.</div>
        <div class="tools" style="margin-top:6px"><input id="wz-pcip" placeholder="Address of this PC, e.g. 192.168.88.10" style="min-width:260px"><a class="btn" id="wz-script" href="#" style="text-decoration:none">Download mtc-init.rsc</a></div></details>
      <div class="warnbar" id="wz-err" hidden style="margin-top:10px"></div>`,
    2: () => { const I = d.info; return `<p>Which networks are used by whom? <b>Staff</b> = your own people and devices, <b>Guests</b> = visitors, customers, residents' guests. Devices are grouped by the router network they are on.</p>
      <table><thead><tr><th class="l">Network</th><th class="l">Address</th><th class="l">DHCP</th><th class="l">Used by</th></tr></thead><tbody>${I.networks.map((n) => {
        const r = d.roles[n.iface] || 'ignore'; return `<tr><td class="l"><b>${esc(n.iface)}</b> <span class="ipx">${esc(n.comment)}</span></td><td class="l ipx">${esc(n.address)}</td><td class="l">${n.hasDhcp ? 'yes' : 'no'}</td><td class="l">${n.isWan ? '<span class="chip">Internet (WAN)</span>' : `<span class="rolebtn" data-if="${esc(n.iface)}">${['staff', 'guest', 'ignore'].map((x) => `<label class="${r === x ? 'on' : ''}"><input type="radio" name="r-${esc(n.iface)}" value="${x}" ${r === x ? 'checked' : ''}>${x === 'staff' ? 'Staff' : x === 'guest' ? 'Guests' : 'Ignore'}</label>`).join('')}</span>`}</td></tr>`; }).join('')}</tbody></table>
      <div class="form" style="grid-template-columns:1fr 1fr;margin-top:12px"><label>Admin PC address (never blocked or limited)<input id="wz-adm" value="${esc(d.adminIp)}"></label><label>Internal DNS server for PC names (optional)<input id="wz-dns" value="${esc(d.dns)}" placeholder="e.g. 192.168.88.2"></label></div>
      ${I.warnings.includes('no-wan') ? '<div class="warnbar" style="margin-top:8px">No internet interface was found (no active default route). Traffic will be counted as internal until the router has a default route.</div>' : ''}`; },
    3: () => `<p>When are your people at work? Usage outside these hours is reported separately. Hotels, hospitals and shops that never close choose 24/7.</p><div id="wz-hours"></div>`,
    4: () => { const I = d.info; return `<p>Ready. This will save the router, start collecting traffic and apply your choices:</p>
      <ul><li>Router: <b>${esc(I.identity || d.host)}</b> (${esc(d.host)}${I.version ? ', RouterOS ' + esc(I.version) : ''})</li>
      <li>Organization: <b>${esc(APP.settings.org.name || '-')}</b></li>
      <li>Staff networks: <b>${esc(Object.entries(d.roles).filter(([, r]) => r === 'staff').map(([k]) => k).join(', ') || '-')}</b></li>
      <li>Guest networks: <b>${esc(Object.entries(d.roles).filter(([, r]) => r === 'guest').map(([k]) => k).join(', ') || '-')}</b></li>
      <li>Working hours: <b>${esc(HoursEditor.summary(d.hours))}</b></li></ul>
      <div class="ipx">After this, open <b>Router setup</b> to add the block rules, speed limits and the guest Wi-Fi portal on the router. Each change is previewed first and a backup is saved on the router.</div>
      <div class="warnbar" id="wz-err" hidden style="margin-top:10px"></div>`; },
  }[s]();
  WZ.el.innerHTML = `<div class="mbox" style="width:min(720px,100%)"><div class="dh"><div class="t"><b>Setup guide</b> <span class="ipx">- ${__('Step {n} of {total}', { n: s + 1, total: WSTEPS.length })}: ${__(WSTEPS[s])}</span></div></div>
    <div class="wizdots">${WSTEPS.map((_, i) => `<i class="${i <= s ? 'on' : ''}"></i>`).join('')}</div>${body}
    <div class="tools" style="margin-top:14px;justify-content:space-between"><span><button class="btn" id="wz-back" ${s === 0 ? 'hidden' : ''}>Back</button></span><span><span class="ipx" id="wz-msg"></span> <button class="btn pri" id="wz-next">${s === WSTEPS.length - 1 ? 'Finish' : s === 1 ? 'Test and continue' : 'Next'}</button></span></div></div>`;
  wizBind();
}
const wv = (id) => ($('#' + id) ? $('#' + id).value.trim() : '');
function wizBind() {
  const d = WZ.data, s = WZ.step;
  if (s === 0) $('#wz-lang').addEventListener('change', async (e) => { $('#lang').value = e.target.value; await I18N.set(e.target.value); d.hours = presetHours($('#wz-type').value); wizDraw(); });
  if (s === 1) {
    const toggle = () => { const c = $('input[name=wz-mode]:checked').value === 'create'; $('#wz-create').style.display = c ? '' : 'none'; $('#wz-own').style.display = c ? 'none' : ''; }; toggle();
    $$('input[name=wz-mode]').forEach((r) => r.addEventListener('change', toggle));
    $('#wz-script').addEventListener('click', (e) => { e.preventDefault(); const ip = wv('wz-pcip'); if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) { toast(__('Enter the address of this PC first'), 'bad'); return; } location.href = '/api/init-script?ip=' + encodeURIComponent(ip); });
  }
  if (s === 2) $$('.rolebtn input').forEach((r) => r.addEventListener('change', (e) => { const g = e.target.closest('.rolebtn'); d.roles[g.dataset.if] = e.target.value; $$('label', g).forEach((l) => l.classList.toggle('on', $('input', l).checked)); }));
  if (s === 3) HoursEditor.render($('#wz-hours'), d.hours);
  $('#wz-back').addEventListener('click', () => { WZ.step = Math.max(0, WZ.step - 1); wizDraw(); });
  $('#wz-next').addEventListener('click', wizNext);
}
async function wizNext() {
  const d = WZ.data, s = WZ.step, btn = $('#wz-next'), msg = $('#wz-msg'), err = (t) => { const e = $('#wz-err'); if (e) { e.hidden = !t; e.textContent = t || ''; } };
  try {
    if (s === 0) {
      APP.settings.org = { name: wv('wz-org'), type: $('#wz-type').value }; d.hours = presetHours(APP.settings.org.type);
      await postJson('/api/settings', { org: APP.settings.org, lang: I18N.lang }); applyBrand();
    } else if (s === 1) {
      btn.disabled = true; msg.textContent = __('Connecting...'); err('');
      d.host = wv('wz-host'); d.port = Number(wv('wz-port') || 8728); d.mode = $('input[name=wz-mode]:checked').value;
      let body = { host: d.host, port: d.port };
      if (d.mode === 'create') {
        const p = await postJson('/api/routers/provision', { host: d.host, port: d.port, adminUser: wv('wz-au'), adminPassword: $('#wz-ap').value, restrict: $('#wz-rs').checked });
        if (!p.ok) { err(errText(p.code)); btn.disabled = false; msg.textContent = ''; return; }
        d.token = p.token; d.pcIp = p.pcAddress; body = { token: p.token, host: d.host, port: d.port }; d.user = p.user; d.password = '';
      } else { d.user = wv('wz-u'); d.password = $('#wz-p').value; d.token = ''; body = { host: d.host, port: d.port, user: d.user, password: d.password }; }
      const r = await postJson('/api/routers/inspect', body);
      if (!r.ok) { err(errText(r.code)); btn.disabled = false; msg.textContent = ''; return; }
      d.info = r.info; d.adminIp = d.adminIp || r.info.pcAddress || '';
      for (const n of r.info.networks) if (!(n.iface in d.roles)) d.roles[n.iface] = n.isWan || !n.private ? 'ignore' : /guest|wifi|wlan|visitor|hotspot|public/i.test(n.iface + ' ' + n.comment) ? 'guest' : 'staff';
      if (!r.info.policy.ok) { err(__('The login lacks permissions: {list}. Continue only if you do not need blocking and speed limits.', { list: r.info.policy.missing.join(', ') })); }
    } else if (s === 2) { d.adminIp = wv('wz-adm'); d.dns = wv('wz-dns'); if (d.adminIp && !/^\d{1,3}(\.\d{1,3}){3}$/.test(d.adminIp)) { toast(__('The admin PC address must look like 192.168.88.10'), 'bad'); return; } }
    else if (s === 3) d.hours = HoursEditor.read($('#wz-hours'));
    else if (s === 4) { await wizFinish(btn, msg, err); return; }
    btn.disabled = false; msg.textContent = ''; WZ.step = s + 1; wizDraw();
  } catch (e) { btn.disabled = false; msg.textContent = ''; err(__('Something went wrong.') + ' ' + (e.message || '')); }
}
async function wizFinish(btn, msg, err) {
  const d = WZ.data; btn.disabled = true; msg.textContent = __('Saving...'); err('');
  const body = { name: (d.info.identity || APP.settings.org.name || 'Router').slice(0, 60), host: d.host, port: d.port, dns: d.dns };
  if (d.token) body.token = d.token; else { body.user = d.user; body.password = d.password; }
  const r = await postJson('/api/routers', body);
  if (!r.ok) { err(errText(r.code)); btn.disabled = false; msg.textContent = ''; return; }
  const base = '/api/r/' + encodeURIComponent(r.id) + '/api';
  for (let i = 0; i < 40; i++) { try { const st = await (await fetch(base + '/status', { cache: 'no-store' })).json(); if (st && st.ok !== undefined) break; } catch { /* collector still starting */ } await new Promise((x) => setTimeout(x, 400)); }
  const staff = Object.entries(d.roles).filter(([, v]) => v === 'staff').map(([k]) => k), guest = Object.entries(d.roles).filter(([, v]) => v === 'guest').map(([k]) => k);
  const c = await postJson(base + '/config', { staffNetworks: staff, guestNetworks: guest, sec: { adminIps: d.adminIp ? [d.adminIp] : [] }, abuse: { hours: d.hours } });
  if (!c.ok) toast(__('Router saved, but the networks could not be stored: {msg}', { msg: c.error || '' }), 'bad');
  await postJson('/api/settings', { wizardDone: true, org: APP.settings.org, lang: I18N.lang }); APP.settings.wizardDone = true;
  d.password = ''; d.token = ''; wizClose();
  await loadRouters(); S.router = r.id; $('#router').value = r.id; showView('setup');
  toast(__('Connected. Next: review the Router setup tab.'), 'ok', 9000);
}

// ================= Router setup tab =================
const SU = { rep: null, cfg: null };
const suParts = [['block', 'Block internet for single devices (Block button)', 'One firewall rule; the list starts empty, so nobody is blocked.'], ['ipblock', 'Block internet addresses (attackers, scanners)', 'Two raw firewall rules; the list starts empty.'],
  ['fasttrack', 'Disable FastTrack (needed for speed limits)', 'FastTrack bypasses queues. Rules are only disabled, never deleted.'], ['guest', 'Create an isolated guest network', 'Address, DHCP server, NAT and isolation from your private networks on a free interface.']];
window.renderSetup = async function () {
  const el = $('#v-setup');
  const R = await j(P() + '/setup'); SU.rep = R; SU.cfg = R.config;
  if (!R.connected) { el.innerHTML = `<div class="panel"><div class="empty">${esc(__('The router is not connected yet.'))}</div></div>`; return; }
  const c = R.config, g = c.guest, ifs = (R.interfaces || []).filter((i) => i.name !== R.wan);
  el.innerHTML = `<div class="panel"><h2>Router setup <span class="ipx">Internet interface: ${esc(R.wan || '(not found)')}</span></h2>
    <div class="ipx">Everything this program needs on the router, created in one place. Every object is tagged <code>[mtc-...]</code> so it can be found and removed again. Changes are previewed first, a configuration backup is saved on the router before applying, and nothing else on the router is touched. You can also download the same changes as a RouterOS script (.rsc) and run it yourself.</div>
    ${R.error ? `<div class="warnbar" style="margin-top:10px">${esc(R.error)}</div>` : ''}
    <h3 style="margin:12px 0 4px;font-size:13px">What to set up</h3>
    ${suParts.map(([k, t, n]) => `<div class="tools" style="margin:4px 0"><label><input type="checkbox" class="su-p" data-k="${k}" ${c.parts[k] ? 'checked' : ''}> <b>${esc(__(t))}</b></label> <span class="ipx">${esc(__(n))}</span></div>`).join('')}
    <div id="su-guest" class="form" style="margin-top:8px">
      <label>Guest network interface<select id="su-if"><option value="">-</option>${ifs.map((i) => `<option value="${esc(i.name)}" ${i.name === g.iface ? 'selected' : ''}>${esc(i.name)}${i.hasAddress ? ' (already has an address)' : ''}${i.comment ? ' - ' + esc(i.comment) : ''}</option>`).join('')}</select></label>
      <label>Gateway address / prefix<input id="su-addr" value="${esc(g.address)}"></label><label>DNS servers for guests (optional)<input id="su-dns" value="${esc(g.dns)}" placeholder="1.1.1.1,8.8.8.8"></label>
      <label>DHCP lease time<input id="su-lease" value="${esc(g.leaseTime)}"></label>
      <label class="ipx" style="flex-direction:row;gap:6px;align-items:center"><input type="checkbox" id="su-iso" ${g.isolate ? 'checked' : ''}> Guests cannot reach private networks or the router (except DNS / DHCP)</label>
      <label class="ipx" style="flex-direction:row;gap:6px;align-items:center"><input type="checkbox" id="su-nat" ${g.masquerade ? 'checked' : ''}> Share the internet with NAT (masquerade)</label></div>
    <div class="tools" style="margin-top:10px"><button class="btn" id="su-save">Save and preview</button><button class="btn pri" id="su-apply" ${R.ops && R.ops.length ? '' : 'disabled'}>Apply to the router...</button><a class="btn" id="su-rsc" href="${P()}/setup/rsc" style="text-decoration:none">Download as .rsc script</a><button class="btn danger" id="su-remove">Remove everything this program created...</button><span class="ipx" id="su-msg"></span></div></div>
    <div class="panel"><h2>State on the router</h2>
      <table><thead><tr><th class="l">Change</th><th class="l">State</th></tr></thead><tbody>${(R.status || []).map((x) => `<tr style="cursor:default"><td class="l">${esc(x.text)}</td><td class="l">${x.ok ? '<span class="chip">done</span>' : '<span class="chip medium">missing</span>'}</td></tr>`).join('') || '<tr style="cursor:default"><td colspan="2" class="empty">Nothing selected above.</td></tr>'}</tbody></table>
      ${(R.warnings || []).map((w) => `<div class="warnbar" style="margin-top:8px">${esc(w)}</div>`).join('')}
      ${R.ops && R.ops.length ? `<h3 style="margin:12px 0 4px;font-size:13px">Will be changed when you press Apply</h3><pre style="white-space:pre-wrap;font-size:12px;background:var(--hover);padding:10px;border-radius:8px;margin:0" data-noi18n="1">${esc(R.ops.join('\n'))}</pre>` : ''}</div>
    <div class="panel"><h2>Next steps</h2><div class="ipx">Speed limits and the daily usage quota: <a href="#" id="su-go-cfg">Configuration &gt; Bandwidth control</a>. Visitor Wi-Fi with access codes: <a href="#" id="su-go-wifi">Guest Wi-Fi</a>. Both create only tagged objects and keep a way back.</div></div>`;
  const tg = () => { $('#su-guest').style.display = $('.su-p[data-k=guest]').checked ? '' : 'none'; }; tg(); $$('.su-p').forEach((x) => x.addEventListener('change', tg));
  $('#su-go-cfg').addEventListener('click', (e) => { e.preventDefault(); showView('config'); }); $('#su-go-wifi').addEventListener('click', (e) => { e.preventDefault(); showView('wifi'); });
  const collect = () => ({ parts: Object.fromEntries($$('.su-p').map((x) => [x.dataset.k, x.checked])), wan: c.wan, guest: { iface: $('#su-if').value, address: $('#su-addr').value.trim(), dns: $('#su-dns').value.trim(), leaseTime: $('#su-lease').value.trim(), isolate: $('#su-iso').checked, masquerade: $('#su-nat').checked } });
  const msg = (t, bad) => { const m = $('#su-msg'); m.style.color = bad ? 'var(--bad)' : 'var(--ok)'; m.textContent = t; };
  $('#su-save').addEventListener('click', async () => { const x = await postJson(P() + '/setup/config', { config: collect() }); if (!x.ok) { msg(x.error || __('Check the values'), true); return; } await window.renderSetup(); $('#su-msg').textContent = __('Saved. Review the changes below, then apply.'); });
  $('#su-apply').addEventListener('click', async () => {
    const x0 = await postJson(P() + '/setup/config', { config: collect() }); if (!x0.ok) { msg(x0.error || __('Check the values'), true); return; }
    if (!(await uiConfirm('Apply to the router?', 'The listed changes are made on the router now. A configuration backup (mtc-before-setup-...) is saved on the router first.', { ok: 'Apply' }))) return;
    msg(__('Applying...')); const x = await postJson(P() + '/setup/apply', { confirm: true });
    if (!x.ok) { msg(x.error, true); toast(x.error, 'bad'); return; } toast(__('Router set up: {n} change(s).', { n: x.ops }), 'ok'); window.renderSetup();
  });
  $('#su-remove').addEventListener('click', async () => {
    if (!(await uiConfirm('Remove everything?', 'Removes every firewall rule, address list, guest network object and queue-free setup item this page created, and enables FastTrack rules it had disabled. A backup is saved first.', { ok: 'Remove', danger: true }))) return;
    const x = await postJson(P() + '/setup/remove', { confirm: true }); if (!x.ok) { toast(x.error, 'bad'); return; } toast(__('{n} object(s) removed.', { n: x.ops }), 'ok'); window.renderSetup();
  });
};
// guest Wi-Fi tab: interface picker
window.fillHsIface = async function (cur) {
  try { const R = await j(P() + '/setup'); const ifs = (R.interfaces || []).filter((i) => i.name !== R.wan && i.hasAddress); $('#wf-iface').innerHTML = '<option value="">-</option>' + ifs.map((i) => `<option value="${esc(i.name)}" ${i.name === cur ? 'selected' : ''}>${esc(i.name)}${i.comment ? ' - ' + esc(i.comment) : ''}</option>`).join(''); } catch { /* ignore */ }
};


// the printable report defaults to the dashboard language
document.addEventListener('i18n', (e) => { const b = document.querySelector('#rp-lang button[data-v="' + e.detail + '"]'); if (b && window.RP) { document.querySelectorAll('#rp-lang button').forEach((x) => x.classList.toggle('on', x === b)); RP.lang = e.detail; } });

// ================= start =================
(async function boot() {
  try { APP.settings = await (await fetch('/api/settings', { cache: 'no-store' })).json(); } catch { APP.settings = { org: { name: '', type: 'office' }, lang: 'en', wizardDone: false }; }
  let stored = null; try { stored = localStorage.getItem('mtc.lang'); } catch { /* ignore */ }
  const lang = stored || (APP.settings.wizardDone ? APP.settings.lang : I18N.guess()) || 'en';
  $('#lang').value = lang; await I18N.set(lang); applyBrand();
  $('#foot').querySelector('.copy').setAttribute('title', 'Mikrotik Traffic Control ' + (APP.settings.version || ''));
  let routers = []; try { routers = await (await fetch('/api/routers', { cache: 'no-store' })).json(); } catch { /* ignore */ }
  hideSplash();
  if (!routers.length) setTimeout(wizOpen, 900);
})();
