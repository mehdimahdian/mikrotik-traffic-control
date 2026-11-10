# Guest Wi-Fi portal (captive portal)

For anyone who lets **temporary guests** online: hotel guests, restaurant and cafe customers, tenants' visitors in a residential building, clinic waiting rooms, school events, office reception.

How it works: guests join the guest Wi-Fi, open any web page and see **your branded login page** (in your language and English). They type an **access code** that staff issued; the internet opens with a **package** (speed, number of devices) until the code expires. Before login only the *walled garden* (sites you allow, e.g. your menu or hotel information page) is reachable. Staff and your own devices on other networks are not affected.

## Requirements

* A guest network on its own router interface with an IP address and a **DHCP server** (use *Router setup > Create an isolated guest network* on a fresh router).
* Guest access points / controllers on that network must be added to *Never see the portal* (bypass), otherwise enabling the portal would cut their management.
* Do not also limit the same network with a bandwidth-control group (speeds would stack); the readiness check warns.

## Steps (tab **Guest Wi-Fi**)

1. **Settings** - choose the guest network interface; organization name (English and, optionally, your language); language of the login pages (English, فارسی, العربية, Русский, 中文 - always shown above English); optional logo address; optionally *My own guest web page* (shown as a link and allowed before login); the Wi-Fi names printed on cards.
2. **Packages** - e.g. Standard 4M/2M, 3 devices; Premium 25M/10M, 6 devices. Each becomes a hotspot user profile `mtc-<id>`.
3. **Walled garden** - hosts/addresses reachable without login. **Never see the portal** - fixed devices (access points, controllers, printers) by MAC or address.
4. **1. Prepare the router** - shows exactly what will be created (hotspot server `mtc-hotspot` on your interface, profile `mtc-guest`, packages, walled garden, bypass bindings); a configuration export `before-hotspot-*` is saved first. On a fresh router the hotspot server is **created disabled**; an existing server is re-profiled, never deleted.
5. **2. Upload portal pages** - writes the login/status/logout/error pages to the router's file system (`mtc-hotspot/`).
6. **3. Enable guest hotspot** - a separate confirmed step (you type `ENABLE GUEST WIFI`). Devices online right now can be *grandfathered* for N minutes so nobody loses the internet in the middle of a call.
7. **Wi-Fi access codes** - issue a code (reference such as room/table/unit, guest name, package, valid until), print a **card** (A5, in your language and English, with your logo), revoke it, see connected guests and disconnect one. Expired codes are removed automatically.

**Disable** gives everybody the internet again without login; **Remove everything** deletes everything the tab created (a hotspot server created by the program is removed; an existing one goes back to the default profile, disabled).

## Examples

| Business | Suggested setup |
|---|---|
| Hotel | Packages by room class (Standard / Comfort / Suite). Reference = room number, valid until = check-out time. Walled garden: hotel information page. Working hours 24/7. |
| Restaurant / cafe | One package (e.g. 3M, 2 devices), codes valid 3 hours, printed on the receipt or table card. Walled garden: your online menu. |
| Residential building | Package per tenant (reference = unit); visitors get a day code. Staff network = residents' own devices. |
| Office / clinic | Visitor package 2M, 1 device, valid until end of day. Staff devices stay on the staff network. |

## Notes

* Codes are hotspot users tagged `[mtc-hotspot] acct ... until=<time>`.
* The pages use the Vazirmatn font for Persian/Arabic (SIL OFL), system fonts otherwise.
* HTTPS sites cannot be redirected to the login page: modern phones detect the portal themselves (captive-portal detection); desktop users should open an `http://` address.
