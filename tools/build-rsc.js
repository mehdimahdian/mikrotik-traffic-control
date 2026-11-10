'use strict';
// Writes routeros/mtc-base.rsc (the router-side changes this program can make, as an example) and routeros/mtc-remove.rsc.
// The dashboard (Router setup tab) generates the same script for YOUR router, with your interface names.   Usage: npm run build:rsc
const fs = require('fs');
const path = require('path');
const setup = require('../src/setup');

const cfg = setup.normalize({ parts: { block: true, ipblock: true, fasttrack: true, guest: true }, wan: 'ether1', guest: { iface: 'ether5', address: '10.77.0.1/24' } });
const des = setup.desired(cfg, 'ether1');
const empty = { filter: [], raw: [], nat: [], addrlist: [], address: [], pool: [], dhcpnet: [], dhcp: [], fasttrack: [] };
const ops = setup.plan(cfg, des, empty).ops.filter((o) => o.where !== 'fasttrack');
const note = 'EXAMPLE: internet interface = ether1 (change it to yours), guest network on ether5 = 10.77.0.1/24 (change interface and address). Delete the sections you do not want.';
let out = setup.toRsc(ops, 'Mikrotik Traffic Control - base setup (example)').replace('# Take a backup first', '# ' + note + '\n# Take a backup first');
out += '\n# FastTrack: rules with action=fasttrack-connection bypass speed limits. Disable them (they are not deleted):\n/ip firewall filter disable [find where action=fasttrack-connection]\n';
fs.writeFileSync(path.join(__dirname, '..', 'routeros', 'mtc-base.rsc'), out);

const rm = [
  '# Mikrotik Traffic Control - remove everything the base setup created.   (c) Kish IT - https://kish-it.com',
  '# Removes every object whose comment starts with [mtc-block], [mtc-ipblock] or [mtc-guest] (rules, NAT, address lists, guest DHCP, pool, address)',
  '# and enables FastTrack again. Queues, the hotspot and the API user are removed from the dashboard or by hand (see the end of this file).',
  '# Take a backup first:  /export file=before-mtc-remove',
  '',
  '/ip firewall filter remove [find where comment~"^\\\\[mtc-(block|ipblock|guest)\\\\]"]',
  '/ip firewall raw remove [find where comment~"^\\\\[mtc-ipblock\\\\]"]',
  '/ip firewall nat remove [find where comment~"^\\\\[mtc-guest\\\\]"]',
  '/ip firewall address-list remove [find where comment~"^\\\\[mtc-guest\\\\]"]',
  '/ip dhcp-server remove [find where comment~"^\\\\[mtc-guest\\\\]"]',
  '/ip dhcp-server network remove [find where comment~"^\\\\[mtc-guest\\\\]"]',
  '/ip pool remove [find where comment~"^\\\\[mtc-guest\\\\]"]',
  '/ip address remove [find where comment~"^\\\\[mtc-guest\\\\]"]',
  '/ip firewall filter enable [find where action=fasttrack-connection]',
  '',
  '# Optional, by hand:',
  '#   /queue simple remove [find where name~"^mtc-"] ; /queue type remove [find where name~"^mtc-"]',
  '#   /ip hotspot remove [find where name="mtc-hotspot"] ; /ip hotspot profile remove [find where name="mtc-guest"]',
  '#   /user remove mtc-monitor ; /user group remove mtc ; /ip service set api address=""',
  '',
].join('\n');
fs.writeFileSync(path.join(__dirname, '..', 'routeros', 'mtc-remove.rsc'), rm);
console.log('wrote routeros/mtc-base.rsc and routeros/mtc-remove.rsc');
