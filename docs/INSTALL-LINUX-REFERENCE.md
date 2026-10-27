# Voxshift on Linux: reference

The step-by-step guide is [INSTALL-LINUX.md](INSTALL-LINUX.md). This page holds the detail behind it: checking the installer, every installer
option, how the web address is secured, automatic updates, backups (including encrypted ones), restoring, and the limits of what has been tested.
You do not need it for a normal install.

## Network details

- **Outbound HTTPS from the server** to `ghcr.io` (the program images) and to Docker's package sites. If you use the Voxshift Hub or single sign-on
  (optional): also to `hub.voxshift.io`, and to your identity provider (for example `login.microsoftonline.com`).
- **Inbound 80 and 443** from the people who will use it.
- **Map data.** The API sends a site's street address to `nominatim.openstreetmap.org` (OpenStreetMap geocoding) when an engineer clicks
  *Get coordinates from address*, and people's browsers load map tiles from `*.tile.openstreetmap.org`. Block those hosts if addresses must
  not leave, and enter coordinates by hand (see [SECURITY.md](SECURITY.md)).
- **Supported hosts.** Linux on x86-64. 64-bit ARM (a Raspberry Pi 4 or 5) is experimental: see below. Debian, Ubuntu, RHEL, Rocky, Alma, CentOS and Fedora get Docker installed
  for you; any other Linux needs Docker Engine and the compose plugin installed first.

## Installer checks and pinning a release

Every release carries the installer files and a signed list of their checksums:

- `install.sh`, `uninstall.sh`: the installer and the removal script, exactly as at that release
- `SHA256SUMS`: the SHA-256 checksum of each of them
- `SHA256SUMS.sigstore.json`: a [Sigstore](https://www.sigstore.dev) signature of `SHA256SUMS`, made by the release job of this repository's build workflow (keyless: no secret key exists to be stolen)

**Check the checksum** (needs nothing but the Linux tools already on the host):

```bash
BASE=https://github.com/gauntlec/teams-voice-migration-factory/releases/latest/download
curl -fsSLO $BASE/install.sh
curl -fsSLO $BASE/SHA256SUMS
grep ' install.sh$' SHA256SUMS | sha256sum -c -        # must print: install.sh: OK
```

**Check the signature too** (optional; needs [`cosign`](https://docs.sigstore.dev/cosign/system_config/installation/)). This proves the checksum list was made by this
repository's release workflow and not by someone who merely uploaded a file:

```bash
curl -fsSLO $BASE/SHA256SUMS.sigstore.json
cosign verify-blob --bundle SHA256SUMS.sigstore.json \
  --certificate-identity https://github.com/gauntlec/teams-voice-migration-factory/.github/workflows/build-images.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  SHA256SUMS                                           # must print: Verified OK
```

Run the installer only after both say OK. If either fails, do not run it.

**Pin a release** instead of taking "the newest": put the release tag in the address, for example the release `2026.10.20` is tag `v2026.10.20`:

```bash
BASE=https://github.com/gauntlec/teams-voice-migration-factory/releases/download/v2026.10.20
```

and use `$BASE` in the commands above. A pinned address never changes, so it gives you the same installer tomorrow as today. (It only works for a
release that has these files attached; the first ones are those made after this feature was added. `--version 2026.10.20` is a separate thing: it
pins the program images the installer pulls.) Avoid the `main` branch address for anything that matters: it changes with every commit and is not signed.

What this does and does not prove: it shows the installer is the one this repository's release workflow published, and that it was not changed on
the way. It does not show the code is free of mistakes, and the first download still trusts GitHub (https) to be GitHub. The images the installer
pulls from `ghcr.io` carry build provenance and a bill of materials but are not signed with cosign.

`voxshift self-update` makes the same checks for you: it downloads `install.sh` from the newest release, compares it with that release's
`SHA256SUMS`, verifies the signature when `cosign` is installed (and tells you in one line when it is not), and stops without changing anything if
either check fails. Only when the newest release has no `SHA256SUMS` at all (one made before this existed) does it fall back, with a warning, to the
old unchecked source; it never falls back when checksums exist and do not match.

## How the address is secured (`--tls`)

- `auto` (the default) picks from the address:
  - an `http://` address: `none`;
  - an IP address, a name with no dot, or a name ending in a suffix used only inside networks (`.local`, `.lan`, `.internal`, `.intranet`, `.private`,
    `.corp`, `.home`, `.home.arpa`, `.lab`, `.localdomain`, `.test` and the other reserved ones): `internal`;
  - anything else: `acme`. The installer then checks that the name resolves from this host. If it does not, it **stops with a message** (it cannot tell a
    public name whose DNS is not set up yet from an internal name with an unusual suffix). Run it again with `--tls acme` (create the DNS record first),
    `--tls internal` or `--tls custom`.
  - It never silently chooses Let's Encrypt for a name it recognises as internal, and `--tls acme` for such a name is refused.
- `acme`: for a public name. The name must resolve to this host and ports 80/443 are reachable from the internet; a free Let's Encrypt certificate that renews itself
- `internal`: for an IP or a private name (`.local`, `.lan`, `.corp`, no dot, ...). Voxshift's own private CA. Browsers warn until the root certificate is trusted: `cd /opt/voxshift && docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt .`, then install it as a trusted root on staff computers
- `custom`: your own certificate (from a Microsoft CA or a public CA): `--cert fullchain.pem --key server.key`. How to get one: [INSTALL-LINUX.md, Step 2](INSTALL-LINUX.md#step-2-get-a-certificate-for-your-address).
- `selfsigned`: a self-signed certificate made on this server (RSA 2048, valid for exactly the address given as a name or an IP address, for server use only, not a certificate authority, 365 days unless `--selfsigned-days N`, 30 to 825). It is written to `/opt/voxshift/certs` (key mode 600) and used like `custom`. Browsers warn until each computer trusts it: `voxshift certificate export`, then the steps in [INSTALL-LINUX.md](INSTALL-LINUX.md#trusting-a-self-signed-certificate-install-d-or-e). It cannot be combined with `--cert` or `--key`, and an IPv6 address or a name longer than 64 characters is refused.
- `none`: a test install, with an `http://` address (a port is allowed: `http://10.0.0.20:8080`). Passwords cross the network unencrypted.

Caddy also sends browsers that arrive on port 80 to the https address (automatic in `acme`, `internal`, `custom` and `selfsigned`; `none` stays on plain http).

### HSTS (`--hsts-max-age`)

Every https mode (`acme`, `internal`, `custom`, `selfsigned`) sends `Strict-Transport-Security: max-age=31536000` (one year) from the Caddyfile, so a browser
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

## Installer options

`--admin-password`, `--acme-email`, `--hsts-max-age`, `--dir`, `--version latest|<yyyy.mm.N>|sha-<commit>` (for example `--version 2026.10.3`), the SMTP set (`--smtp-host --smtp-port --smtp-secure
--smtp-user --smtp-pass --mail-from`), `--no-docker-install`, `--open-firewall` (opens 80/443 in ufw or firewalld if active),
`--generate-only` (write the files and stop, to review), `--auto-update [daily|weekly]` / `--no-auto-update` (see below), `--backup-recipient KEY` (encrypt backups, see [Encrypting backups](#encrypting-backups-optional)), `--with-kuma`, `--kuma-port N`, `--kuma-web` and `--kuma-web-port N` (also install Uptime Kuma for device status, see below), `--refresh-command` (on an existing install: rewrite only the `voxshift` command) and `-y`. `bash install.sh --help` lists them.

## Removing an installation

```bash
curl -fsSL https://github.com/gauntlec/teams-voice-migration-factory/releases/latest/download/uninstall.sh -o uninstall.sh
sudo bash uninstall.sh --dry-run          # shows what would go, changes nothing
sudo bash uninstall.sh                    # lists it again and asks you to type DELETE
```

It removes the containers, the **database and stored files**, `/opt/voxshift` (including `.env` and its secrets) and the
`voxshift` command, so `install.sh` can then be run again on a clean host. It leaves Docker, your other containers and any
firewall rule you opened.

- `--backup-to DIR`: runs `voxshift backup DIR` first (needs a working install): the full backup described under Backups
- `--keep-certs`: keeps the certificate store, so a reinstall reuses the issued Let's Encrypt certificate (Let's Encrypt limits how many a name can get per week)
- `--remove-images`: also deletes the downloaded images (the reinstall downloads them again)
- `--dry-run`, `-y`, `--dir PATH`

The data volumes must go too: a new install generates a new database password, and an old database would not accept it.
The script refuses any directory that is not clearly a Voxshift install (it needs `compose.yaml` named `voxshift` and a `.env`), and refuses `/`, `/opt` and
other system directories.

## What gets installed

`/opt/voxshift` (mode 700):

- `.env`: every setting and secret, freshly generated for this host (mode 600). **Back it up**: `DATA_ENCRYPTION_KEY` protects stored secrets and cannot be recovered.
- `compose.yaml`: postgres, redis, api, worker, web and caddy. Only Caddy is published (80, and 443 with HTTPS).
- `compose.override.yaml`: only with `--with-kuma` or `voxshift kuma on`: Uptime Kuma for device status (see Device status below). Docker Compose merges it into `compose.yaml` by itself, so `voxshift update` and `restart` keep it
- `Caddyfile`: the front door and certificate handling
- `voxshift`: the control command. A copy is installed as `/usr/local/bin/voxshift`, so it works from any directory and any user; it asks for `sudo` itself (the install directory is root-only)

Everything restarts on its own after a reboot (`restart: unless-stopped`, Docker enabled at boot).

## Day to day: the `voxshift` command

- **`voxshift status`**: what is running
- **`voxshift update`**: takes a backup, pulls the newest images, restarts, waits until it answers. Database migrations run on start.
- **`voxshift auto-update on [daily|weekly]` / `off` / `status`**: turns the automatic update job on or off, or shows its schedule and the last lines of its log
- **`voxshift self-update`**: fetches the installer from the newest release, checks its checksum (and signature, with `cosign`) and rewrites the `voxshift` command only (see Automatic updates)
- **`voxshift backup [DIR]`**: everything needed to rebuild this installation, into `DIR/<timestamp>` (default `/opt/voxshift/backups`, last 14 kept): the database, the stored files, `.env`, `compose.yaml`, the `Caddyfile`, `certs/` (if you use your own certificate) and Caddy's data (its certificates and, for `--tls internal`, its own certificate authority), plus a `manifest.txt` with the date, the Voxshift release and a checksum of each file. Copy it off the host. It holds secrets and private keys. See Backups.
- **`voxshift backup-encryption on KEY | off | status | remove-unencrypted`**: optional: makes every backup an encrypted `.tar.age` file that only the owner of a private key (kept off this host) can open. See [Encrypting backups](#encrypting-backups-optional).
- **`voxshift restore FOLDER|FILE.tar.age [--identity KEYFILE] [--with-config] [--yes] [--force]`**: puts a backup back: checks it, takes a safety backup of today's state, asks you to type `RESTORE`, then restores the database, the stored files and `.env`, and starts everything. An encrypted backup also needs `--identity`. See Restoring.
- **`voxshift certificate status | selfsigned [--name N] [--days D] | install --cert FILE --key FILE [--force] | export [FILE]`**: `status` shows which certificate is in use and when it runs out (and says if it expires within 30 days). `selfsigned` makes a self-signed certificate on this server and uses it (also the way to renew one). `install` puts in your own certificate (full chain, PEM) and key after checking them: readable, key matches, not expired, valid for the address (wildcards understood), with a note when the chain is missing; it refuses otherwise and changes nothing. Both rewrite the `Caddyfile` site block and the certificate mount in `compose.yaml` for you, restart the front door, and put the previous `Caddyfile`, `compose.yaml` and `certs/` back (kept as `*.before-cert`) if the front door does not stay up. They work from any HTTPS mode, not from `--tls none`. `export` saves the public certificate (Voxshift's root certificate in `internal` mode) so computers can be told to trust it; a public (`acme`) certificate needs nothing. An installation made earlier needs `voxshift self-update` first.
- **`voxshift kuma on [--port N] [--web [PORT] | --no-web] | off [--delete-data] | status`**: device status: installs, removes or shows Uptime Kuma (see Device status below). An installation made earlier needs `voxshift self-update` first.
- **`voxshift restart`**: re-applies `.env` and the compose file (use after editing either); recreates the containers, so the site is unavailable for a short time
- **`voxshift reset-admin`**: sets a new password for the first Super Admin and unlocks the account (recovery)
- **`voxshift logs [api|worker|web|caddy]`**: follow logs
- `voxshift start` / `stop`

## Automatic updates

The installer asks "Install updates automatically every night?" (default **no**; with `-y` it only does it if you pass
`--auto-update`). Saying yes writes `/etc/cron.d/voxshift-update`, which runs `voxshift update --auto` once a day (or once a week with
`weekly`) at a quiet hour between 02:00 and 04:59, with the minute picked at random for this host so a fleet of installs does not all
pull at once. The job:

- pulls the newest images and **does nothing** if there is nothing new (it logs "already up to date");
- when there is a new version: takes a backup (`voxshift backup`, last 14 kept; the same full backup as by hand), restarts on the new images, waits until the
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
curl -fsSL https://github.com/gauntlec/teams-voice-migration-factory/releases/latest/download/install.sh -o install.sh
sudo bash install.sh --refresh-command            # add --auto-update to switch the nightly job on in the same step
```

From then on, `voxshift self-update` does the same thing in one word (it downloads the installer from the newest release, checks its
checksum and, if `cosign` is installed, the signature, and rewrites only the command; see [Installer checks](#installer-checks-and-pinning-a-release)). Run it after a release that adds a command. It needs outbound HTTPS to
`github.com` (and the download servers GitHub redirects to). It does not change the compose file, so an
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

## Device status (Uptime Kuma)

`--with-kuma` (or `voxshift kuma on` later) writes `/opt/voxshift/compose.override.yaml`, which adds one service, `kuma`, to the installation:

- **Image**: `louislam/uptime-kuma:2.5.7-rootless`, an exact version (the one device status was checked against). To use another, set `KUMA_IMAGE=<image:tag>` in `.env` and run `voxshift restart`. `voxshift update` pulls the pinned tag; it never moves to a newer Kuma by itself.
- **Hardening**: read-only root, all capabilities dropped except `NET_RAW`, `no-new-privileges`, and the sysctl `net.ipv4.ping_group_range "1000 1000"`. Ping needs both `NET_RAW` and that sysctl. A host that refuses the sysctl (`invalid argument` when the container starts) needs a different range: tell the Voxshift team which host it was.
- **Network**: Kuma's own port is published on `127.0.0.1` only (default 3001, `--kuma-port N` or `voxshift kuma on --port N` to change it). Voxshift's worker reaches it inside the installation at `http://kuma:3001`.
- **Kuma's screen for staff**: with `--kuma-web` (or `voxshift kuma on --web [PORT]`, default 8443) the web front door also serves it on its own port: a second site block in the `Caddyfile`, between `# BEGIN voxshift kuma` and `# END voxshift kuma`, with the same certificate settings as the main address, and the port added to the `caddy` service in `compose.override.yaml`. Staff open `https://<address>:8443` and sign in with Kuma's own account (Kuma supports 2FA). `voxshift certificate selfsigned|install` change the Kuma block's certificate together with the main one; `voxshift kuma on --no-web` and `voxshift kuma off` take the block out. Voxshift does not touch the firewall for this (`--open-firewall` at install time does open the port): open it for the networks staff use only, because anyone who reaches it sees Kuma's sign-in page. Without `--web`, reach Kuma through an SSH tunnel.
- **Reaching the devices**: Kuma checks devices by IP from this host, so the server must be able to reach the devices' network.
- **Data**: the named volume `voxshift_kumadata`. `voxshift backup` includes it (and the override file) and `voxshift restore` puts it back.
- `voxshift kuma off` removes the container and the override file but keeps the data volume, so `voxshift kuma on` brings the monitors back; add `--delete-data` to delete it. `voxshift kuma on` never overwrites a `compose.override.yaml` that Voxshift did not write.
- The checks for all of this are in `deploy/install/check-kuma.sh`, and the design is in [DEVICE-MONITORING.md](DEVICE-MONITORING.md).

## Backups

`voxshift backup` (and the automatic update, and `uninstall.sh --backup-to`) writes one folder, for example
`/opt/voxshift/backups/20261019-020512/`:

- `database.dump`: the whole database (every customer), as `pg_dump -Fc`
- `files.tar.gz`: the stored files (handover packs, logos, attachments)
- `env`: a copy of `.env`: the secrets. Without `DATA_ENCRYPTION_KEY` the stored secrets cannot be read
- `compose.yaml`, `Caddyfile`, `certs/`: how the containers and the web front door are set up (`certs/` only if you installed your own certificate)
- `caddy-data.tar.gz`: Caddy's data volume: the issued certificates and, for `--tls internal`, Voxshift's own certificate authority, so browsers that already trust it keep trusting it
- `kuma-data.tar.gz` and `compose.override.yaml`: only when device status (Kuma) is on: Kuma's monitors, status pages and history, and its settings file. Kuma is stopped for the few seconds the copy takes, so its database is not caught mid-write
- `manifest.txt`: the date, the Voxshift release (for example `2026.10.19`), and a `sha256` checksum of every other file

The folder and everything in it can only be read by root (700 / 600). **It contains the database, the passwords and keys and the private key
of your certificate: keep it somewhere safe and off this host** (a copy on the same disk does not survive the disk). The newest 14 backups
are kept in a folder; the safety backups that `voxshift restore` makes (`pre-restore-...`) are kept separately, the newest 3. Nothing else in
the folder is deleted. A backup is built in a `.partial` folder and renamed when it is complete, so a failed backup leaves nothing that
looks finished; `voxshift update` and the nightly job still stop when the backup fails. Backups made before this version have no
`compose.yaml`, Caddy data or manifest; they can still be restored (see below).

### Encrypting backups (optional)

By default a backup is a plain folder, readable by anyone who gets a copy of it. If you copy backups off the host (and you should), switch on
encryption: then every backup is **one file, `<timestamp>.tar.age`**, that nobody can open without a private key which is **never kept on the
Voxshift host**. The host holds only a *public* key: it can lock a backup but cannot unlock one, so someone who breaks into the host, or finds a
copy of the backup, cannot read the database, the secrets or the certificate private keys. It uses [age](https://age-encryption.org), a small,
widely reviewed encryption program.

**1. Make the key pair on your own computer, not on the Voxshift host** (install `age` there: `brew install age`, `apt install age`,
`dnf install age`, or download it from the age releases page):

```bash
age-keygen -o voxshift-backup-key.txt
```

It prints `Public key: age1...`. That line is the **public key**: safe to share, it goes on the Voxshift host. The file
`voxshift-backup-key.txt` holds the **private key** (a line starting `AGE-SECRET-KEY-`). Do not copy it to the Voxshift host. Keep it in a
password manager or a safe, and keep a second copy somewhere else (a different building or person). To make two people able to restore, make
two key pairs and give the host both public keys.

> **If every copy of the private key is lost, the encrypted backups cannot be read by anyone, including Voxshift. There is no reset and no
> back door.** A restore needs the private key, so test that you can find it: restore one backup on a test host before relying on it.

**2. Give the host the public key.** At install time: `--backup-recipient age1...` (it also asks when you run the installer in a terminal).
On an installation that exists already (one made before this feature needs `voxshift self-update` first, to get the new command):

```bash
sudo voxshift backup-encryption on age1...your-public-key
sudo voxshift backup-encryption status
```

`on` installs `age` from the system's own package repository if it is missing (Debian and Ubuntu: `apt`; RHEL, Rocky, Alma, CentOS: `dnf`/`yum`,
using EPEL when needed) and stops with a message if it cannot. It refuses a private key (a file or text starting `AGE-SECRET-KEY-`) so that one is
never left on the host. The public keys are kept in `/opt/voxshift/backup-recipients` (mode 600), not in `.env`. You can give several keys, or a file
with one key per line; any one of the matching private keys can open a backup. `voxshift backup-encryption off` switches it off again.

**What changes once it is on:**

- `voxshift backup`, the nightly update's backup, the safety backup that `voxshift restore` takes and `uninstall.sh --backup-to` all write a
  `<timestamp>.tar.age` file plus `<timestamp>.tar.age.sha256` beside it (the size and checksum, for checking a copy you moved). The files inside
  are the same as before (see the table above). The 14-backup and 3-safety-backup rotation works as before.
- While a backup is being built a plain working folder (`<timestamp>.partial`) exists in the backups folder, readable only by root; it is removed
  as soon as the encrypted file is written and checked. Voxshift cannot read the result back (it has no private key), so the check is that the file
  exists, is not empty, starts with the age header and is a plausible size.
- **It never falls back to a plain backup.** If encryption is on and `age` is missing or the key file is empty, `voxshift backup` stops with a
  message and writes nothing. The nightly update then does not update (the log says why), and `uninstall.sh --backup-to` stops before removing anything.
- Backups made *before* you switched it on stay plain folders until newer ones push them out of the 14. Remove them at once with
  `voxshift backup-encryption remove-unencrypted` (it lists them and asks you to type `DELETE`; copy anything you need first).
- The host's disk holds only the encrypted file, but the *database password and secrets on the running host* are of course still in `/opt/voxshift/.env`.
  Encryption protects the **backups** (the copies that travel), not the live host.
- After a total loss you reinstall, then restore with your private key, then run `voxshift backup-encryption on <public-key>` again (the key
  list is part of the host, not of the backup).

## Restoring

An installation made before `voxshift restore` existed gets it (and the fuller backup) with `voxshift self-update`; nothing else changes.

```bash
voxshift restore /opt/voxshift/backups/20261019-020512
```

An **encrypted** backup (`....tar.age`) is restored the same way, with the private key file you made with `age-keygen`:

```bash
voxshift restore /opt/voxshift/backups/20261019-020512.tar.age --identity /root/voxshift-backup-key.txt
```

Without `--identity` it stops, says the backup is encrypted and changes nothing. Voxshift opens the backup into a private, root-only folder next to
the backups (so the host needs room for one extra copy of it), checks it exactly like a plain backup (step 1 below), and **removes that opened copy
when the command ends, whether it finished, failed or was interrupted**. Copy the private key onto the host only for the restore and delete it afterwards.
A wrong key, or a damaged file, gives "could not be opened" and changes nothing. The safety backup taken before the restore is encrypted as well when
encryption is on; to go back to it, give the same `--identity`.

What it does, in order (nothing is changed until step 4):

1. Checks the folder is a Voxshift backup and every file matches its checksum in `manifest.txt` (a changed or damaged file stops it).
2. Compares the backup's release with the one running here. **A backup from a newer release is refused**: the database only moves forward, so
   the older program cannot use it. Update first (`voxshift update`), or set `IMAGE_TAG` in `.env` to that release or later and run
   `voxshift restart`, then restore again. A backup from an *older* release is fine; the migrations bring it up to date when the application
   starts. If a release cannot be read (a hand-built image, Voxshift not running) it stops and asks for `--force`.
3. Shows what will be replaced and asks you to type `RESTORE` (or pass `--yes`).
4. Takes a **safety backup** of the current state in `/opt/voxshift/backups/pre-restore-<time>`, stops `api` and `worker`, keeps a copy of
   today's `.env` as `.env.before-restore-<time>`, and puts the backup's `.env` in place. Two lines stay as they are on this host, because
   they must match the database already running here: `POSTGRES_PASSWORD` / `DATABASE_URL`, and `IMAGE_TAG` (which release runs).
5. Loads the database (`pg_restore --clean --if-exists`: the tables in the backup are dropped and recreated; a customer created after the
   backup stays behind as an unused schema that nothing refers to), then the stored files.
6. With **`--with-config`** also restores `compose.yaml`, the `Caddyfile`, `certs/` and Caddy's data (today's copies are kept as
   `*.before-restore-<time>`). Use it on a new host or after losing the web front door's settings; leave it out to keep this host's own
   network settings.
7. Starts everything again and waits until it answers, like `voxshift update`.

Everything entered after the backup was made is lost; Redis (the work queue) is not restored. If it does not turn out as you wanted, go
back with `voxshift restore /opt/voxshift/backups/pre-restore-<time>`. If it stops part-way it says so and names that folder.

**On a new host (the usual disaster-recovery case):** install Voxshift the normal way with the same version or newer, copy the backup folder
onto the host, then `voxshift restore <folder> --with-config`. The settings and secrets come from the backup, so the same sign-ins and
stored secrets work again. Check the web address in `.env` (`WEB_ORIGIN`) and in Administration > Platform settings still matches the new host.

**A backup made by an older version** (only `database.dump`, `files.tar.gz`, `env`): run `voxshift restore <folder> --force`. It cannot be
checked against a manifest and `--with-config` is not available for it.

By hand (if the command itself cannot run), the same steps are:

```bash
cd /opt/voxshift
voxshift stop
cp /path/to/env .env && chmod 600 .env          # keep this host's POSTGRES_PASSWORD / DATABASE_URL lines if it is a new host
docker compose up -d postgres
docker compose exec -T postgres pg_restore -U tvmf -d tvmf --clean --if-exists < /path/to/database.dump
docker run --rm -v voxshift_filesdata:/data -v /path/to:/in:ro alpine sh -c 'cd /data && rm -rf ./* && tar xzf /in/files.tar.gz -C /data'
voxshift start
```

## Notes and limits

- The API trusts exactly two proxy hops (Caddy, then the web container's nginx) to learn the real client address. That is why Caddy is always
  the front door, even for plain http. Putting another reverse proxy in front of Caddy changes the hop count; ask before doing that.
- To remove it: `cd /opt/voxshift && docker compose down -v` deletes the containers **and all data**; then delete `/opt/voxshift`.
- The images are public on ghcr.io. A host with no internet access cannot use this installer as is.
- Tested file generation for every TLS mode and every input check on macOS; the full install (Docker, image pull, Caddy, health wait) needs a real Linux host.
  The same goes for `voxshift backup` and `voxshift restore` against a real database: their logic (checks, order of steps, refusals, rotation) is tested with a
  stand-in `docker`, and the first real restore should be tried on a test host before it is relied on. `bash deploy/install/check-backup.sh` runs that
  stand-in check, including the encryption round trip with the real `age` program (it needs `age` on the machine running it).
  `bash deploy/install/check-selfupdate.sh` does the same for `voxshift self-update` (a stand-in `curl` and `cosign`); the real signature check needs a published, signed release.
- Found a security problem in Voxshift or its installer? Report it privately as described in [SECURITY.md](../SECURITY.md) (repository root); do not post it publicly.

## Raspberry Pi and other 64-bit ARM (experimental)

Voxshift images are also built for 64-bit ARM, but this is **experimental**: it has had no real-world use yet, so use x86-64 for anything that matters.

- **What you need:** a Raspberry Pi 4 or 5 running a **64-bit** operating system (Raspberry Pi OS Lite, 64-bit; `uname -m` prints `aarch64`). A 32-bit system (`armv7l`) is refused with a message.
  8 GB of memory is comfortable; 4 GB works for light use but PowerShell discovery runs will be slow. Use a **USB SSD**, not an SD card: the database writes all the time and wears a card out.
  Keep at least 10 GB free. The installer warns when it sees an SD card, little memory or little disk.
- **Install the usual way** (`INSTALL-LINUX.md`). On ARM64 the installer says so, installs Docker if needed, and checks that the release you are installing has ARM64 images before it starts pulling.
- **When a release has ARM64 images:** they are built a little after each normal release (about half an hour: a separate workflow on GitHub's ARM machines runs the same smoke test and vulnerability scan, then adds the ARM64 image to the release's tags). Until then the installer stops with a message ("has no ARM64 images"); try again later or use a newer release. The x86-64 images are never changed by this.
- **What differs from x86-64:** only the worker. Microsoft publishes no PowerShell container image for ARM, so the worker image unpacks Microsoft's own PowerShell 7.4 ARM64 release (the download is pinned to a SHA-256 taken from Microsoft's published checksum file) onto Debian 12. The Microsoft Teams module is the same version. It has not been tested against a live Microsoft tenant on ARM.
- **Everything else is the same:** updates (`voxshift update`), backups, restore, certificates. A backup made on x86-64 can be restored on ARM64 and the other way round (the database and files do not depend on the CPU).
