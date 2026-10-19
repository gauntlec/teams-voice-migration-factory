# Installing Voxshift on a new Linux host

One script installs everything: Docker (if missing), the application, its database, and a web front door with HTTPS.
Used for a customer-premises install or any new host. The hosted service is run differently (Dockge, see
`deploy/dockge/README.md`).

## What you need

| | |
|---|---|
| Host | Linux on **x86-64** (the images are not built for ARM). Debian, Ubuntu, RHEL, Rocky, Alma, CentOS or Fedora get Docker installed for you; any other Linux needs Docker Engine and the compose plugin installed first. |
| Size | 4 GB RAM or more, 10 GB free disk, 2 CPUs. |
| Network | Outbound HTTPS to `ghcr.io` (the images) and to Docker's package sites. Inbound 80 and 443 from the people who will use it. If you will use the Voxshift Hub or single sign-on (optional, below): outbound HTTPS to `hub.voxshift.io`, and to your identity provider (for example `login.microsoftonline.com`) if you add one. The API also sends a site's street address to `nominatim.openstreetmap.org` (OpenStreetMap geocoding) when an engineer clicks *Get coordinates from address*, and people's browsers load map tiles from `*.tile.openstreetmap.org`; block those hosts if addresses must not leave, and enter coordinates by hand (see [SECURITY.md](SECURITY.md)). |
| A name | The address people will type, e.g. `https://voice.contoso.com`, with DNS pointing at the host. An IP address works too. |
| Root | Run with `sudo`. |

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/gauntlec/teams-voice-migration-factory/main/deploy/install/install.sh -o install.sh
sudo bash install.sh --base-url https://voice.contoso.com --admin-email admin@contoso.com
```

Leave the options out and it asks. When it finishes it prints the address, the sign-in name and a generated password
(also in `/opt/voxshift/.env`). Sign in, set up MFA when asked, then check **Administration > Platform settings**.

Re-running refuses if `/opt/voxshift` already has an installation (re-running would generate new secrets and lock you out of
stored data). To upgrade use `voxshift update`, or let the host do it for you (see [Automatic updates](#automatic-updates)).

### How the address is secured (`--tls`)

| Mode | Use when | Needs |
|---|---|---|
| `auto` (default) | | picks one of the next three from the address |
| `acme` | a public name | the name resolves to this host and ports 80/443 are reachable from the internet; a free Let's Encrypt certificate that renews itself |
| `internal` | an IP, or a private name (`.local`, `.lan`, no dot) | Voxshift's own private CA. Browsers warn until the root certificate is trusted: `cd /opt/voxshift && docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt .`, then install it as a trusted root on staff computers |
| `custom` | the customer has its own certificate | `--cert fullchain.pem --key key.pem` |
| `none` | a test install | an `http://` address (a port is allowed: `http://10.0.0.20:8080`). Passwords cross the network unencrypted. |

Caddy also sends browsers that arrive on port 80 to the https address (automatic in `acme`, `internal` and `custom`; `none` stays on plain http).

#### HSTS (`--hsts-max-age`)

Every https mode (`acme`, `internal`, `custom`) sends `Strict-Transport-Security: max-age=31536000` (one year) from the Caddyfile, so a browser
that has once reached the address over https will not try plain http again. It is **never** sent with `--tls none`. It is written without
`includeSubDomains` and without `preload` on purpose: those would also bind every other site on the customer's domain (and a preloaded name
cannot be taken back quickly), so they are not offered.

- `--hsts-max-age 600` uses another lifetime in seconds (a short value is sensible for the first days of a new install); `--hsts-max-age 0`
  does not send the header at all. The most allowed is 63072000 (two years).
- HSTS is set in this one place. The web container's nginx does not set it (it cannot tell whether the address is https) and the API's own
  header (helmet) has it switched off, so a browser sees exactly one value. If you put your own reverse proxy in front instead, set HSTS there.
- With HSTS a browser no longer lets a person click through a certificate warning for that address. For `internal`, install the root
  certificate on staff computers first (see above), and expect an expired `custom` certificate to lock people out until it is renewed.
- The value is written when the install is created. To change it later edit `/opt/voxshift/Caddyfile` (the `header Strict-Transport-Security` line in the
  site block; delete the line to switch it off) and run `cd /opt/voxshift && docker compose restart caddy`. Browsers keep honouring an
  earlier value until its time runs out; to cancel it early the site must send `max-age=0` over https for a while.

### Other options

`--admin-password`, `--acme-email`, `--hsts-max-age`, `--dir`, `--version latest|<yyyy.mm.N>|sha-<commit>` (for example `--version 2026.10.3`), the SMTP set (`--smtp-host --smtp-port --smtp-secure
--smtp-user --smtp-pass --mail-from`), `--no-docker-install`, `--open-firewall` (opens 80/443 in ufw or firewalld if active),
`--generate-only` (write the files and stop, to review), `--auto-update [daily|weekly]` / `--no-auto-update` (see below), `--refresh-command` (on an existing install: rewrite only the `voxshift` command) and `-y`. `bash install.sh --help` lists them.

## Starting again: removing an installation

```bash
curl -fsSL https://raw.githubusercontent.com/gauntlec/teams-voice-migration-factory/main/deploy/install/uninstall.sh -o uninstall.sh
sudo bash uninstall.sh --dry-run          # shows what would go, changes nothing
sudo bash uninstall.sh                    # lists it again and asks you to type DELETE
```

It removes the containers, the **database and stored files**, `/opt/voxshift` (including `.env` and its secrets) and the
`voxshift` command, so `install.sh` can then be run again on a clean host. It leaves Docker, your other containers and any
firewall rule you opened.

| Option | |
|---|---|
| `--backup-to DIR` | runs `voxshift backup DIR` first (needs a working install) |
| `--keep-certs` | keeps the certificate store, so a reinstall reuses the issued Let's Encrypt certificate (Let's Encrypt limits how many a name can get per week) |
| `--remove-images` | also deletes the downloaded images (the reinstall downloads them again) |
| `--dry-run`, `-y`, `--dir PATH` | |

The data volumes must go too: a new install generates a new database password, and an old database would not accept it.
The script refuses any directory that is not clearly a Voxshift install (it needs `compose.yaml` named `voxshift` and a `.env`), and refuses `/`, `/opt` and
other system directories.

## What gets installed

`/opt/voxshift` (mode 700):

| File | |
|---|---|
| `.env` | every setting and secret, freshly generated for this host (mode 600). **Back it up**: `DATA_ENCRYPTION_KEY` protects stored secrets and cannot be recovered. |
| `compose.yaml` | postgres, redis, api, worker, web and caddy. Only Caddy is published (80, and 443 with HTTPS). |
| `Caddyfile` | the front door and certificate handling |
| `voxshift` | the control command. A copy is installed as `/usr/local/bin/voxshift`, so it works from any directory and any user; it asks for `sudo` itself (the install directory is root-only) |

Everything restarts on its own after a reboot (`restart: unless-stopped`, Docker enabled at boot).

## Day to day: the `voxshift` command

| | |
|---|---|
| `voxshift status` | what is running |
| `voxshift update` | takes a backup, pulls the newest images, restarts, waits until it answers. Database migrations run on start. |
| `voxshift auto-update on [daily\|weekly]` / `off` / `status` | turns the automatic update job on or off, or shows its schedule and the last lines of its log |
| `voxshift self-update` | fetches the current installer and rewrites the `voxshift` command only (see Automatic updates) |
| `voxshift backup [DIR]` | database dump + stored files + `.env`, into `DIR/<timestamp>` (default `/opt/voxshift/backups`, last 14 kept). Copy it off the host. |
| `voxshift restart` | re-applies `.env` (use after editing it) |
| `voxshift reset-admin` | sets a new password for the first Super Admin and unlocks the account (recovery) |
| `voxshift logs [api\|worker\|web\|caddy]` | follow logs |
| `voxshift start` / `stop` | |

## Automatic updates

The installer asks "Install updates automatically every night?" (default **no**; with `-y` it only does it if you pass
`--auto-update`). Saying yes writes `/etc/cron.d/voxshift-update`, which runs `voxshift update --auto` once a day (or once a week with
`weekly`) at a quiet hour between 02:00 and 04:59, with the minute picked at random for this host so a fleet of installs does not all
pull at once. The job:

- pulls the newest images and **does nothing** if there is nothing new (it logs "already up to date");
- when there is a new version: takes a backup (`voxshift backup`, last 14 kept), restarts on the new images, waits until the
  application answers, then removes the old images. If the backup fails it does **not** update; if the application does not answer
  afterwards it says so in the log and leaves the backup from just before for you to restore;
- never runs twice at once, and skips itself when `IMAGE_TAG` in `.env` is an exact release (`2026.10.3` or `sha-...`), because there is
  nothing newer to fetch;
- writes one line per step to `/var/log/voxshift-update.log` (rotated monthly, six kept).

It installs cron (`cron` or `cronie`) if the host lacks it. Manage it any time with `voxshift auto-update on [daily|weekly]`,
`off` or `status`. Changing between daily and weekly keeps the same time of day. `uninstall.sh` removes the job.

Automatic updates apply database migrations without anyone watching, so for a system that must not change without a person
there (a change window, for example) leave it off and run `voxshift update` yourself. An installation that is also connected to a
Voxshift Hub keeps reporting its version there, so you can see who is behind. This installation's host needs outbound HTTPS to
`ghcr.io` for the job, the same as for a manual update.

### Installations made before this existed

Their `voxshift` command has no `auto-update` yet. Refresh just the command once (it touches no secrets, settings, data or
containers):

```bash
curl -fsSL https://raw.githubusercontent.com/gauntlec/teams-voice-migration-factory/main/deploy/install/install.sh -o install.sh
sudo bash install.sh --refresh-command            # add --auto-update to switch the nightly job on in the same step
```

From then on, `voxshift self-update` does the same thing in one word (it downloads the current installer from GitHub, checks
that it is intact, and rewrites only the command). Run it after a release that adds a command. It needs outbound HTTPS to
`raw.githubusercontent.com`, and it trusts the same source as the first install. It does not change the compose file, so an
installation made long ago keeps its old container settings; a fresh install is the way to get a newer compose file.

## Settings you will change after installing

- **Email**: set it up in the app, in Administration > Platform settings > Email (your own mail server, or the Voxshift Hub's mail service), and use "Send test". The installer's `--smtp-*` options and the `SMTP_*` values in `.env` still work as the starting point until something is saved there. Until email is set up none is delivered. The whole platform's email can be
  switched off in Administration > Platform settings.
- **Menus and features**: switch off the areas a customer's own installation does not need (the bug and feature boards, the MSP console) in Administration > Platform settings > Menus and features. See [PLATFORM-SETTINGS.md](PLATFORM-SETTINGS.md).
- **The hub**: to list this installation in a Voxshift Hub and see it online there, connect it in Administration > Platform settings > Voxshift hub. See [HUB-CONNECTION.md](HUB-CONNECTION.md).
- **Single sign-on (optional)**: to let people sign in with the Voxshift Hub, or with your own Microsoft Entra ID, Okta or Google Workspace, instead of a separate password here, follow [SSO-ADMIN-GUIDE.md](SSO-ADMIN-GUIDE.md): Administration > Platform settings > Single sign-on. Everything starts off, and the administrator made by the installer keeps password + authenticator sign-in whatever you choose (it is the "break-glass" account; keep its password safe). Do this after the web address is final, because providers return people to `<web address>/api/auth/oidc/callback`.
- **The web address**: change it in Administration > Platform settings (no restart). `WEB_ORIGIN` in `.env` is only the starting value. See [BASE-URL.md](BASE-URL.md).
- **The first admin's password**: `BOOTSTRAP_ADMIN_PASSWORD` in `.env` is used only to create the account on the first start. After that
  a restart never touches the account, so a password changed in the app stays. If it is lost, or the admin is locked out or
  disabled, run `voxshift reset-admin`: it asks for a new password (12+ characters, not stored in `.env`) and puts the
  account back (Super Admin, active, unlocked). Nothing else is needed. You may delete `BOOTSTRAP_ADMIN_PASSWORD` from `.env`
  once you have signed in, but the API then cannot create the admin on a brand-new empty database.

## Restoring

On a new host: run the installer, `voxshift stop`, put the backed-up `env` over `/opt/voxshift/.env` (the secrets must match the data),
then load the data:

```bash
cd /opt/voxshift
docker compose up -d postgres
docker compose exec -T postgres pg_restore -U tvmf -d tvmf --clean --if-exists < /path/to/database.dump
docker run --rm -v voxshift_filesdata:/data -v /path/to:/in alpine tar xzf /in/files.tar.gz -C /data
voxshift start
```

## Notes and limits

- The API trusts exactly two proxy hops (Caddy, then the web container's nginx) to learn the real client address. That is why Caddy is always
  the front door, even for plain http. Putting another reverse proxy in front of Caddy changes the hop count; ask before doing that.
- To remove it: `cd /opt/voxshift && docker compose down -v` deletes the containers **and all data**; then delete `/opt/voxshift`.
- The images are public on ghcr.io. A host with no internet access cannot use this installer as is.
- Tested file generation for every TLS mode and every input check on macOS; the full install (Docker, image pull, Caddy, health wait) needs a real Linux host.
