'use strict';
// Best-effort classification of an internet destination (remote IP) into a TYPE and an ORG.
// Order: distinctive port (DNS, mail, VoIP, torrent, VPN, remote access, MQTT) -> well-known network ranges -> reverse-DNS name -> port hint.
// This is an estimate (no ASN database offline): shared CDNs/clouds host many services.

const TYPES = ['Video streaming', 'Social media', 'Messaging', 'Google / YouTube', 'Microsoft / Updates', 'Apple', 'CDN / Cloud', 'Hosting / VPS',
  'Video calls / VoIP', 'Mail', 'DNS', 'Gaming', 'Torrent / P2P', 'VPN / Tunnel', 'Remote access', 'IoT / MQTT', 'Iran (.ir)', 'Local network', 'Other / Unknown'];

function cidr(s) { const [a, b] = s.split('/'); const n = a.split('.').reduce((x, y) => x * 256 + (+y), 0); const bits = +b; const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0; return { base: (n & mask) >>> 0, mask }; }
const ip2n = (ip) => ip.split('.').reduce((x, y) => x * 256 + (+y), 0);

const NETS = [
  ['142.250.0.0/15', 'Google', 'Google / YouTube'], ['172.217.0.0/16', 'Google', 'Google / YouTube'], ['216.58.192.0/19', 'Google', 'Google / YouTube'],
  ['74.125.0.0/16', 'Google', 'Google / YouTube'], ['64.233.160.0/19', 'Google', 'Google / YouTube'], ['8.8.8.0/24', 'Google DNS', 'DNS'], ['8.8.4.0/24', 'Google DNS', 'DNS'],
  ['104.16.0.0/13', 'Cloudflare', 'CDN / Cloud'], ['172.64.0.0/13', 'Cloudflare', 'CDN / Cloud'], ['1.1.1.0/24', 'Cloudflare DNS', 'DNS'], ['1.0.0.0/24', 'Cloudflare DNS', 'DNS'],
  ['157.240.0.0/16', 'Meta (Facebook / Instagram / WhatsApp)', 'Social media'], ['31.13.24.0/21', 'Meta', 'Social media'], ['31.13.64.0/18', 'Meta', 'Social media'],
  ['69.171.224.0/19', 'Meta', 'Social media'], ['179.60.192.0/22', 'Meta', 'Social media'], ['185.89.218.0/23', 'Meta', 'Social media'],
  ['149.154.160.0/20', 'Telegram', 'Messaging'], ['91.108.4.0/22', 'Telegram', 'Messaging'], ['91.108.8.0/22', 'Telegram', 'Messaging'], ['91.108.12.0/22', 'Telegram', 'Messaging'],
  ['91.108.16.0/22', 'Telegram', 'Messaging'], ['91.108.56.0/22', 'Telegram', 'Messaging'],
  ['20.0.0.0/8', 'Microsoft', 'Microsoft / Updates'], ['40.64.0.0/10', 'Microsoft', 'Microsoft / Updates'], ['52.96.0.0/12', 'Microsoft 365', 'Microsoft / Updates'],
  ['52.112.0.0/14', 'Microsoft Teams', 'Microsoft / Updates'], ['13.64.0.0/11', 'Microsoft', 'Microsoft / Updates'], ['204.79.195.0/24', 'Microsoft Bing', 'Microsoft / Updates'],
  ['17.0.0.0/8', 'Apple', 'Apple'],
  ['45.57.0.0/17', 'Netflix', 'Video streaming'], ['108.175.32.0/20', 'Netflix', 'Video streaming'], ['185.2.220.0/22', 'Netflix', 'Video streaming'],
  ['104.244.40.0/21', 'X / Twitter', 'Social media'], ['170.114.0.0/16', 'Zoom', 'Video calls / VoIP'],
  ['162.254.192.0/21', 'Valve / Steam', 'Gaming'], ['155.133.224.0/19', 'Valve / Steam', 'Gaming'],
].map(([c, org, type]) => Object.assign(cidr(c), { org, type }));

// reverse-DNS suffix -> org, type
const PTR = [
  [/(^|\.)(1e100\.net|google\.com|googleusercontent\.com|ggpht\.com|gstatic\.com|googlevideo\.com)$/, 'Google', 'Google / YouTube'],
  [/(^|\.)(youtube\.com|ytimg\.com)$/, 'YouTube', 'Google / YouTube'],
  [/(^|\.)(facebook\.com|fbcdn\.net|instagram\.com|whatsapp\.net|whatsapp\.com|fb\.com)$/, 'Meta', 'Social media'],
  [/(^|\.)(twitter\.com|twimg\.com|x\.com)$/, 'X / Twitter', 'Social media'],
  [/(^|\.)(tiktokv\.com|tiktokcdn\.com|byteoversea\.com|bytedance\.com|musical\.ly)$/, 'TikTok', 'Social media'],
  [/(^|\.)(snapchat\.com|sc-cdn\.net|linkedin\.com|pinterest\.com|reddit\.com|redd\.it)$/, 'Social', 'Social media'],
  [/(^|\.)(netflix\.com|nflxvideo\.net|nflximg\.net|twitch\.tv|ttvnw\.net|aparat\.com|namava\.ir|filimo\.com)$/, 'Streaming', 'Video streaming'],
  [/(^|\.)(spotify\.com|scdn\.co|soundcloud\.com|deezer\.com|anghami\.com)$/, 'Music streaming', 'Video streaming'],
  [/(^|\.)(telegram\.org|t\.me|signal\.org|viber\.com)$/, 'Messaging', 'Messaging'],
  [/(^|\.)(microsoft\.com|msedge\.net|azure\.com|windows\.net|windowsupdate\.com|live\.com|office\.com|office365\.com|msn\.com|skype\.com|trafficmanager\.net)$/, 'Microsoft', 'Microsoft / Updates'],
  [/(^|\.)(apple\.com|aaplimg\.com|icloud\.com|mzstatic\.com)$/, 'Apple', 'Apple'],
  [/(^|\.)(zoom\.us|webex\.com|gotomeeting\.com|whereby\.com)$/, 'Video calls', 'Video calls / VoIP'],
  [/(^|\.)(amazonaws\.com|awsglobalaccelerator\.com|cloudfront\.net|azureedge\.net|akamai(technologies)?\.com|akamaiedge\.net|akamaitechnologies\.com|fastly\.net|cloudflare\.(com|net)|edgekey\.net|stackpathdns\.com|cdn77\.com|b-cdn\.net)$/, 'Cloud / CDN', 'CDN / Cloud'],
  [/(^|\.)(ovh\.(net|com)|hetzner\.(com|de)|your-server\.de|digitalocean\.com|linode\.com|vultr\.com|contabo\.net|leaseweb\.com|scaleway\.com|choopa\.net|m247\.com|serverius\.net)$/, 'Hosting / VPS', 'Hosting / VPS'],
  [/(^|\.)(steampowered\.com|valve\.net|steamcontent\.com|epicgames\.com|riotgames\.com|blizzard\.com|battle\.net|ea\.com|playstation\.net|xboxlive\.com)$/, 'Gaming', 'Gaming'],
  [/(^|\.)(github\.com|githubusercontent\.com|docker\.(com|io)|npmjs\.org)$/, 'Developer services', 'CDN / Cloud'],
  [/\.ir$/, 'Iran', 'Iran (.ir)'],
];

function portType(port, proto) {
  if (port === 53 || port === 853) return 'DNS';
  if ([25, 465, 587, 993, 143, 110, 995].includes(port)) return 'Mail';
  if ((port >= 5060 && port <= 5061) || (proto === 'udp' && ((port >= 3478 && port <= 3481) || (port >= 16384 && port <= 32767)))) return 'Video calls / VoIP';
  if (port >= 6881 && port <= 6999) return 'Torrent / P2P';
  if ([1194, 1723, 500, 4500, 51820, 51873].includes(port)) return 'VPN / Tunnel';
  if ([22, 23, 3389, 5900, 8291].includes(port)) return 'Remote access';
  if (port === 1883 || port === 8883) return 'IoT / MQTT';
  if (port === 5222 || port === 5223 || port === 5228) return 'Messaging';
  return null;
}
const PORT_WINS = new Set(['DNS', 'Mail', 'Torrent / P2P', 'VPN / Tunnel', 'Remote access', 'IoT / MQTT', 'Video calls / VoIP']);

/** @returns {{type: string, org: string}} */
function classify(ip, ptr, port, proto) {
  const n = ip2n(ip);
  let org = '', type = '';
  for (const x of NETS) if (((n & x.mask) >>> 0) === x.base) { org = x.org; type = x.type; break; }
  if (!type && ptr) for (const [re, o, t] of PTR) if (re.test(ptr)) { org = o; type = t; break; }
  const pt = portType(port, proto);
  if (pt && PORT_WINS.has(pt)) return { type: pt, org };
  if (type) return { type, org };
  if (pt) return { type: pt, org };
  return { type: 'Other / Unknown', org: '' };
}

module.exports = { classify, TYPES };
