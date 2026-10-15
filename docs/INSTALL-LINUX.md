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

## What gets installed

`/opt/voxshift` (mode 700):

| File | |
|---|---|
| `.env` | every setting and secret, freshly generated for this host (mode 600). **Back it up**: `DATA_ENCRYPTION_KEY` protects stored secrets and cannot be recovered. |
| `compose.yaml` | postgres, redis, api, worker, web and caddy. Only Caddy is published (80, and 443 with HTTPS). |
| `Caddyfile` | the front door and certificate handling |
| `voxshift` | the control command, also linked as `/usr/local/bin/voxshift` |

Everything restarts on its own after a reboot (`restart: unless-stopped`, Docker enabled at boot).

## Day to day: the `voxshift` command

| | |
|---|---|
| `voxshift status` | what is running |
| `voxshift update` | takes a backup, pulls the newest images, restarts, waits until it answers. Database migrations run on start. |
| `voxshift backup [DIR]` | database dump + stored files + `.env`, into `DIR/<timestamp>` (default `/opt/voxshift/backups`, last 14 kept). Copy it off the host. |
| `voxshift restart` | re-applies `.env` (use after editing it) |
| `voxshift logs [api\|worker\|web\|caddy]` | follow logs |
| `voxshift start` / `stop` | |

## Settings you will change after installing

- **Email**: set `SMTP_HOST` (and the others) in `.env`, then `voxshift restart`. Until then no email is delivered. The whole platform's email can be
  switched off in Administration > Platform settings.
- **The web address**: change it in Administration > Platform settings (no restart). `WEB_ORIGIN` in `.env` is only the starting value. See [BASE-URL.md](BASE-URL.md).
- **The first admin's password**: `BOOTSTRAP_ADMIN_PASSWORD` in `.env` is applied on every start, so a password changed inside the
  app is put back to the `.env` one by a restart. To change it for good, edit `.env` and `voxshift restart`.

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
