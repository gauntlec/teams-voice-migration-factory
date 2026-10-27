# Device status monitoring (spike)

Status: **spike done, phase 1 built** (2026-10-27): points 1 and 2 answered by test, point 3 deliberately not run, recommendation below. Phase 1 (read-only Device status tab) is built; see [DISCOVERY.md](DISCOVERY.md) "Device status". Deployed to the test host only (2026.10.52); the Linux installer offers Kuma (`--with-kuma`, `voxshift kuma on`). Not yet tried against real devices. Feature request: "Explore a real-time status dashboard for Teams-related equipment (Algo,
Poly, DECT, AudioCodes, Teams Rooms), starting with Uptime Kuma on on-premise installs". This is a findings and design document;
nothing here ships to www. On-premise installs only: one Voxshift per customer, so the LAN is reachable and customers never mix.

## What exists today

- Discovery's Devices tab lists only common area phones and resource accounts from the tenant (no Microsoft device inventory: the
  Graph Teams device API is retired, see DISCOVERY.md).
- Voxshift holds each site's network subnets and VLANs (`discovery_network`), and a handset model per person
  (`handset_model`, `access_port_id`). It holds **no device list and no IP addresses** for Algo, Poly, DECT, AudioCodes or Teams Rooms,
  so a site device inventory would be new data.

## What was tested (test host 10.100.20.11, Kuma 2.5.7)

The Kuma on the test host is the engineer's own instance (10 monitors for another network, one public status page `otw`). It was
only read; nothing was created, changed or deleted in it.

| Acceptance point | Result so far |
|---|---|
| 1. Kuma ping under our locked-down container settings | **Yes, with two additions to our usual hardening.** Tested on a throwaway stack (`louislam/uptime-kuma:2-rootless`, `read_only`, `no-new-privileges`, `cap_drop: ALL`) on the test host. Four variants: **A** nothing added: every ping fails with `spawn EPERM` (Kuma's `/usr/bin/ping` has the file capability `cap_net_raw=ep`, and with an empty bounding set it cannot even start). **B** `cap_add: NET_RAW` only: ping starts but `socket: Operation not permitted ... missing cap_net_raw+p`, because `no-new-privileges` stops a non-root user gaining the file capability. **C** the sysctl only: still `spawn EPERM`. **D** both: **works**, ping to the gateway answers in under 1 ms and Kuma shows Up. The working recipe is in "Container settings for Kuma" below. |
| 2. Read status from the status page JSON and `/metrics` | **Both work.** Status page JSON: `GET /api/status-page/<slug>` gives each monitor's id, name, type and tags (when "Show tags" is on); `GET /api/status-page/heartbeat/<slug>` gives the last 100 heartbeats per monitor (status 1 up / 0 down / 2 pending / 3 maintenance, UTC time, response time ms, message) and 24-hour uptime; no login. `/metrics` (read on the throwaway, where login is off; with login on it answers 401 and needs an API key sent as the basic-auth password) gives `monitor_status` (1/0/2/3) and `monitor_response_time` per monitor with labels `monitor_id`, `monitor_name`, `monitor_type`, `monitor_hostname`, `monitor_port`, plus cert expiry and uptime ratio. **`/metrics` has no tags**, so mapping a monitor to a site needs the status page JSON (tags) or a naming convention. |
| 3. Create a monitor through a third-party client | **Not tested yet.** Kuma has no REST endpoint for monitors: adding, editing and deleting go through its internal Socket.IO API and need the admin user name and password (an API key only opens `/metrics`). The project's wiki says that API is for the application's own use and may change between versions without notice. Python clients: `uptime-kuma-api` documents support only up to Kuma 1.23.2; the forks `uptime_kuma_api_v2` (targets 2.0.0-beta.2) and `uptime-kuma-api2` (v2.3.0, supported server versions not stated) are unofficial. None is documented against 2.5.7. |
| 4. Recommendation | Below. |

Monitor types in 2.5.7: http, keyword, port (TCP), ping, dns, snmp, push, manual, smtp, ntp, mqtt, docker, json-query and others.
There is **no SIP monitor**, as expected. Sources: Kuma wiki "Internal API", the Docker Hub tag list, the Kuma web UI.

## Recommendation (provisional until points 1 and 3 are tested)

Do not drive Kuma from Voxshift. Let engineers create monitors in Kuma (they already know it), tag each monitor, and have Voxshift
**read** the status page and draw the dashboard. That needs only the documented, public, read-only endpoints.

**Container settings for Kuma** (verified 2026-10-27 on the test host):

```yaml
kuma:
  image: louislam/uptime-kuma:2-rootless      # pin an exact 2.x tag in the installer
  read_only: true
  tmpfs: [/tmp]
  security_opt: [no-new-privileges:true]
  cap_drop: [ALL]
  cap_add: [NET_RAW]            # lets the ping binary start (it carries a file capability)
  sysctls:
    net.ipv4.ping_group_range: "1000 1000"   # lets the node user (gid 1000) send ICMP echo without the capability
  volumes: [kuma_data:/app/data]              # a named volume, so the rootless user can write it
```

Notes: `NET_RAW` alone is not enough and neither is the sysctl alone. The sysctl value is **host dependent**: on the test host (it
rejects ranges that are not mapped to it) `0 2147483647` and `0 65535` failed with `invalid argument` at container start, and
`1000 1000` worked, so the installer should set the range to the container user's gid, not a wide default, and check that the
container starts. Without a sysctl the fallback is to drop `no-new-privileges` for this one container, which is a worse trade.

**Phase 1: read-only dashboard.**
- Kuma runs as an optional service in the on-prem compose (behind a compose profile), on the internal Docker network with the same
  hardening as the other services. Its own web UI is not published to the LAN; engineers reach it through a port bound to localhost
  (SSH tunnel) for setup. Kuma is single-user, so it is never offered to customers directly.
- Each monitor carries tags: `site=<sitecode>` and `device=<algo|poly|dect|audiocodes|teams-room|other>`. They appear in the status
  page JSON, so no monitor ever needs creating by Voxshift.
- The worker polls the status page every 15-30 seconds, stores **state changes** (device, up/down, since when) in a new table, and the
  API serves them. Kuma's heartbeat window is only the last 100 beats (about 100 minutes at 60 s), so "since when" for a longer outage
  must come from Voxshift's own record of changes.
- The web app shows per-site tiles (green, red, amber for pending or maintenance) and a list of down devices with the time since.
- To meet "red within a minute", critical monitors need a 20-30 s interval (Kuma's minimum is 20 s) and Voxshift polls at 15 s.

**Phase 2: inventory and gaps.** A site device inventory in Design & Build (type, vendor, model, address, expected monitor), so
Voxshift can show devices that should be monitored but are not, and use the data Data Collection already has (subnets, VLANs, handset
models). Still no monitor creation by Voxshift.

**Phase 3: what Kuma cannot see.** SIP checks (a script feeding a push monitor), Teams sign-in state (Poly Lens or the Teams Rooms
portal through a push webhook), and raising incidents from a down device once the monitoring intake exists.

**If Kuma proves unworkable** (ping cannot run hardened, or tags are not enough): Gatus is configured by a file and has an API, so
Voxshift could generate its configuration from the inventory (HTTP, ICMP, TCP, DNS; push-based "external endpoints" for things it
cannot reach). It has no SNMP and no editing UI, which fits Voxshift being the control plane. Not tested. Zabbix with a proxy per
site is the heavyweight option and fits only if SNMP depth is needed. A native collector in the worker would give full control but
means building history, flapping rules and maintenance windows ourselves.

## Branding Kuma

Tried on the throwaway (2026-10-27). Kuma has no theme or branding setting for its own dashboard or login page: Settings >
Appearance offers only language, light/dark and heartbeat-bar style. The **status page** is brandable, and it is the page worth
showing to site staff:

- Files: `deploy/kuma/voxshift-status-page.css` (paste into status page > Edit > **Custom CSS**) and `deploy/kuma/voxshift-logo.png`
  (the brand tile, 512 px; upload by clicking the logo in the editor, which also becomes the page's favicon).
- Other settings used: title "Voxshift device status", a description, footer text "Voxshift · Microsoft Teams voice, migrated and
  managed", theme **Light**, **Show Tags** on, **Show Powered By** off (a setting Kuma provides).
- The CSS uses the Voxshift palette and Segoe UI, thin `#E3E3EC` dividers, a 7 px radius and white surfaces. Up and down colours are
  Kuma's own green and red on purpose.
- Not brandable without more work: the dashboard and login ("Uptime Kuma" name and logo). Injecting CSS through a reverse proxy
  would do it, but the card keeps other stacks out of scope, so it was not tried. The engineer-only dashboard stays plain
  Kuma; customers see Voxshift's own dashboard tiles (phase 1) or this status page.
- The two-tone `vox`+`shift` wordmark cannot be drawn by Kuma's title (plain text), so the page shows the tile and the text
  "Voxshift device status". A lockup image could replace the tile if one is made.

## Risks and open points

- **ICMP needs `NET_RAW`** under `cap_drop: ALL`; that is a small, well understood capability but a change from "all dropped".
- **Status page JSON is public** to anyone who can reach Kuma, and lists monitor names. Keeping Kuma on the internal network avoids it.
- **Kuma's public API is informal.** The status page JSON has been stable across 1.x and 2.x, but it is not a supported contract:
  pin the image tag, and add a test that parses a recorded sample so an upgrade that changes it is caught.
- Kuma stores its data in SQLite or MariaDB under `/app/data`; the installer's backups would need to include it.
- Teams Rooms and Poly Lens status need push or an API from those portals; not investigated.
- Alerting: Kuma can notify by itself (email, Teams, webhook). Whether Voxshift should also email, or raise an incident, is open.

## Not done

- **Point 3, creating a monitor through a third-party client**, was not run: it means installing an unofficial package and giving it
  the Kuma password. The recommendation does not depend on it (Voxshift does not create monitors). If wanted later, it would run
  in the engineer's own terminal against a throwaway Kuma.
- ICMP is the only check tested. Not tested: SNMP, TCP and HTTP monitors against real Algo, Poly, DECT or AudioCodes devices,
  Teams Rooms or Poly Lens status, and a down device's effect on the 15-30 s refresh.
- Hardened settings with the full-size image were tested on one host kernel; the sysctl behaviour needs a check on each target OS
  by the installer.

## Test environment

The throwaway stack `kuma-spike` (Dockge, port 3002, volume `kuma_spike_data`, login switched off on purpose, two test ping monitors)
is still running on the test host and is to be removed only when the user says so.
