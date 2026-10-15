# Installing Voxshift on a new Linux host

One script installs everything: Docker (if missing), the application, its database, and a web front door with HTTPS.
Used for a customer-premises install or any new host. The hosted service is run differently (Dockge, see
`deploy/dockge/README.md`).

## What you need

| | |
|---|---|
| Host | Linux on **x86-64** (the images are not built for ARM). Debian, Ubuntu, RHEL, Rocky, Alma, CentOS or Fedora get Docker installed for you; any other Linux needs Docker Engine and the compose plugin installed first. |
| Size | 4 GB RAM or more, 10 GB free disk, 2 CPUs. |
| Network | Outbound HTTPS to `ghcr.io` (the images) and to Docker's package sites. Inbound 80 and 443 from the people who will use it. |
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
stored data). To upgrade use `voxshift update`.

### How the address is secured (`--tls`)

| Mode | Use when | Needs |
|---|---|---|
| `auto` (default) | | picks one of the next three from the address |
| `acme` | a public name | the name resolves to this host and ports 80/443 are reachable from the internet; a free Let's Encrypt certificate that renews itself |
| `internal` | an IP, or a private name (`.local`, `.lan`, no dot) | Voxshift's own private CA. Browsers warn until the root certificate is trusted: `cd /opt/voxshift && docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt .`, then install it as a trusted root on staff computers |
| `custom` | the customer has its own certificate | `--cert fullchain.pem --key key.pem` |
| `none` | a test install | an `http://` address (a port is allowed: `http://10.0.0.20:8080`). Passwords cross the network unencrypted. |

### Other options

`--admin-password`, `--acme-email`, `--dir`, `--version latest|sha-<commit>`, the SMTP set (`--smtp-host --smtp-port --smtp-secure
--smtp-user --smtp-pass --mail-from`), `--no-docker-install`, `--open-firewall` (opens 80/443 in ufw or firewalld if active),
`--generate-only` (write the files and stop, to review) and `-y`. `bash install.sh --help` lists them.

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
| `voxshift backup [DIR]` | database dump + stored files + `.env`, into `DIR/<timestamp>` (default `/opt/voxshift/backups`, last 14 kept). Copy it off the host. |
| `voxshift restart` | re-applies `.env` (use after editing it) |
| `voxshift reset-admin` | sets a new password for the first Super Admin and unlocks the account (recovery) |
| `voxshift logs [api\|worker\|web\|caddy]` | follow logs |
| `voxshift start` / `stop` | |

## Settings you will change after installing

- **Email**: set it up in the app, in Administration > Platform settings > Email (your own mail server, or the Voxshift Hub's mail service), and use "Send test". The installer's `--smtp-*` options and the `SMTP_*` values in `.env` still work as the starting point until something is saved there. Until email is set up none is delivered. The whole platform's email can be
  switched off in Administration > Platform settings.
- **The hub**: to list this installation in a Voxshift Hub and see it online there, connect it in Administration > Platform settings > Voxshift hub. See [HUB-CONNECTION.md](HUB-CONNECTION.md).
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
