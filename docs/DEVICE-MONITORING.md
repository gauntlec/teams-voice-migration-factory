# Device status monitoring (spike)

Status: **spike in progress** (2026-10-27). Feature request: "Explore a real-time status dashboard for Teams-related equipment (Algo,
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
| 1. Kuma ping under our locked-down container settings | **Not answered yet.** The test host's Kuma is a default stack (`louislam/uptime-kuma:2`, root, no `cap_drop`, no `read_only`, no `security_opt`), so its working ping (response times of 0.08-15 ms) says nothing about hardened settings. Rootless images exist (`2-rootless`, `2-slim-rootless`). Expectation, to be tested: with `cap_drop: ALL` the `ping` binary needs `cap_add: NET_RAW` (the TrueNAS catalog lists NET_RAW for Kuma; a Railway report of `spawn EPERM` on a platform that blocks raw sockets points the same way). |
| 2. Read status from the status page JSON and `/metrics` | **Status page JSON: works, no login.** `GET /api/status-page/<slug>` gives each monitor's id, name, type and tags (when "Show tags" is on); `GET /api/status-page/heartbeat/<slug>` gives the last 100 heartbeats per monitor (status 1 up / 0 down / 2 pending / 3 maintenance, UTC time, response time ms, message) and 24-hour uptime. `/metrics` answers 401 without a key (HTTP basic auth, any user name, the API key as the password); there are no API keys on this Kuma yet, so reading it needs one created (Settings > API Keys). |
| 3. Create a monitor through a third-party client | **Not tested yet.** Kuma has no REST endpoint for monitors: adding, editing and deleting go through its internal Socket.IO API and need the admin user name and password (an API key only opens `/metrics`). The project's wiki says that API is for the application's own use and may change between versions without notice. Python clients: `uptime-kuma-api` documents support only up to Kuma 1.23.2; the forks `uptime_kuma_api_v2` (targets 2.0.0-beta.2) and `uptime-kuma-api2` (v2.3.0, supported server versions not stated) are unofficial. None is documented against 2.5.7. |
| 4. Recommendation | Below. |

Monitor types in 2.5.7: http, keyword, port (TCP), ping, dns, snmp, push, manual, smtp, ntp, mqtt, docker, json-query and others.
There is **no SIP monitor**, as expected. Sources: Kuma wiki "Internal API", the Docker Hub tag list, the Kuma web UI.

## Recommendation (provisional until points 1 and 3 are tested)

Do not drive Kuma from Voxshift. Let engineers create monitors in Kuma (they already know it), tag each monitor, and have Voxshift
**read** the status page and draw the dashboard. That needs only the documented, public, read-only endpoints.

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

## Risks and open points

- **ICMP needs `NET_RAW`** under `cap_drop: ALL`; that is a small, well understood capability but a change from "all dropped".
- **Status page JSON is public** to anyone who can reach Kuma, and lists monitor names. Keeping Kuma on the internal network avoids it.
- **Kuma's public API is informal.** The status page JSON has been stable across 1.x and 2.x, but it is not a supported contract:
  pin the image tag, and add a test that parses a recorded sample so an upgrade that changes it is caught.
- Kuma stores its data in SQLite or MariaDB under `/app/data`; the installer's backups would need to include it.
- Teams Rooms and Poly Lens status need push or an API from those portals; not investigated.
- Alerting: Kuma can notify by itself (email, Teams, webhook). Whether Voxshift should also email, or raise an incident, is open.

## To finish the spike

1. Run Kuma with the same hardening as the Voxshift services on the test host (a separate throwaway stack, one `ping` monitor) and
   record whether ping works with `cap_drop: ALL`, with and without `NET_RAW`, on the rootless image.
2. Create a Kuma API key on the test Kuma, read `/metrics`, and delete the key.
3. Try one `add_monitor` through `uptime-kuma-api2` against 2.5.7 and record whether it works.
