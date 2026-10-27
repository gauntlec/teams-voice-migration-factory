#!/usr/bin/env bash
# Voxshift installer for a new Linux host (Debian/Ubuntu, RHEL/Rocky/Alma/CentOS/Fedora, or any Linux that already has Docker).
#
#   curl -fsSL https://github.com/gauntlec/teams-voice-migration-factory/releases/latest/download/install.sh -o install.sh
#   sudo bash install.sh --base-url https://voice.contoso.com --admin-email admin@contoso.com
#
# To check the download first (checksum, and the signature if you have cosign), see "Installer checks" in docs/INSTALL-LINUX-REFERENCE.md.
# (A release made before installers were attached to releases has no install.sh: use the file under deploy/install/ on the main branch for that one case.)
#
# What it does: installs Docker if missing, writes /opt/voxshift (compose file, Caddy front door, .env with freshly
# generated secrets), pulls the images from ghcr.io, starts everything, waits until it answers, and installs the
# `voxshift` command (status / update / backup / restore / logs ...). Safe to read first; it asks before doing anything unusual.
# Full guide: docs/INSTALL-LINUX.md.
set -Eeuo pipefail

VERSION_OF_INSTALLER="1.0"
IMAGE_OWNER="gauntlec"

# ---------------------------------------------------------------------------------------------------------- defaults
DIR="/opt/voxshift"
BASE_URL=""
ADMIN_EMAIL=""
ADMIN_PASSWORD=""
TLS="auto"            # auto | none | acme | internal | custom | selfsigned
SELFSIGNED_DAYS="365"  # how long a --tls selfsigned certificate lasts
CERT_FILE=""
KEY_FILE=""
ACME_EMAIL=""
HSTS_MAX_AGE="31536000"   # seconds; 0 = no Strict-Transport-Security header. Only ever sent over https.
TAG="latest"
INSTALL_DOCKER=1
OPEN_FIREWALL=0
START=1
ASSUME_YES=0
SMTP_HOST="" SMTP_PORT="587" SMTP_SECURE="false" SMTP_USER="" SMTP_PASS="" MAIL_FROM_ADDR=""
GENERATED_ADMIN_PASSWORD=0
ARM64=0               # 1 on a 64-bit ARM host (experimental)
REFRESH=0
WITH_KUMA=0           # 1 = also write compose.override.yaml with Uptime Kuma (device status)
KUMA_PORT="3001"      # the host-only (127.0.0.1) port Kuma's screen is published on
KUMA_WEB_PORT=""      # set = also serve Kuma's screen through the web front door (Caddy) on this port, https like the main address
KUMA_IMAGE_DEFAULT="louislam/uptime-kuma:2.5.7-rootless"   # the version device status was checked against; kept in step with the generated command
AUTO_UPDATE=""        # "" = ask (interactive) or no | daily | weekly | no
BACKUP_RECIPIENTS=()  # public keys (or files of them) that backups are encrypted to; empty = backups are not encrypted

# ---------------------------------------------------------------------------------------------------------- helpers
if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'; else B=""; G=""; Y=""; R=""; N=""; fi
say()  { printf '%s\n' "$*"; }
step() { printf '\n%s==> %s%s\n' "$B" "$*" "$N"; }
ok()   { printf '%s  ok%s  %s\n' "$G" "$N" "$*"; }
warn() { printf '%s  !!%s  %s\n' "$Y" "$N" "$*" >&2; }
die()  { printf '%s  error%s  %s\n' "$R" "$N" "$*" >&2; exit 1; }
trap 'die "Stopped at line $LINENO. Nothing is half-installed that re-running this script cannot fix; the log above says what failed."' ERR

usage() {
  cat <<EOF
Voxshift installer $VERSION_OF_INSTALLER

Usage: sudo bash install.sh [options]

Required (asked for if you run it in a terminal and leave them out):
  --base-url URL         The address people will use, e.g. https://voice.contoso.com or http://10.0.0.20
  --admin-email EMAIL    The first Super Admin's email address (their sign-in name)

Common:
  --admin-password PW    At least 12 characters. Generated and shown once if you leave it out.
  --tls MODE             How the web address is secured (default: auto)
                           auto      http -> none; https + an IP, a name with no dot or an internal suffix (.local .lan .corp ...) -> internal;
                                     any other name -> acme, but only if it resolves from this host (else it stops: choose --tls yourself)
                           none      plain http (a test install, or behind a network you trust)
                           acme      a free Let's Encrypt certificate (the host must be reachable from the internet on 80/443)
                           internal  a certificate from Voxshift's own private CA (staff browsers must trust it once)
                           custom    your own certificate: --cert FILE --key FILE
                           selfsigned  a self-signed certificate made on this server (browsers must be told to trust it; see --selfsigned-days)
  --cert FILE --key FILE Certificate (full chain, PEM) and private key for --tls custom
  --selfsigned-days N    How long a --tls selfsigned certificate lasts (default 365; 30 to 825)
  --acme-email EMAIL     Contact address for Let's Encrypt expiry notices (acme)
  --hsts-max-age SECONDS Strict-Transport-Security for every https mode (default 31536000 = one year; 0 = do not send it). Never
                         sent for --tls none. Deliberately without includeSubDomains and preload: those would also bind every
                         other site on the same domain.
  --dir PATH             Install directory (default $DIR)
  --version TAG          Image tag: latest (default), a release such as 2026.10.3 (yyyy.mm.N), or sha-<commit>

Email (optional; can be set later in $DIR/.env, and switched off in Administration > Platform settings):
  --smtp-host H --smtp-port P --smtp-secure true|false --smtp-user U --smtp-pass PW --mail-from ADDR

Updates:
  --auto-update [daily|weekly]  Install a cron job that updates Voxshift by itself (default daily, at a quiet hour
                         between 02:00 and 04:59 chosen at random for this host). It backs up first, and only
                         restarts when a new version is out. Change or remove it later: voxshift auto-update
  --no-auto-update       Do not install the update job (the default when you answer no or run with -y)

Backups:
  --backup-recipient KEY Encrypt every backup to this PUBLIC key (starts with age1; or a file of public keys). Make the key pair on
                         your own computer with age-keygen and keep the private key OFF this host. Can be given more than once.
                         Installs the 'age' program if it is missing. Change it later: voxshift backup-encryption

Device status (optional):
  --with-kuma            Also install Uptime Kuma, which checks the customer's phones, paging units and gateways from inside the network
                         (Monitoring reads it). Written to compose.override.yaml, published on this host only (127.0.0.1).
                         Add it to an existing installation later with: voxshift kuma on
  --kuma-port N          The host-only port for Kuma's screen (default 3001; 1024-65535), when 3001 is already used
  --kuma-web             Also open Kuma's screen to staff through the web front door, on its own port (8443), with the same certificate as the
                         main address and Kuma's own sign-in, so nobody needs an SSH tunnel. Anyone who can reach that port can see the sign-in
                         page: open it in the firewall only to the networks staff use. Change it later: voxshift kuma on --web [PORT] / --no-web
  --kuma-web-port N      As --kuma-web, on port N (1024-65535)

Existing installation:
  --refresh-command      Only rewrite the 'voxshift' command (and, with --auto-update, switch the update job on). Touches no
                         secrets, settings or containers. Normally run for you by: voxshift self-update

Other:
  --no-docker-install    Do not install Docker; stop if it is missing
  --open-firewall        Open ports 80/443 in ufw or firewalld if one is active
  --generate-only        Write the files, but do not install Docker or start anything (for review)
  -y, --yes              Do not ask questions; use defaults
  -h, --help             This text
EOF
}

# ---------------------------------------------------------------------------------------------------------- the voxshift command
# make_selfsigned NAME DAYS OUTDIR: writes OUTDIR/server.crt and OUTDIR/server.key, a self-signed certificate valid for that name or IP address.
# (The generated 'voxshift' command has the same function, cert_make_selfsigned: keep the two in step; check-certificate.sh compares them.)
make_selfsigned() {
  local name="$1" days="$2" out="$3" san cnf
  name="${name#\[}"; name="${name%\]}"
  case "$name" in *:*) san="IP:$name" ;; *[!0-9.]*) san="DNS:$name" ;; *) san="IP:$name" ;; esac
  cnf="$out/server.cnf"
  printf '[req]\ndistinguished_name = dn\nx509_extensions = v3\nprompt = no\n[dn]\nCN = %s\n[v3]\nsubjectAltName = %s\nbasicConstraints = critical,CA:FALSE\nkeyUsage = critical,digitalSignature,keyEncipherment\nextendedKeyUsage = serverAuth\nsubjectKeyIdentifier = hash\n' "$name" "$san" > "$cnf"
  if ! ( umask 077; openssl req -x509 -newkey rsa:2048 -nodes -days "$days" -keyout "$out/server.key" -out "$out/server.crt" -config "$cnf" >/dev/null 2>&1 ); then rm -f "$cnf"; return 1; fi
  rm -f "$cnf"
}

# kuma_override PORT: the text of compose.override.yaml (Uptime Kuma for device status).
# (The generated 'voxshift' command has the same function: keep the two in step; check-kuma.sh compares them.)
kuma_override() {
  local port="$1" webport="${2:-}"
  cat <<EOF
# Written by Voxshift (install.sh --with-kuma, or: voxshift kuma on). Remove it with: voxshift kuma off
# Uptime Kuma checks the customer's phones, paging units and gateways from inside this network, and Voxshift reads its status page
# (Monitoring > Set up automatically; Voxshift makes Kuma's administrator and keeps its monitors in step with the device list). Docker Compose merges this file into compose.yaml by itself, so 'voxshift update' and
# 'voxshift restart' keep it. Kuma's own port is published to this host only (127.0.0.1). Its screen is reached either through the web front door
# (voxshift kuma on --web: https://<address>:<port>, Kuma's own sign-in) or, without that, through an SSH tunnel.
# To use another Kuma version, put KUMA_IMAGE=<image:tag> in .env.
# Ping needs BOTH NET_RAW and the ping_group_range setting while every capability is dropped (checked on Kuma $KUMA_IMAGE_DEFAULT); some hosts refuse
# other ranges.
services:
  kuma:
    image: \${KUMA_IMAGE:-$KUMA_IMAGE_DEFAULT}
    restart: unless-stopped
    environment:
      UPTIME_KUMA_DB_TYPE: sqlite
    read_only: true
    tmpfs:
      - /tmp
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    cap_add:
      - NET_RAW
    sysctls:
      net.ipv4.ping_group_range: "1000 1000"
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
    ports:
      - "127.0.0.1:$port:3001"
    volumes:
      - kumadata:/app/data
$( [ -z "$webport" ] || printf '  caddy:\n    ports:\n      - "%s:%s"\n' "$webport" "$webport" )
volumes:
  kumadata:
EOF
}
# kuma_caddy_block HOST MODE WEBPORT: the Caddyfile site block that serves Kuma's screen on its own port, with the same certificate settings
# as the main address (MODE: none | acme | internal | custom). Marked so 'voxshift kuma' can find and remove it again.
kuma_caddy_block() {
  local host="$1" mode="$2" webport="$3" addr tlsline=""
  case "$mode" in
    none) addr=":$webport" ;;
    internal) addr="$host:$webport"; tlsline="	tls internal" ;;
    custom) addr="$host:$webport"; tlsline="	tls /certs/server.crt /certs/server.key" ;;
    *) addr="$host:$webport" ;;
  esac
  printf '# BEGIN voxshift kuma (voxshift kuma on --web; remove with: voxshift kuma on --no-web)\n%s {\n' "$addr"
  [ -z "$tlsline" ] || printf '%s\n' "$tlsline"
  printf '\tencode gzip\n\treverse_proxy kuma:3001\n}\n# END voxshift kuma\n'
}

write_command() {
# --- the control command
cat > "$DIR/voxshift" <<'CTL'
#!/usr/bin/env bash
# Control command for this Voxshift installation. Run 'voxshift help'.
set -Eeuo pipefail
DIR="@@DIR@@"   # filled in by install.sh
# Everything here needs root (the install directory is root-only), so ask for it rather than failing.
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || { echo "voxshift needs root. Run it as root." >&2; exit 1; }
  exec sudo "$0" "$@"
fi
ORIG_PWD="$PWD"
cd "$DIR"
dc() { docker compose "$@"; }
need_root() { [ "$(id -u)" -eq 0 ] || { echo "Run as root: sudo voxshift $*" >&2; exit 1; }; }

# ----- device status: Uptime Kuma, as a compose.override.yaml that Docker Compose merges by itself
KUMA_IMAGE_DEFAULT="louislam/uptime-kuma:2.5.7-rootless"
# kuma_override PORT: the text of compose.override.yaml (Uptime Kuma for device status). Same text as the installer's: check-kuma.sh compares them.
kuma_override() {
  local port="$1" webport="${2:-}"
  cat <<EOF
# Written by Voxshift (install.sh --with-kuma, or: voxshift kuma on). Remove it with: voxshift kuma off
# Uptime Kuma checks the customer's phones, paging units and gateways from inside this network, and Voxshift reads its status page
# (Monitoring > Set up automatically; Voxshift makes Kuma's administrator and keeps its monitors in step with the device list). Docker Compose merges this file into compose.yaml by itself, so 'voxshift update' and
# 'voxshift restart' keep it. Kuma's own port is published to this host only (127.0.0.1). Its screen is reached either through the web front door
# (voxshift kuma on --web: https://<address>:<port>, Kuma's own sign-in) or, without that, through an SSH tunnel.
# To use another Kuma version, put KUMA_IMAGE=<image:tag> in .env.
# Ping needs BOTH NET_RAW and the ping_group_range setting while every capability is dropped (checked on Kuma $KUMA_IMAGE_DEFAULT); some hosts refuse
# other ranges.
services:
  kuma:
    image: \${KUMA_IMAGE:-$KUMA_IMAGE_DEFAULT}
    restart: unless-stopped
    environment:
      UPTIME_KUMA_DB_TYPE: sqlite
    read_only: true
    tmpfs:
      - /tmp
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    cap_add:
      - NET_RAW
    sysctls:
      net.ipv4.ping_group_range: "1000 1000"
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
    ports:
      - "127.0.0.1:$port:3001"
    volumes:
      - kumadata:/app/data
$( [ -z "$webport" ] || printf '  caddy:\n    ports:\n      - "%s:%s"\n' "$webport" "$webport" )
volumes:
  kumadata:
EOF
}
# kuma_caddy_block HOST MODE WEBPORT: the Caddyfile site block that serves Kuma's screen on its own port, with the same certificate settings
# as the main address (MODE: none | acme | internal | custom). Marked so 'voxshift kuma' can find and remove it again.
kuma_caddy_block() {
  local host="$1" mode="$2" webport="$3" addr tlsline=""
  case "$mode" in
    none) addr=":$webport" ;;
    internal) addr="$host:$webport"; tlsline="	tls internal" ;;
    custom) addr="$host:$webport"; tlsline="	tls /certs/server.crt /certs/server.key" ;;
    *) addr="$host:$webport" ;;
  esac
  printf '# BEGIN voxshift kuma (voxshift kuma on --web; remove with: voxshift kuma on --no-web)\n%s {\n' "$addr"
  [ -z "$tlsline" ] || printf '%s\n' "$tlsline"
  printf '\tencode gzip\n\treverse_proxy kuma:3001\n}\n# END voxshift kuma\n'
}

kuma_enabled() { [ -f "$DIR/compose.override.yaml" ] && grep -q '^  kuma:' "$DIR/compose.override.yaml"; }
kuma_port() { sed -n 's/^ *- "127\.0\.0\.1:\([0-9]*\):3001"$/\1/p' "$DIR/compose.override.yaml" 2>/dev/null | head -n 1 || true; }
# The port Kuma's screen is served on through the web front door (empty = not served there).
kuma_web_port() { sed -n 's/^      - "\([0-9]*\):\1"$/\1/p' "$DIR/compose.override.yaml" 2>/dev/null | head -n 1 || true; }
kuma_state() { dc ps kuma 2>/dev/null | grep -q 'healthy' && echo healthy || { dc ps kuma 2>/dev/null | grep -q ' kuma\| kuma-' && echo "running, not healthy yet" || echo "not running"; }; }
# kuma_web_sync: make the Caddyfile agree with compose.override.yaml (a Kuma site block when the override publishes a web port, none otherwise).
kuma_web_sync() {
  local wp tmpf mode host
  wp="$(kuma_web_port)"
  tmpf="$(mktemp "$DIR/.Caddyfile.XXXXXX")"
  awk '/^# BEGIN voxshift kuma/ {skip=1} !skip {print} /^# END voxshift kuma/ {skip=0}' Caddyfile > "$tmpf"
  if [ -n "$wp" ]; then
    host="$(cert_host)"; mode="$(cert_mode)"
    if [ "$mode" != none ] && [ -z "$host" ]; then rm -f "$tmpf"; echo "Could not read the web address from the Caddyfile." >&2; return 1; fi
    kuma_caddy_block "$host" "$mode" "$wp" >> "$tmpf"
  fi
  cat "$tmpf" > Caddyfile; rm -f "$tmpf"
}
kuma_cmd() {
  local sub="${1:-help}" port="" web="" noweb=0 old="" oldcf="" delete=0 n url mode host
  shift || true
  case "$sub" in
    on)
      need_root kuma on
      while [ $# -gt 0 ]; do
        case "$1" in
          --port) port="${2:-}"; shift 2 ;;
          --web) case "${2:-}" in ''|--*) web="8443"; shift ;; *) web="$2"; shift 2 ;; esac ;;
          --no-web) noweb=1; shift ;;
          *) echo "Use: voxshift kuma on [--port N] [--web [PORT] | --no-web]" >&2; exit 1 ;;
        esac
      done
      # What is already set up is kept unless you say otherwise.
      [ -n "$port" ] || port="$(kuma_port)"; [ -n "$port" ] || port="3001"
      if [ "$noweb" = 1 ]; then web=""; elif [ -z "$web" ]; then web="$(kuma_web_port)"; fi
      case "$port" in ''|*[!0-9]*) echo "--port must be a whole number from 1024 to 65535." >&2; exit 1 ;; esac
      { [ "$port" -ge 1024 ] && [ "$port" -le 65535 ]; } || { echo "--port must be from 1024 to 65535." >&2; exit 1; }
      if [ -n "$web" ]; then
        case "$web" in *[!0-9]*) echo "--web must be a whole number from 1024 to 65535." >&2; exit 1 ;; esac
        { [ "$web" -ge 1024 ] && [ "$web" -le 65535 ]; } || { echo "--web must be from 1024 to 65535." >&2; exit 1; }
        [ "$web" != "$port" ] || { echo "--web and --port must differ." >&2; exit 1; }
      fi
      if [ -f compose.override.yaml ] && ! grep -q '^# Written by Voxshift' compose.override.yaml; then
        echo "compose.override.yaml already exists here and was not written by Voxshift, so it was left alone. Nothing changed." >&2; exit 1
      fi
      if [ -f compose.override.yaml ]; then old="$(mktemp "$DIR/.override.XXXXXX")"; cp compose.override.yaml "$old"; fi
      oldcf="$(mktemp "$DIR/.Caddyfile.old.XXXXXX")"; cp Caddyfile "$oldcf"
      kuma_override "$port" "$web" > compose.override.yaml.new && mv compose.override.yaml.new compose.override.yaml
      chmod 644 compose.override.yaml
      if ! kuma_web_sync || ! dc config -q >/dev/null 2>&1 || ! dc up -d kuma caddy; then
        if [ -n "$old" ]; then cp "$old" compose.override.yaml; else rm -f compose.override.yaml; fi
        cp "$oldcf" Caddyfile; rm -f "$old" "$oldcf"
        dc up -d caddy >/dev/null 2>&1 || true
        echo "Kuma could not be started, so nothing was changed. If a port is in use, try: voxshift kuma on --port <another port>   (and --web <another port>)" >&2; exit 1
      fi
      rm -f "$old" "$oldcf"
      for n in $(seq 1 24); do [ "$(kuma_state)" = healthy ] && break; sleep 5; done
      echo "Kuma is $(kuma_state)."
      echo
      echo "Next:"
      echo "  1. In Voxshift open Monitoring and press 'Set up automatically'. Voxshift creates Kuma's administrator and the status page itself."
      echo "  2. Press 'Add a device' for each phone, paging unit or gateway (site, name, kind, ping or TCP port, address). Nothing to set up in Kuma by hand."
      if [ -n "$web" ]; then
        mode="$(cert_mode)"; host="$(cert_host)"; url="https://${host}:$web"; [ "$mode" != none ] || url="http://<this server>:$web"
        echo "  Kuma's own screen (only if you want to look at it) is at $url."
        echo "     Open port $web in this server's firewall for the networks your staff use (this command does not change the firewall; with ufw: ufw allow $web/tcp)."
        echo "     Anyone who can reach that port sees Kuma's sign-in page, so keep it to staff networks."
      else
        echo "  Kuma's own screen (only if you want to look at it) is on this server only: serve it through the web front door with 'voxshift kuma on --web',"
        echo "     or open a tunnel from your own computer:  ssh -L $port:127.0.0.1:$port <you>@<this server>   then browse to http://localhost:$port"
      fi
      echo "Backups made by 'voxshift backup' now include Kuma's data and this file."
      ;;
    off)
      need_root kuma off
      while [ $# -gt 0 ]; do
        case "$1" in
          --delete-data) delete=1; shift ;;
          *) echo "Use: voxshift kuma off [--delete-data]" >&2; exit 1 ;;
        esac
      done
      kuma_enabled || { echo "Kuma is not switched on here (no compose.override.yaml)."; exit 0; }
      dc rm -sf kuma >/dev/null 2>&1 || true
      rm -f compose.override.yaml
      kuma_web_sync || true
      dc up -d caddy >/dev/null 2>&1 || true
      echo "Kuma is stopped and removed from this installation."
      if [ "$delete" = 1 ]; then docker volume rm voxshift_kumadata >/dev/null 2>&1 && echo "Its data (monitors, history) is deleted." || echo "Its data volume could not be removed (it may not exist)."
      else echo "Its data (monitors, history) is kept in the Docker volume voxshift_kumadata: 'voxshift kuma on' brings it all back. To delete it too: voxshift kuma off --delete-data"; fi
      ;;
    status)
      if kuma_enabled; then
        echo "Kuma:     switched on, $(kuma_state)"
        n="$(kuma_web_port)"
        if [ -n "$n" ]; then
          mode="$(cert_mode)"; host="$(cert_host)"
          if [ "$mode" = none ]; then echo "Screen:   http://<this server>:$n (through the web front door)"; else echo "Screen:   https://$host:$n (through the web front door; Kuma's own sign-in)"; fi
          echo "          also http://127.0.0.1:$(kuma_port) on this server"
        else
          echo "Screen:   http://127.0.0.1:$(kuma_port) on this server only (SSH tunnel, or: voxshift kuma on --web)"
        fi
        echo "Voxshift: Monitoring, address http://kuma:3001"
      else
        echo "Kuma:     not switched on. To add it: voxshift kuma on"
      fi
      ;;
    *)
      cat <<EOF
voxshift kuma <command>
  on [--port N] [--web [PORT] | --no-web]
                         install Uptime Kuma (device status): writes compose.override.yaml, starts it, tells you what to do next.
                         Its own port is on this host only (127.0.0.1, 3001 unless you choose another). --web also serves its screen through the
                         web front door on its own port (8443 unless you choose another), with the main address's certificate and Kuma's own
                         sign-in, so staff need no SSH tunnel; --no-web takes that away again
  off [--delete-data]    stop and remove it (its data stays in a Docker volume unless you add --delete-data)
  status                 whether it is on, where its screen is, and its state
EOF
      ;;
  esac
}

wait_ready() {
  printf 'Waiting for Voxshift to answer'
  for _ in $(seq 1 60); do
    # Capture first: wget exits non-zero on the 401 we are waiting for, which under pipefail would hide grep's match.
    out="$(dc exec -T web wget -q -O /dev/null -S http://127.0.0.1/api/auth/me 2>&1 || true)"
    case "$out" in *" 401 "*) echo ' - up.'; return 0 ;; esac
    printf '.'; sleep 5
  done
  echo; echo "Not answering after 5 minutes. See: voxshift logs api" >&2; return 1
}

stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Anything half-made (a backup being built, a decrypted copy being restored) is removed however this command ends: normally, on an error, or
# when it is interrupted. Every place that makes such a thing registers it here and forgets it when it is finished with it.
TMP_PATHS=()
track_tmp() { TMP_PATHS+=("$1"); }
forget_tmp() { local p keep=(); for p in ${TMP_PATHS[@]+"${TMP_PATHS[@]}"}; do [ "$p" = "$1" ] || keep+=("$p"); done; TMP_PATHS=(${keep[@]+"${keep[@]}"}); }
cleanup() { local p; for p in ${TMP_PATHS[@]+"${TMP_PATHS[@]}"}; do [ -z "$p" ] || rm -rf -- "$p"; done; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

CRON_FILE=/etc/cron.d/voxshift-update
LOG_FILE=/var/log/voxshift-update.log

# The ids of every image this install uses, as they are on disk right now (to see whether a pull brought anything new).
image_ids() { for i in $(dc config --images 2>/dev/null | sort -u); do docker image inspect -f '{{.Id}}' "$i" 2>/dev/null || echo "$i missing"; done; }

# Cron has to exist and be running, or the job would silently never fire.
ensure_cron() {
  if command -v systemctl >/dev/null 2>&1; then
    for u in cron crond; do
      if systemctl list-unit-files "$u.service" 2>/dev/null | grep -q "$u.service"; then systemctl enable --now "$u" >/dev/null 2>&1 && return 0; fi
    done
  fi
  echo "cron is not installed; installing it..."
  if command -v apt-get >/dev/null 2>&1; then DEBIAN_FRONTEND=noninteractive apt-get install -y cron >/dev/null
  elif command -v dnf >/dev/null 2>&1; then dnf install -y cronie >/dev/null
  elif command -v yum >/dev/null 2>&1; then yum install -y cronie >/dev/null
  else echo "Could not install cron on this system. Install it, then run: voxshift auto-update on" >&2; return 1; fi
  for u in cron crond; do systemctl enable --now "$u" >/dev/null 2>&1 && return 0; done
  echo "cron was installed but could not be started. Start it, then check: voxshift auto-update status" >&2; return 1
}

auto_update() {
  case "${1:-status}" in
    on)
      when="${2:-daily}"
      case "$when" in daily|weekly) ;; *) echo "Use: voxshift auto-update on [daily|weekly]" >&2; exit 1 ;; esac
      tag="$(sed -n 's/^IMAGE_TAG=//p' .env | tail -n 1)"
      [ -z "$tag" ] || [ "$tag" = latest ] || { echo "IMAGE_TAG is '$tag' (an exact release), so there is nothing new to fetch. Set IMAGE_TAG=latest in $DIR/.env first." >&2; exit 1; }
      ensure_cron
      # A quiet hour (02:00-04:59), minute picked at random once so a fleet of installs does not all pull at the same second.
      min=$(( RANDOM % 60 )); hr=$(( 2 + RANDOM % 3 )); dow='*'; [ "$when" = weekly ] && dow=0
      if [ -f "$CRON_FILE" ]; then
        old="$(awk '!/^#/ && NF>=6 {print $1" "$2" "$5; exit}' "$CRON_FILE")"
        [ -z "$old" ] || { min="${old%% *}"; rest="${old#* }"; hr="${rest%% *}"; }
      fi
      cat > "$CRON_FILE" <<CRON
# Written by 'voxshift auto-update'. Remove it with: voxshift auto-update off
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
$min $hr * * $dow root $DIR/voxshift update --auto >> $LOG_FILE 2>&1
CRON
      chmod 644 "$CRON_FILE"
      cat > /etc/logrotate.d/voxshift-update <<LR
$LOG_FILE {
    monthly
    rotate 6
    compress
    missingok
    notifempty
}
LR
      printf 'Automatic updates are on: %s at %02d:%02d (this host time). Log: %s\n' "$when" "$hr" "$min" "$LOG_FILE"
      echo "It backs up first and restarts only when a new version is out. Turn it off: voxshift auto-update off"
      ;;
    off)
      rm -f "$CRON_FILE" /etc/logrotate.d/voxshift-update
      echo "Automatic updates are off. Update by hand with: voxshift update"
      ;;
    status)
      if [ -f "$CRON_FILE" ]; then
        awk '!/^#/ && NF>=6 {printf "Automatic updates are ON: %s at %02d:%02d (this host time).\n", ($5 == "*" ? "daily" : "weekly"), $2, $1}' "$CRON_FILE"
        if [ -f "$LOG_FILE" ]; then echo "Last log lines ($LOG_FILE):"; tail -n 5 "$LOG_FILE"; else echo "It has not run yet."; fi
      else
        echo "Automatic updates are OFF. Turn them on with: voxshift auto-update on [daily|weekly]"
      fi
      ;;
    *) echo "Use: voxshift auto-update on [daily|weekly] | off | status" >&2; exit 1 ;;
  esac
}

# What the cron job runs: quiet when there is nothing new, a backup and a restart when there is, one line per step in the log.
auto_run() {
  if command -v flock >/dev/null 2>&1; then
    exec 9>/var/lock/voxshift-update.lock
    flock -n 9 || { echo "$(stamp) another update is already running; skipping"; return 0; }
  fi
  tag="$(sed -n 's/^IMAGE_TAG=//p' .env | tail -n 1)"
  if [ -n "$tag" ] && [ "$tag" != latest ]; then echo "$(stamp) IMAGE_TAG is '$tag' (pinned); skipping"; return 0; fi
  before="$(image_ids)"
  if ! dc pull -q >/dev/null 2>&1; then echo "$(stamp) could not pull the images (registry unreachable?); nothing changed"; return 1; fi
  if [ "$before" = "$(image_ids)" ]; then echo "$(stamp) already up to date"; return 0; fi
  echo "$(stamp) new version found; taking a backup"
  "$0" backup >/dev/null || { echo "$(stamp) backup failed; NOT updating"; return 1; }
  echo "$(stamp) restarting on the new version"
  dc up -d >/dev/null 2>&1
  if wait_ready >/dev/null 2>&1; then
    echo "$(stamp) updated and answering"; docker image prune -f >/dev/null 2>&1 || true
  else
    echo "$(stamp) updated but NOT answering; look at: voxshift logs api  (the backup from just before is in $DIR/backups)"; return 1
  fi
}

# ----- backup and restore helpers
sum256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
is_release() { [[ "$1" =~ ^[0-9]{4}\.[0-9]{1,2}\.[0-9]+$ ]]; }

# The release (yyyy.mm.N) that is running now: asked of the web container (/version.json), else the pinned IMAGE_TAG; "unknown" if neither says.
current_release() {
  local v
  v="$(dc exec -T web wget -q -O - http://127.0.0.1/version.json 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' | head -n 1 || true)"
  if ! is_release "$v"; then v="$(sed -n 's/^IMAGE_TAG=//p' .env | tail -n 1)"; fi
  if is_release "$v"; then echo "$v"; else echo unknown; fi
}

# ----- backup encryption (optional). The host keeps only PUBLIC keys, in RECIPIENTS; the private key stays with the owner, off this host.
RECIPIENTS="$DIR/backup-recipients"
enc_enabled() { [ -e "$RECIPIENTS" ]; }
recipient_lines() { grep -vE '^[[:space:]]*(#|$)' "$1" || true; }

# Installs 'age' (https://age-encryption.org) the way the other prerequisites are installed: from the system's own package repository.
ensure_age() {
  command -v age >/dev/null 2>&1 && return 0
  echo "age (the program that encrypts backups) is not installed; installing it..."
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y age >/dev/null 2>&1 \
      || { apt-get update -qq >/dev/null 2>&1 && DEBIAN_FRONTEND=noninteractive apt-get install -y age >/dev/null 2>&1; } || true
  else
    for pm in dnf yum; do
      command -v "$pm" >/dev/null 2>&1 || continue
      "$pm" install -y age >/dev/null 2>&1 || { "$pm" install -y epel-release >/dev/null 2>&1 && "$pm" install -y age >/dev/null 2>&1; } || true
      break
    done
  fi
  command -v age >/dev/null 2>&1 && return 0
  echo "Could not install 'age' automatically on this system. Install it yourself (Debian/Ubuntu: apt install age; RHEL family: dnf install epel-release age;" >&2
  echo "or download the single program for Linux from https://github.com/FiloSottile/age/releases), then run this command again. Backup encryption was NOT switched on." >&2
  return 1
}

# Why a backup cannot be made while encryption is on (and never falls back to an unencrypted one).
check_encryption_ready() {
  command -v age >/dev/null 2>&1 || {
    echo "Backup encryption is switched on, but 'age' is not installed, so NO backup was made (a backup is never saved unencrypted while encryption is on)." >&2
    echo "Install the tool with: voxshift backup-encryption on     or switch encryption off with: voxshift backup-encryption off" >&2
    return 1
  }
  [ -n "$(recipient_lines "$RECIPIENTS")" ] || {
    echo "Backup encryption is switched on, but $RECIPIENTS holds no public key, so NO backup was made. Give one: voxshift backup-encryption on <public-key>     or switch encryption off: voxshift backup-encryption off" >&2
    return 1
  }
}

# Backups on this host that are NOT encrypted: <timestamp> folders (and pre-restore- ones).
plain_backups() { ls -1 "${1:-$DIR/backups}" 2>/dev/null | grep -E '^(pre-restore-)?[0-9]{8}-[0-9]{6}$' || true; }

backup_encryption() {
  local sub="${1:-status}" arg new n plain
  case "$sub" in
    on)
      shift
      if [ $# -eq 0 ]; then
        enc_enabled || { echo "Use: voxshift backup-encryption on <public-key | file-with-public-keys> [more keys...]" >&2; exit 1; }
        ensure_age || exit 1
        echo "Backup encryption is on and age is installed."; return 0
      fi
      ensure_age || exit 1
      umask 077
      new="$RECIPIENTS.new"; : > "$new"; track_tmp "$new"
      for arg in "$@"; do
        if [ -f "$arg" ]; then
          if grep -q 'AGE-SECRET-KEY-' "$arg"; then
            echo "$arg holds a PRIVATE key. Never put the private key on this host. Nothing changed." >&2
            echo "On your own computer, get the matching public key with:  age-keygen -y $arg   and give that to this command." >&2
            exit 1
          fi
          recipient_lines "$arg" >> "$new"
        else
          case "$arg" in
            AGE-SECRET-KEY-*) echo "That is a PRIVATE key. Never put it on this host. Give the PUBLIC key instead (it starts with age1). Nothing changed." >&2; exit 1 ;;
            age1*|ssh-ed25519\ *|ssh-rsa\ *) printf '%s\n' "$arg" >> "$new" ;;
            *) echo "'$arg' is not a public key (it starts with age1...) and is not a file I can read. Nothing changed." >&2; exit 1 ;;
          esac
        fi
      done
      n="$(wc -l < "$new" | tr -d ' ')"
      [ "$n" -ge 1 ] || { echo "No public key found in what you gave. Nothing changed." >&2; exit 1; }
      # Let age itself judge the keys: encrypt a few bytes to them.
      if ! printf 'voxshift' | age -R "$new" > /dev/null 2> "$new.err"; then
        track_tmp "$new.err"
        echo "age does not accept that key:" >&2; sed 's/^/  /' "$new.err" >&2
        echo "Nothing changed." >&2; exit 1
      fi
      rm -f "$new.err"
      mv "$new" "$RECIPIENTS"; chmod 600 "$RECIPIENTS"; forget_tmp "$new"
      echo "Backup encryption is ON ($n public key(s) in $RECIPIENTS). From now on 'voxshift backup', the nightly update job and the safety backup before a restore"
      echo "write one encrypted file (.tar.age) instead of a folder. This host holds only the public key: it can make backups but cannot read them."
      echo "To restore you need the PRIVATE key, which must be kept OFF this host. If every private key is lost, the encrypted backups cannot be read by anyone."
      plain="$(plain_backups | wc -l | tr -d ' ')"
      if [ "$plain" -gt 0 ]; then
        echo "Note: $plain older backup(s) in $DIR/backups are NOT encrypted. They are removed as newer ones push them out, or remove them now: voxshift backup-encryption remove-unencrypted"
      fi
      ;;
    off)
      if enc_enabled; then rm -f "$RECIPIENTS"; echo "Backup encryption is OFF. New backups are plain folders again."; else echo "Backup encryption was already off."; fi
      echo "Backups already made as .tar.age files stay encrypted and still need their private key to be restored."
      ;;
    status)
      if enc_enabled; then
        echo "Backup encryption: ON ($(recipient_lines "$RECIPIENTS" | wc -l | tr -d ' ') public key(s) in $RECIPIENTS)"
        if command -v age >/dev/null 2>&1; then echo "age: installed ($(age --version 2>&1 | head -n 1))"; else echo "age: NOT installed - backups will fail until it is: voxshift backup-encryption on"; fi
        echo "The private key is not on this host, and is needed to restore. If it is lost, the encrypted backups cannot be read."
      else
        echo "Backup encryption: OFF. Backups are plain folders holding the database, the secrets in .env and the private keys of the certificates."
        echo "Switch it on: voxshift backup-encryption on <public-key>   (see docs/INSTALL-LINUX-REFERENCE.md, Backups)"
      fi
      echo "Backups in $DIR/backups: $(ls -1 "$DIR/backups" 2>/dev/null | grep -cE '^(pre-restore-)?[0-9]{8}-[0-9]{6}\.tar\.age$' || true) encrypted, $(plain_backups | wc -l | tr -d ' ') not encrypted"
      ;;
    remove-unencrypted)
      plain="$(plain_backups)"
      [ -n "$plain" ] || { echo "There are no unencrypted backups in $DIR/backups."; return 0; }
      echo "These backups are not encrypted and would be deleted:"; printf '%s\n' "$plain" | sed 's|^|  |'
      echo "Copy anything you still need first. Encrypted backups (.tar.age) are not touched."
      [ -t 0 ] || { echo "Not a terminal. Nothing deleted." >&2; exit 1; }
      read -r -p "Type DELETE to continue: " reply || true
      [ "${reply:-}" = "DELETE" ] || { echo "Not confirmed. Nothing deleted."; exit 1; }
      for n in $plain; do rm -rf -- "${DIR:?}/backups/$n"; done
      echo "Deleted."
      ;;
    *) echo "Use: voxshift backup-encryption on <public-key | file> [more keys...] | off | status | remove-unencrypted" >&2; exit 1 ;;
  esac
}

# Keep the last 14 backups made by 'voxshift backup' and the last 3 safety backups made by 'voxshift restore' (pre-restore-...) in PARENT, whether
# they are plain folders or encrypted files (with their .sha256). Only names of exactly that shape are touched, so anything else the person keeps
# in the same folder is left alone.
rotate_backups() {
  local parent="$1" n
  for n in $(ls -1 "$parent" 2>/dev/null | sed -nE 's/^([0-9]{8}-[0-9]{6})(\.tar\.age)?$/\1/p' | sort -ur | tail -n +15); do
    rm -rf -- "${parent:?}/$n" "${parent:?}/$n.tar.age" "${parent:?}/$n.tar.age.sha256"
  done
  for n in $(ls -1 "$parent" 2>/dev/null | sed -nE 's/^(pre-restore-[0-9]{8}-[0-9]{6})(\.tar\.age)?$/\1/p' | sort -ur | tail -n +4); do
    rm -rf -- "${parent:?}/$n" "${parent:?}/$n.tar.age" "${parent:?}/$n.tar.age.sha256"
  done
}

# do_backup PARENT [PREFIX]: writes PARENT/<PREFIX><timestamp> (a folder) or, when backup encryption is on, PARENT/<PREFIX><timestamp>.tar.age
# (one encrypted file, plus a .sha256 beside it), and sets BACKUP_DEST. It is built in a .partial name and renamed at the very end, so a backup
# that fails part-way leaves nothing that looks complete (and 'voxshift update' / the nightly job stop). The plain folder only exists while the
# backup is being made; with encryption on it is removed as soon as the encrypted file has been checked.
do_backup() {
  local parent="$1" prefix="${2:-}" part f out enc=0 size sum
  if enc_enabled; then enc=1; check_encryption_ready || return 1; fi
  umask 077
  mkdir -p "$parent"
  BACKUP_DEST="$parent/${prefix}$(date -u +%Y%m%d-%H%M%S)"
  while [ -e "$BACKUP_DEST" ] || [ -e "$BACKUP_DEST.tar.age" ]; do sleep 1; BACKUP_DEST="$parent/${prefix}$(date -u +%Y%m%d-%H%M%S)"; done
  part="$BACKUP_DEST.partial"
  rm -rf "$part"; mkdir -m 700 "$part"
  track_tmp "$part"
  dc exec -T postgres pg_dump -U tvmf -Fc tvmf > "$part/database.dump"
  [ -s "$part/database.dump" ] || { echo "The database dump is empty; stopping." >&2; return 1; }
  docker run --rm -v voxshift_filesdata:/data:ro -v "$part":/out alpine tar czf /out/files.tar.gz -C /data .
  cp .env "$part/env"
  cp compose.yaml "$part/compose.yaml"
  if [ -f Caddyfile ]; then cp Caddyfile "$part/Caddyfile"; fi
  if [ -d certs ]; then cp -a certs "$part/certs"; fi
  docker run --rm -v voxshift_caddydata:/data:ro -v "$part":/out alpine tar czf /out/caddy-data.tar.gz -C /data .
  if kuma_enabled; then
    # Device status: Kuma's settings file and its database. Kuma is stopped for the few seconds the copy takes, so the database is not caught mid-write.
    cp compose.override.yaml "$part/compose.override.yaml"
    f=0
    dc stop kuma >/dev/null 2>&1 || true
    docker run --rm -v voxshift_kumadata:/data:ro -v "$part":/out alpine tar czf /out/kuma-data.tar.gz -C /data . || f=$?
    dc start kuma >/dev/null 2>&1 || true
    [ "$f" = 0 ] || { echo "Kuma's data could not be saved; stopping." >&2; return 1; }
  fi
  # folders 700, files 600: the backup holds the secrets, the private keys and the data
  find "$part" -type d -exec chmod 700 {} +
  find "$part" -type f -exec chmod 600 {} +
  {
    echo "# Voxshift backup manifest. 'voxshift restore' checks every file against its sha256 before it changes anything."
    echo "format=1"
    echo "created=$(stamp)"
    echo "release=$(current_release)"
    echo "image_tag=$(sed -n 's/^IMAGE_TAG=//p' .env | tail -n 1)"
    echo "files:"
    ( cd "$part" && find . -type f ! -name manifest.txt | sed 's|^\./||' | sort | while IFS= read -r f; do sum256 "$f"; done )
  } > "$part/manifest.txt"
  chmod 600 "$part/manifest.txt"
  if [ "$enc" = 1 ]; then
    out="$BACKUP_DEST.tar.age"
    track_tmp "$out.partial"
    tar -C "$part" -cf - . | age -R "$RECIPIENTS" > "$out.partial"
    # Without the private key the content cannot be read back here, so check what can be checked: it exists, is not empty, starts with the
    # age header, and is bigger than nothing-but-a-header. Its size and sha256 are written next to it, for checking a copy later.
    [ -s "$out.partial" ] || { echo "The encrypted backup came out empty; stopping." >&2; return 1; }
    [ "$(head -c 21 "$out.partial")" = "age-encryption.org/v1" ] || { echo "The encrypted backup does not start with the age header; stopping." >&2; return 1; }
    size="$(wc -c < "$out.partial" | tr -d ' ')"
    [ "$size" -gt 200 ] || { echo "The encrypted backup is only $size bytes; stopping." >&2; return 1; }
    sum="$(sum256 "$out.partial" | cut -d' ' -f1)"
    printf '%s  %s\n' "$sum" "${out##*/}" > "$out.sha256"
    mv "$out.partial" "$out"
    forget_tmp "$out.partial"
    rm -rf "$part"; forget_tmp "$part"
    [ ! -e "$part" ] || { echo "Could not remove the unencrypted working folder $part - delete it yourself." >&2; return 1; }
    BACKUP_DEST="$out"; BACKUP_NOTE="encrypted, $size bytes, sha256 $sum"
  else
    mv "$part" "$BACKUP_DEST"
    forget_tmp "$part"
    BACKUP_NOTE=""
  fi
  rotate_backups "$parent"
}

# ----- self-update: fetch the installer from the latest RELEASE, check it, and let it rewrite this command (nothing else)
REPO="gauntlec/teams-voice-migration-factory"
RELEASE_URL="https://github.com/$REPO/releases/latest/download"
OLD_URL="https://raw.githubusercontent.com/$REPO/main/deploy/install/install.sh"
# Who signs the release checksums: the release job of this repository's build workflow, on main (GitHub's identity for that workflow).
SIGNER_IDENTITY="https://github.com/$REPO/.github/workflows/build-images.yml@refs/heads/main"
SIGNER_ISSUER="https://token.actions.githubusercontent.com"

# fetch URL FILE: prints the HTTP status (000 when the host could not be reached at all).
fetch() { curl -sSL --max-time 120 -o "$2" -w '%{http_code}' "$1" 2>/dev/null || true; }

self_update() {
  local d code want got rc=0
  d="$(mktemp -d)"; track_tmp "$d"
  code="$(fetch "$RELEASE_URL/SHA256SUMS" "$d/SHA256SUMS")"
  case "$code" in
    200)
      [ "$(fetch "$RELEASE_URL/install.sh" "$d/install.sh")" = 200 ] || { echo "Could not download install.sh from the latest release ($RELEASE_URL). Nothing changed." >&2; exit 1; }
      want="$(awk '$2 == "install.sh" {print $1; exit}' "$d/SHA256SUMS")"
      [[ "$want" =~ ^[0-9a-f]{64}$ ]] || { echo "The release's SHA256SUMS does not list install.sh. Nothing changed." >&2; exit 1; }
      got="$(sum256 "$d/install.sh" | cut -d' ' -f1)"
      if [ "$got" != "$want" ]; then
        echo "The downloaded installer does NOT match the checksum published with the release, so it was not used." >&2
        echo "  published: $want" >&2; echo "  received:  $got" >&2
        echo "Try again in a few minutes; if it keeps happening, do not continue and tell Voxshift. Nothing changed." >&2
        exit 1
      fi
      echo "Checked: install.sh matches the checksum published with the latest release."
      if command -v cosign >/dev/null 2>&1; then
        [ "$(fetch "$RELEASE_URL/SHA256SUMS.sigstore.json" "$d/SHA256SUMS.sigstore.json")" = 200 ] || {
          echo "cosign is installed here, so the signature on the checksums is required, but this release has no SHA256SUMS.sigstore.json. Nothing changed." >&2
          echo "(Try again later; to rely on the checksum alone, remove cosign from this host.)" >&2; exit 1; }
        if ! cosign verify-blob --bundle "$d/SHA256SUMS.sigstore.json" --certificate-identity "$SIGNER_IDENTITY" --certificate-oidc-issuer "$SIGNER_ISSUER" "$d/SHA256SUMS" >"$d/cosign.log" 2>&1; then
          echo "The signature on the release checksums did NOT verify, so the installer was not used. Nothing changed." >&2
          sed 's/^/  /' "$d/cosign.log" >&2; exit 1
        fi
        echo "Checked: the checksums are signed by this repository's release workflow (cosign)."
      else
        echo "Note: cosign is not installed, so the signature on the checksums was not checked (only the checksum itself). Install cosign for that."
      fi
      ;;
    404)
      # The latest release has no SHA256SUMS (a release from before this existed, or none yet): the one case where the old source is used.
      echo "Warning: the latest release has no SHA256SUMS yet, so the installer cannot be checked. Using the old, unchecked source ($OLD_URL)." >&2
      echo "         This stops once a newer release is out." >&2
      [ "$(fetch "$OLD_URL" "$d/install.sh")" = 200 ] || { echo "Could not download the installer from GitHub (this host needs outbound HTTPS to github.com and raw.githubusercontent.com). Nothing changed." >&2; exit 1; }
      ;;
    *)
      echo "Could not reach GitHub to check for the installer (answer: $code). This host needs outbound HTTPS to github.com. Nothing changed." >&2; exit 1 ;;
  esac
  bash -n "$d/install.sh" || { echo "The downloaded installer is damaged. Nothing changed." >&2; exit 1; }
  bash "$d/install.sh" --refresh-command --dir "$DIR" "$@" || rc=$?
  exit "$rc"
}

# The value of KEY= in a backup's manifest.
manifest_value() { sed -n "s/^$1=//p" "$2/manifest.txt" | head -n 1; }

restore_cmd() {
  local src="" yes=0 force=0 withcfg=0 identity="" shown tmp="" n f back
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --yes|-y) yes=1 ;;
      --force) force=1 ;;
      --with-config) withcfg=1 ;;
      --identity) shift; identity="${1:-}"; [ -n "$identity" ] || { echo "--identity needs the file holding your private key." >&2; exit 1; } ;;
      -*) echo "Unknown option $1. Use: voxshift restore <backup> [--identity <private-key-file>] [--with-config] [--yes] [--force]" >&2; exit 1 ;;
      *) [ -z "$src" ] || { echo "Give one backup only." >&2; exit 1; }; src="${1%/}" ;;
    esac
    shift
  done
  if [ -z "$src" ]; then
    echo "Use: voxshift restore <backup> [--identity <private-key-file>] [--with-config] [--yes] [--force]"
    echo "  <backup> is a folder, or an encrypted file ending .tar.age (that one needs --identity)."
    echo "Backups on this host ($DIR/backups):"
    ls -1 "$DIR/backups" 2>/dev/null | grep -E '^(pre-restore-)?[0-9]{8}-[0-9]{6}(\.tar\.age)?$' | sort -r | sed 's|^|  |' || true
    exit 1
  fi
  shown="$src"

  # 0. An encrypted backup is opened first (into a private folder that is removed however this command ends), then handled like a plain one.
  case "$src" in
    *.tar.age)
      [ -f "$src" ] || { echo "$src is not a file. Nothing changed." >&2; exit 1; }
      if [ -z "$identity" ]; then
        echo "$src is an ENCRYPTED backup. To restore it, give the private key that goes with the public key this host encrypts to:" >&2
        echo "  voxshift restore $src --identity /path/to/private-key.txt" >&2
        echo "The private key was made when encryption was switched on and is kept off this host. If it is lost, this backup cannot be read. Nothing changed." >&2
        exit 1
      fi
      [ -f "$identity" ] && [ -r "$identity" ] || { echo "Cannot read the private key file '$identity'. Nothing changed." >&2; exit 1; }
      command -v age >/dev/null 2>&1 || { ensure_age || exit 1; }
      src="$(cd "$(dirname "$src")" && pwd)/$(basename "$src")"
      if [ -f "$src.sha256" ] && ! ( cd "$(dirname "$src")" && sum256 -c --quiet "$(basename "$src").sha256" ) >/dev/null 2>&1; then
        echo "This backup file is damaged: it does not match the checksum saved beside it ($src.sha256). Nothing changed." >&2; exit 1
      fi
      mkdir -p "$DIR/backups"
      # Left over from an earlier restore that was killed hard: remove, so decrypted data is never left lying about.
      for n in "$DIR"/backups/.restore-*; do [ ! -d "$n" ] || rm -rf -- "$n"; done
      tmp="$(mktemp -d "$DIR/backups/.restore-XXXXXX")"   # next to the backups: same disk, root only
      chmod 700 "$tmp"; track_tmp "$tmp"
      echo "Opening the encrypted backup..."
      if ! age -d -i "$identity" "$src" | tar --no-same-owner -x -C "$tmp"; then
        echo "The backup could not be opened. Either this is not the private key that goes with it, or the file is damaged. Nothing changed." >&2
        exit 1
      fi
      if [ -n "$(find "$tmp" -type l | head -n 1)" ]; then echo "The backup contains a link, which a Voxshift backup never does. Nothing changed." >&2; exit 1; fi
      src="$tmp"
      ;;
    *)
      [ -d "$src" ] || { echo "$src is not a folder. Nothing changed." >&2; exit 1; }
      [ -z "$identity" ] || echo "Note: --identity is only needed for an encrypted (.tar.age) backup; ignored."
      src="$(cd "$src" && pwd)"
      ;;
  esac
  for f in database.dump files.tar.gz env; do [ -f "$src/$f" ] || { echo "$shown has no $f - it is not a Voxshift backup (or it is incomplete). Nothing changed." >&2; exit 1; }; done

  # 1. Is the backup whole, and is it for this release?
  local created="unknown" brel="unknown" now
  if [ -f "$src/manifest.txt" ]; then
    created="$(manifest_value created "$src")"; brel="$(manifest_value release "$src")"
    if ! grep -E '^[0-9a-f]{64}  ' "$src/manifest.txt" | ( cd "$src" && sum256 -c --quiet - ) >/dev/null 2>&1; then
      echo "This backup is damaged or has been changed: a file does not match its checksum in manifest.txt. Nothing changed." >&2
      grep -E '^[0-9a-f]{64}  ' "$src/manifest.txt" | ( cd "$src" && sum256 -c - 2>&1 | grep -v ': OK$' ) >&2 || true
      exit 1
    fi
    echo "Checked: every file in the backup matches its checksum."
  else
    [ "$force" = 1 ] || { echo "This backup has no manifest.txt (it was made by an older Voxshift), so it cannot be checked. If you trust it, run again with --force. Nothing changed." >&2; exit 1; }
    echo "Warning: no manifest.txt - the backup cannot be checked."
  fi
  if [ "$withcfg" = 1 ]; then
    for f in compose.yaml caddy-data.tar.gz; do [ -f "$src/$f" ] || { echo "--with-config needs $f in the backup, and this one has none (older backups did not save it). Nothing changed." >&2; exit 1; }; done
  fi
  now="$(current_release)"
  if is_release "$brel" && is_release "$now"; then
    if [ "$brel" != "$now" ] && [ "$(printf '%s\n%s\n' "$brel" "$now" | sort -V | tail -n 1)" = "$brel" ]; then
      if [ "$force" != 1 ]; then
        echo "This backup was made on release $brel, which is NEWER than the release running here ($now). Database changes only move forward, so the older program cannot use it." >&2
        echo "Update first (voxshift update), or set IMAGE_TAG in $DIR/.env to $brel or later and run voxshift restart, then restore again. To go ahead regardless: --force. Nothing changed." >&2
        exit 1
      fi
      echo "Warning: the backup ($brel) is newer than what is running ($now); going ahead because of --force."
    fi
  else
    if [ "$force" != 1 ]; then
      echo "Cannot tell whether the backup (release: $brel) fits what is running here (release: $now). Make sure Voxshift is running (voxshift start) so its release can be read; to go ahead without the check: --force. Nothing changed." >&2
      exit 1
    fi
    echo "Warning: the release could not be compared (backup: $brel, running: $now); going ahead because of --force."
  fi

  # 2. Say what will happen, and ask.
  echo
  echo "RESTORE will replace what is on this host with the backup:"
  echo "  backup:        $shown$([ -z "$tmp" ] || echo "  (encrypted; opened for this restore only)")"
  echo "  made:          $created   release: $brel   (running now: $now)"
  echo "  replaced:      the database (all of it), the stored files, and the settings in .env"
  echo "                 (.env keeps this host's database password and IMAGE_TAG; a copy of today's .env is kept)"
  if [ "$withcfg" = 1 ]; then echo "  also replaced: compose.yaml, Caddyfile, certificates and Caddy's data volume (--with-config)"; else echo "  not replaced:  compose.yaml, Caddyfile, certificates, Caddy's data (add --with-config to restore these too)"; fi
  if [ -f "$src/kuma-data.tar.gz" ]; then echo "  also replaced: Kuma's data (device status monitors and history) and its settings file compose.override.yaml"; fi
  echo "  first:         a safety backup of the current state, in $DIR/backups/pre-restore-<time>"
  echo "  Voxshift is stopped while this runs (a few minutes). Anything entered since the backup was made is lost."
  if [ "$yes" != 1 ]; then
    [ -t 0 ] || { echo "Not a terminal. Pass --yes to confirm. Nothing changed." >&2; exit 1; }
    read -r -p "Type RESTORE to continue: " reply || true
    [ "${reply:-}" = "RESTORE" ] || { echo "Not confirmed. Nothing changed."; exit 1; }
  fi

  # 3. Safety backup, then the restore itself.
  echo "Taking a safety backup of the current state first..."
  do_backup "$DIR/backups" pre-restore-
  safety="$BACKUP_DEST"
  echo "Safety backup: $safety"
  back="voxshift restore $safety"; [ ! -f "$safety" ] || back="$back --identity <your-private-key-file>"
  trap 'echo "The restore stopped part-way. Your data from just before it started is in $safety. To go back to it: $back" >&2' ERR

  ts="$(date -u +%Y%m%d-%H%M%S)"
  dc stop api worker
  [ "$withcfg" != 1 ] || dc stop caddy

  cp .env ".env.before-restore-$ts"; chmod 600 ".env.before-restore-$ts"
  cp "$src/env" .env.restoring; chmod 600 .env.restoring
  for k in POSTGRES_PASSWORD DATABASE_URL IMAGE_TAG; do
    line="$(grep -E "^$k=" ".env.before-restore-$ts" | tail -n 1 || true)"
    [ -n "$line" ] || continue
    { grep -vE "^$k=" .env.restoring || true; } > .env.restoring.new
    printf '%s\n' "$line" >> .env.restoring.new
    mv .env.restoring.new .env.restoring
  done
  mv .env.restoring .env; chmod 600 .env
  echo "Restored .env (the previous one is .env.before-restore-$ts)."

  dc up -d postgres redis
  for _ in $(seq 1 30); do dc exec -T postgres pg_isready -U tvmf -d tvmf >/dev/null 2>&1 && break; sleep 2; done
  echo "Restoring the database..."
  rc=0; dc exec -T postgres pg_restore -U tvmf -d tvmf --clean --if-exists < "$src/database.dump" || rc=$?
  if [ "$rc" != 0 ]; then
    # pg_restore exits 1 for harmless messages too; it only counts as a failure if the data is not there.
    echo "pg_restore reported problems (exit $rc; shown above). Checking the data arrived..." >&2
    dc exec -T postgres psql -U tvmf -d tvmf -tAc "select count(*) from platform.users" >/dev/null || { echo "The database did not restore." >&2; false; }
    echo "The data is there; the messages above were warnings."
  fi

  echo "Restoring the stored files..."
  docker run --rm -v voxshift_filesdata:/data -v "$src":/in:ro alpine sh -ec 'find /data -mindepth 1 -maxdepth 1 -exec rm -rf {} +; tar xzf /in/files.tar.gz -C /data'

  if [ "$withcfg" = 1 ]; then
    echo "Restoring the web server settings..."
    cp compose.yaml "compose.yaml.before-restore-$ts"
    cp "$src/compose.yaml" compose.yaml
    if [ -f "$src/Caddyfile" ]; then [ ! -f Caddyfile ] || cp Caddyfile "Caddyfile.before-restore-$ts"; cp "$src/Caddyfile" Caddyfile; fi
    if [ -d "$src/certs" ]; then
      if [ -d certs ]; then mv certs "certs.before-restore-$ts"; fi
      cp -a "$src/certs" certs
    fi
    docker run --rm -v voxshift_caddydata:/data -v "$src":/in:ro alpine sh -ec 'find /data -mindepth 1 -maxdepth 1 -exec rm -rf {} +; tar xzf /in/caddy-data.tar.gz -C /data'
  fi

  if [ -f "$src/kuma-data.tar.gz" ]; then
    echo "Restoring Kuma's data..."
    if [ -f "$src/compose.override.yaml" ]; then
      [ ! -f compose.override.yaml ] || cp compose.override.yaml "compose.override.yaml.before-restore-$ts"
      cp "$src/compose.override.yaml" compose.override.yaml
      kuma_web_sync || true   # the Caddyfile must agree with the restored file (a restore without --with-config leaves the Caddyfile as it is)
    fi
    if kuma_enabled; then
      dc stop kuma >/dev/null 2>&1 || true
      dc create kuma >/dev/null 2>&1 || true
      docker run --rm -v voxshift_kumadata:/data -v "$src":/in:ro alpine sh -ec 'find /data -mindepth 1 -maxdepth 1 -exec rm -rf {} +; tar xzf /in/kuma-data.tar.gz -C /data'
    else
      echo "Kuma's data is in the backup, but this host has no compose.override.yaml and the backup has none to restore, so Kuma was not restored." >&2
    fi
  fi

  echo "Starting everything..."
  dc up -d --force-recreate
  wait_ready
  trap - ERR
  echo "Restored from $shown."
  echo "Sign in and check. If it is not what you wanted, go back with: $back"
  [ -z "$tmp" ] || echo "The opened (decrypted) copy of the backup has been removed. If you copied your private key onto this host for the restore, delete that copy now."
}

# ---------------------------------------------------------------- certificates: voxshift certificate status | selfsigned | install | export
# The web address Caddy serves: the first site line of the Caddyfile (not the global { } block, not :80).
cert_host() { awk '/^[A-Za-z0-9.:_-]+ \{[[:space:]]*$/ && $1 != ":80" {print $1; exit}' "$DIR/Caddyfile"; }
# none | internal | custom (a certificate in /certs: your own, or self-signed) | acme
cert_mode() {
  if grep -q '^[[:space:]]*auto_https off' "$DIR/Caddyfile"; then echo none
  elif grep -q '^[[:space:]]*tls internal' "$DIR/Caddyfile"; then echo internal
  elif grep -q '^[[:space:]]*tls /certs/' "$DIR/Caddyfile"; then echo custom
  else echo acme; fi
}
need_openssl() {
  command -v openssl >/dev/null 2>&1 && return 0
  echo "openssl is not installed on this host. Install it (apt install openssl, or dnf install openssl) and run this again." >&2; return 1
}
# cert_make_selfsigned NAME DAYS OUTDIR: writes OUTDIR/server.crt and OUTDIR/server.key (a self-signed certificate for that name or IP address).
cert_make_selfsigned() {
  local name="$1" days="$2" out="$3" san cnf
  need_openssl || return 1
  name="${name#\[}"; name="${name%\]}"
  case "$name" in ''|*[!A-Za-z0-9.:_-]*) echo "'$name' is not a usable name or address." >&2; return 1 ;; esac
  [ "${#name}" -le 64 ] || { echo "'$name' is longer than 64 characters, which a certificate name cannot be." >&2; return 1; }
  case "$name" in *:*) san="IP:$name" ;; *[!0-9.]*) san="DNS:$name" ;; *) san="IP:$name" ;; esac
  cnf="$out/server.cnf"
  printf '[req]\ndistinguished_name = dn\nx509_extensions = v3\nprompt = no\n[dn]\nCN = %s\n[v3]\nsubjectAltName = %s\nbasicConstraints = critical,CA:FALSE\nkeyUsage = critical,digitalSignature,keyEncipherment\nextendedKeyUsage = serverAuth\nsubjectKeyIdentifier = hash\n' "$name" "$san" > "$cnf"
  if ! ( umask 077; openssl req -x509 -newkey rsa:2048 -nodes -days "$days" -keyout "$out/server.key" -out "$out/server.crt" -config "$cnf" >/dev/null 2>&1 ); then
    rm -f "$cnf"; echo "openssl could not create the certificate." >&2; return 1
  fi
  rm -f "$cnf"
}
# The names a certificate is valid for, one per line (lower case).
cert_names() { openssl x509 -in "$1" -noout -text 2>/dev/null | awk '/Subject Alternative Name/ {getline; print}' | tr ',' '\n' | sed -nE 's/^[[:space:]]*(DNS|IP Address):[[:space:]]*//p' | tr 'A-Z' 'a-z'; }
cert_covers() { # cert host
  local h n; h="$(printf '%s' "${2#\[}" | tr 'A-Z' 'a-z')"; h="${h%\]}"
  while IFS= read -r n; do
    [ -n "$n" ] || continue
    [ "$n" = "$h" ] && return 0
    case "$n" in '*.'*) case "$h" in *."${n#\*.}") [ "${h%."${n#\*.}"}" = "${h%%.*}" ] && return 0 ;; esac ;; esac
  done < <(cert_names "$1")
  return 1
}
# cert_check CERT KEY HOST FORCE: refuses (returns 1, with a plain reason) a certificate that cannot work.
cert_check() {
  local crt="$1" key="$2" host="$3" force="$4" a b
  need_openssl || return 1
  openssl x509 -in "$crt" -noout >/dev/null 2>&1 || { echo "$crt is not a readable certificate. It should be a text (PEM) file that starts with -----BEGIN CERTIFICATE-----." >&2; return 1; }
  openssl pkey -in "$key" -noout -passin pass: </dev/null >/dev/null 2>&1 || { echo "$key is not a readable private key. It should be a text (PEM) file without a password." >&2; return 1; }
  a="$(openssl x509 -in "$crt" -noout -pubkey | openssl sha256)"; b="$(openssl pkey -in "$key" -passin pass: -pubout | openssl sha256)"
  [ "$a" = "$b" ] || { echo "The key does not belong to this certificate (it was made from a different request). Nothing was changed." >&2; return 1; }
  openssl x509 -in "$crt" -noout -checkend 0 >/dev/null 2>&1 || { echo "This certificate has already expired. Nothing was changed." >&2; return 1; }
  if ! cert_covers "$crt" "$host"; then
    echo "This certificate is not valid for $host. It is valid for: $(cert_names "$crt" | tr '\n' ' ')" >&2
    [ "$force" = 1 ] || { echo "Nothing was changed. Get a certificate for $host (browsers refuse any other name), or add --force if you know better." >&2; return 1; }
    echo "Continuing because of --force." >&2
  fi
  if [ "$(grep -c 'BEGIN CERTIFICATE' "$crt")" -lt 2 ] && [ "$(openssl x509 -in "$crt" -noout -subject)" != "$(openssl x509 -in "$crt" -noout -issuer | sed 's/^issuer=/subject=/')" ]; then
    echo "  note: the file holds only your own certificate, not the authority's chain after it. Some computers may then say the certificate is not trusted. Put the chain after it (see the install guide) if they do."
  fi
}
# cert_apply CERT KEY HOST: puts the files in /opt/voxshift/certs, points the Caddyfile at them, makes sure Caddy can see the folder, restarts Caddy,
# and puts everything back if Caddy does not stay up.
cert_apply() {
  local crt="$1" key="$2" host="$3" tmpf
  rm -rf Caddyfile.before-cert compose.yaml.before-cert certs.before-cert
  cp -p Caddyfile Caddyfile.before-cert; cp -p compose.yaml compose.yaml.before-cert
  if [ -d certs ]; then cp -a certs certs.before-cert; fi
  mkdir -p certs; chmod 700 certs
  [ "$crt" -ef certs/server.crt ] || cp "$crt" certs/server.crt
  [ "$key" -ef certs/server.key ] || cp "$key" certs/server.key
  chmod 644 certs/server.crt; chmod 600 certs/server.key
  tmpf="$(mktemp "$DIR/.Caddyfile.XXXXXX")"
  awk -v host="$host" '
    inblk == 0 && ($1 == host || substr($1, 1, length(host) + 1) == host ":") && $2 == "{" { print; print "\ttls /certs/server.crt /certs/server.key"; inblk = 1; next }
    inblk == 1 && /^[ \t]*tls[ \t]/ { next }
    inblk == 1 && /^}/ { inblk = 0 }
    { print }' Caddyfile > "$tmpf"
  grep -q '^[[:space:]]*tls /certs/server.crt /certs/server.key' "$tmpf" || { rm -f "$tmpf"; echo "Could not find the site block for $host in the Caddyfile, so nothing was changed." >&2; return 1; }
  cat "$tmpf" > Caddyfile; rm -f "$tmpf"
  if ! grep -q './certs:/certs' compose.yaml; then
    tmpf="$(mktemp "$DIR/.compose.XXXXXX")"
    awk '{ print } /^[ \t]*- caddyconfig:\/config[ \t]*$/ && !d { print "      - ./certs:/certs:ro"; d = 1 }' compose.yaml > "$tmpf"
    grep -q './certs:/certs' "$tmpf" || { rm -f "$tmpf"; cert_rollback; echo "Could not add the certificate folder to compose.yaml, so nothing was changed." >&2; return 1; }
    cat "$tmpf" > compose.yaml; rm -f "$tmpf"
  fi
  echo "Restarting the web front door (a few seconds)..."
  dc up -d caddy >/dev/null 2>&1 || true
  sleep "${CERT_WAIT:-8}"
  if ! dc ps --services --filter status=running 2>/dev/null | grep -qx caddy; then
    echo "The front door did not start with the new certificate. Putting the old settings back." >&2
    dc logs --tail 15 caddy >&2 2>/dev/null || true
    cert_rollback; dc up -d caddy >/dev/null 2>&1 || true
    return 1
  fi
}
cert_rollback() {
  [ -f Caddyfile.before-cert ] && cp -p Caddyfile.before-cert Caddyfile
  [ -f compose.yaml.before-cert ] && cp -p compose.yaml.before-cert compose.yaml
  if [ -d certs.before-cert ]; then rm -rf certs; cp -a certs.before-cert certs; else rm -rf certs; fi
}
cert_summary() {
  local f="$1"
  openssl x509 -in "$f" -noout -subject -issuer -enddate 2>/dev/null | sed 's/^/    /'
  cert_names "$f" | sed 's/^/    valid for: /'
}
cert_cmd() {
  local sub="${1:-help}" host mode name days crt key force tmp dest owner
  shift || true
  host="$(cert_host)"; mode="$(cert_mode)"
  case "$sub" in
    status)
      [ -n "$host" ] || { echo "Could not read the web address from the Caddyfile." >&2; exit 1; }
      echo "Address:  $host"
      case "$mode" in
        none) echo "Secured:  no. This installation serves plain http (installed with --tls none)." ;;
        acme) echo "Secured:  by a free public certificate (Let's Encrypt) that renews itself." ;;
        internal) echo "Secured:  by Voxshift's own certificate authority. Browsers must trust its root certificate once (voxshift certificate export)." ;;
        custom) echo "Secured:  by the certificate in $DIR/certs/server.crt" ;;
      esac
      if [ "$mode" = custom ] && [ -f certs/server.crt ]; then
        need_openssl || exit 1
        cert_summary certs/server.crt
        if [ "$(openssl x509 -in certs/server.crt -noout -subject)" = "$(openssl x509 -in certs/server.crt -noout -issuer | sed 's/^issuer=/subject=/')" ]; then echo "    type: self-signed (each computer must be told to trust it: voxshift certificate export)"; fi
        if ! openssl x509 -in certs/server.crt -noout -checkend 0 >/dev/null 2>&1; then echo "    STATUS: EXPIRED. People cannot open Voxshift until it is replaced." 
        elif ! openssl x509 -in certs/server.crt -noout -checkend 2592000 >/dev/null 2>&1; then echo "    STATUS: expires within 30 days. Replace it soon: voxshift certificate help"
        else echo "    status: valid for more than 30 days"; fi
      elif [ "$mode" != none ] && command -v openssl >/dev/null 2>&1; then
        echo "    (what the server is presenting now:)"
        # shellcheck disable=SC2015
        echo | openssl s_client -connect 127.0.0.1:443 -servername "$host" 2>/dev/null | openssl x509 -noout -subject -issuer -enddate 2>/dev/null | sed 's/^/    /' || true
      fi
      ;;
    selfsigned)
      name=""; days=365
      while [ $# -gt 0 ]; do
        case "$1" in
          --name) name="${2:-}"; shift 2 ;;
          --days) days="${2:-}"; shift 2 ;;
          *) echo "Use: voxshift certificate selfsigned [--name NAME-OR-IP] [--days N]" >&2; exit 1 ;;
        esac
      done
      case "$days" in ''|*[!0-9]*) echo "--days must be a whole number." >&2; exit 1 ;; esac
      [ "$days" -ge 30 ] && [ "$days" -le 825 ] || { echo "--days must be between 30 and 825." >&2; exit 1; }
      [ "$mode" != none ] || { echo "This installation serves plain http, so there is no certificate to change. Install again with an https:// address." >&2; exit 1; }
      [ -n "$host" ] || { echo "Could not read the web address from the Caddyfile." >&2; exit 1; }
      [ -n "$name" ] || name="$host"
      if [ "$name" != "$host" ]; then echo "Note: the certificate will be for $name, but this installation is served at $host. Browsers only accept it at $name."; fi
      tmp="$(mktemp -d "$DIR/.selfsigned.XXXXXX")"; chmod 700 "$tmp"
      cert_make_selfsigned "$name" "$days" "$tmp" || { rm -rf "$tmp"; exit 1; }
      if ! cert_check "$tmp/server.crt" "$tmp/server.key" "$name" 1; then rm -rf "$tmp"; exit 1; fi
      if ! cert_apply "$tmp/server.crt" "$tmp/server.key" "$host"; then rm -rf "$tmp"; exit 1; fi
      rm -rf "$tmp"
      echo "A self-signed certificate is installed (valid $days days):"
      cert_summary certs/server.crt
      echo "Browsers will warn until each computer trusts it. Copy it with: sudo voxshift certificate export   (then follow the install guide, Trusting a self-signed certificate)."
      ;;
    install)
      crt=""; key=""; force=0
      while [ $# -gt 0 ]; do
        case "$1" in
          --cert) crt="${2:-}"; shift 2 ;;
          --key) key="${2:-}"; shift 2 ;;
          --force) force=1; shift ;;
          *) echo "Use: voxshift certificate install --cert FULLCHAIN.PEM --key SERVER.KEY [--force]" >&2; exit 1 ;;
        esac
      done
      [ -n "$crt" ] && [ -n "$key" ] || { echo "Use: voxshift certificate install --cert FULLCHAIN.PEM --key SERVER.KEY" >&2; exit 1; }
      [ -r "$crt" ] || { echo "Cannot read $crt" >&2; exit 1; }
      [ -r "$key" ] || { echo "Cannot read $key" >&2; exit 1; }
      [ "$mode" != none ] || { echo "This installation serves plain http, so there is no certificate to change. Install again with an https:// address." >&2; exit 1; }
      [ -n "$host" ] || { echo "Could not read the web address from the Caddyfile." >&2; exit 1; }
      cert_check "$crt" "$key" "$host" "$force" || exit 1
      cert_apply "$crt" "$key" "$host" || exit 1
      echo "Your certificate is installed:"
      cert_summary certs/server.crt
      echo "Open $host in a browser and check the padlock."
      ;;
    export)
      [ "$mode" != none ] || { echo "This installation serves plain http: there is no certificate." >&2; exit 1; }
      dest="${1:-${ORIG_PWD:-$DIR}/voxshift-certificate.crt}"
      case "$mode" in
        acme) echo "This installation uses a free public certificate. Every computer already trusts it: there is nothing to install." ; exit 0 ;;
        internal) dc cp caddy:/data/caddy/pki/authorities/local/root.crt "$dest" >/dev/null 2>&1 || { echo "Could not read Voxshift's root certificate. Is the front door running? voxshift status" >&2; exit 1; } ;;
        custom) cp certs/server.crt "$dest" ;;
      esac
      chmod 644 "$dest"
      owner="${SUDO_USER:-}"; [ -z "$owner" ] || chown "$owner" "$dest" 2>/dev/null || true
      echo "The public certificate is saved as $dest (it holds no secrets)."
      echo "Copy it to each computer that should trust Voxshift and install it as a trusted certificate (see the install guide)."
      ;;
    *)
      cat <<EOF
voxshift certificate <command>
  status                          which certificate is in use and when it runs out
  selfsigned [--name N] [--days D]  make a self-signed certificate on this server and use it (default 365 days; browsers must be told to trust it)
  install --cert FILE --key FILE [--force]
                                  use your own certificate (full chain, PEM) and its private key; checks them first and puts the old
                                  settings back if the front door does not start
  export [FILE]                   save the public certificate to FILE (default ./voxshift-certificate.crt) so you can trust it on computers
EOF
      ;;
  esac
}

case "${1:-help}" in
  status)  dc ps ;;
  start)   need_root "$@"; dc up -d; wait_ready ;;
  stop)    need_root "$@"; dc stop ;;
  restart) need_root "$@"; dc up -d --force-recreate; wait_ready ;;
  logs)    shift; dc logs --tail 200 -f "$@" ;;
  kuma)    shift; kuma_cmd "$@" ;;
  reset-admin)
    # Recovery: new password for the first Super Admin (from BOOTSTRAP_ADMIN_EMAIL), role/status/lockout put right.
    read -r -s -p "New password for the first admin (12 or more characters): " pw; echo
    read -r -s -p "Again: " pw2; echo
    [ "$pw" = "$pw2" ] || { echo "The two passwords differ. Nothing changed." >&2; exit 1; }
    [ "${#pw}" -ge 12 ] || { echo "Use at least 12 characters. Nothing changed." >&2; exit 1; }
    BOOTSTRAP_ADMIN_RESET=true BOOTSTRAP_ADMIN_PASSWORD="$pw" dc exec -T -e BOOTSTRAP_ADMIN_RESET -e BOOTSTRAP_ADMIN_PASSWORD api node packages/db/dist/seed.js
    ;;
  auto-update) need_root "$@"; shift; auto_update "$@" ;;
  self-update) need_root "$@"; shift; self_update "$@" ;;
  update)
    need_root "$@"
    if [ "${2:-}" = "--auto" ]; then auto_run; exit $?; fi
    echo "Taking a backup first..."; "$0" backup
    dc pull
    dc up -d
    wait_ready
    docker image prune -f >/dev/null 2>&1 || true
    ;;
  backup)
    need_root "$@"
    do_backup "${2:-$DIR/backups}"
    echo "Backup written to $BACKUP_DEST${BACKUP_NOTE:+  ($BACKUP_NOTE)}"
    echo "  (database, stored files, .env, compose.yaml, Caddyfile, certificates and Caddy's data - copy it somewhere safe, off this host)."
    if [ -n "$BACKUP_NOTE" ]; then echo "  It is encrypted: only the private key that goes with this host's public key can open it."
    else echo "  It is NOT encrypted and holds secrets and private keys. Switch encryption on: voxshift backup-encryption on <public-key>"; fi
    ;;
  backup-encryption) need_root "$@"; shift; backup_encryption "$@" ;;
  restore) need_root "$@"; restore_cmd "$@" ;;
  certificate) need_root "$@"; shift; cert_cmd "$@" ;;
  *)
    cat <<EOF
voxshift <command>
  status            what is running
  start | stop      start or stop everything
  restart           re-apply .env and recreate the containers
  update            back up, pull the newest images, restart, wait until it answers
  auto-update on [daily|weekly] | off | status
                    a cron job that does 'update' by itself (quiet unless a new version is out)
  self-update       fetch the installer from the latest release, check its checksum (and signature, if cosign is installed) and refresh
                    this command (secrets, settings and data untouched)
  backup [DIR]      database, stored files, .env, compose.yaml, Caddyfile, certificates and Caddy's data (and, with device status on, Kuma's data
                    and compose.override.yaml) into DIR/<timestamp> (default $DIR/backups);
                    one encrypted DIR/<timestamp>.tar.age file instead when backup encryption is on
  backup-encryption on <public-key | file> | off | status | remove-unencrypted
                    encrypt every backup so that only the owner of a private key (kept OFF this host) can read it
  restore FOLDER|FILE.tar.age [--identity KEYFILE] [--with-config] [--yes] [--force]
                    put a backup back (takes a safety backup first; asks you to type RESTORE). An encrypted backup needs --identity,
                    the file holding your private key. --with-config also restores compose.yaml, the Caddyfile, certificates and
                    Caddy's data. --force skips the "backup is newer" check
  certificate status | selfsigned | install | export
                    see which HTTPS certificate is in use and when it runs out; make a self-signed one; install your own (checked first,
                    the old settings come back if the front door does not start); save the public certificate to trust it on computers
  kuma on [--port N] [--web [PORT] | --no-web] | off [--delete-data] | status
                    device status: add Uptime Kuma (checks phones, paging units and gateways; shown in Monitoring), with its screen
                    served through the web front door (--web) or only on this server; remove it, or see it
  logs [service]    follow logs (api, worker, web, caddy, postgres, redis, kuma)
  reset-admin       set a new password for the first Super Admin and unlock the account
Files: $DIR/.env (settings, secrets), $DIR/compose.yaml (and compose.override.yaml when Kuma is on), $DIR/Caddyfile
EOF
    ;;
esac
CTL
# The command is a real file in /usr/local/bin, not a link into $DIR: $DIR is root-only, and a link into it would look
# like "command not found" to every other user. The directory it manages is written into it.
sed "s|@@DIR@@|$DIR|" "$DIR/voxshift" > "$DIR/voxshift.tmp" && mv "$DIR/voxshift.tmp" "$DIR/voxshift"
chmod 755 "$DIR/voxshift"
if [ "$START" = 1 ]; then install -m 755 "$DIR/voxshift" /usr/local/bin/voxshift.new && mv -f /usr/local/bin/voxshift.new /usr/local/bin/voxshift; ok "installed the 'voxshift' command (works from any directory; asks for sudo itself)"; fi
}

# ---------------------------------------------------------------------------------------------------------- arguments
while [ $# -gt 0 ]; do
  case "$1" in
    --base-url) BASE_URL="${2:-}"; shift 2 ;;
    --admin-email) ADMIN_EMAIL="${2:-}"; shift 2 ;;
    --admin-password) ADMIN_PASSWORD="${2:-}"; shift 2 ;;
    --tls) TLS="${2:-}"; shift 2 ;;
    --cert) CERT_FILE="${2:-}"; shift 2 ;;
    --key) KEY_FILE="${2:-}"; shift 2 ;;
    --selfsigned-days) SELFSIGNED_DAYS="${2:-}"; shift 2 ;;
    --acme-email) ACME_EMAIL="${2:-}"; shift 2 ;;
    --hsts-max-age) HSTS_MAX_AGE="${2:-}"; shift 2 ;;
    --dir) DIR="${2:-}"; shift 2 ;;
    --version) TAG="${2:-}"; shift 2 ;;
    --smtp-host) SMTP_HOST="${2:-}"; shift 2 ;;
    --smtp-port) SMTP_PORT="${2:-}"; shift 2 ;;
    --smtp-secure) SMTP_SECURE="${2:-}"; shift 2 ;;
    --smtp-user) SMTP_USER="${2:-}"; shift 2 ;;
    --smtp-pass) SMTP_PASS="${2:-}"; shift 2 ;;
    --mail-from) MAIL_FROM_ADDR="${2:-}"; shift 2 ;;
    --auto-update)
      case "${2:-}" in daily|weekly) AUTO_UPDATE="$2"; shift 2 ;; *) AUTO_UPDATE="daily"; shift ;; esac ;;
    --no-auto-update) AUTO_UPDATE="no"; shift ;;
    --backup-recipient) [ -n "${2:-}" ] || die "--backup-recipient needs a public key (age1...) or a file of them."; BACKUP_RECIPIENTS+=("$2"); shift 2 ;;
    --refresh-command) REFRESH=1; shift ;;
    --with-kuma) WITH_KUMA=1; shift ;;
    --kuma-port) KUMA_PORT="${2:-}"; shift 2 ;;
    --kuma-web) [ -n "$KUMA_WEB_PORT" ] || KUMA_WEB_PORT="8443"; shift ;;
    --kuma-web-port) KUMA_WEB_PORT="${2:-}"; shift 2 ;;
    --no-docker-install) INSTALL_DOCKER=0; shift ;;
    --open-firewall) OPEN_FIREWALL=1; shift ;;
    --generate-only) START=0; INSTALL_DOCKER=0; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "Unknown option: $1" ;;
  esac
done

# A value is stored in .env between single quotes, so it may not contain one (or a line break).
plain() { case "$1" in *\'*|*$'\n'*|*$'\r'*) die "$2 may not contain a single quote or a line break." ;; esac; }

ask() { # ask VAR "Question" [default]
  local var="$1" q="$2" def="${3:-}" reply
  if [ -n "${!var}" ]; then return; fi
  if [ "$ASSUME_YES" = 1 ] || [ ! -t 0 ]; then
    [ -n "$def" ] && { printf -v "$var" '%s' "$def"; return; }
    die "Missing $q. Pass it as an option (see --help)."
  fi
  read -r -p "$q${def:+ [$def]}: " reply || true
  printf -v "$var" '%s' "${reply:-$def}"
  [ -n "${!var}" ] || die "$q is required."
}

# A quick look at --backup-recipient values before anything is installed (the voxshift command lets the age program judge them properly later).
check_backup_recipients() {
  local r
  for r in ${BACKUP_RECIPIENTS[@]+"${BACKUP_RECIPIENTS[@]}"}; do
    if [ -f "$r" ]; then
      ! grep -q 'AGE-SECRET-KEY-' "$r" || die "$r holds a PRIVATE key. Never put the private key on the Voxshift host. Give the public key (age-keygen -y $r prints it) instead."
    else
      case "$r" in
        AGE-SECRET-KEY-*) die "--backup-recipient was given a PRIVATE key. Never put it on the Voxshift host. Give the public key (it starts with age1)." ;;
        age1*|ssh-ed25519\ *|ssh-rsa\ *) ;;
        *) die "--backup-recipient '$r' is not a public key (it starts with age1...) and is not a file I can read." ;;
      esac
    fi
  done
}

# ---------------------------------------------------------------------------------------------------------- refresh only
if [ "$REFRESH" = 1 ]; then
  case "$DIR" in /*) ;; *) die "--dir must be an absolute path." ;; esac
  [ "$(uname -s)" = "Linux" ] && [ "$(id -u)" -eq 0 ] || die "Run it as root on the Linux host: sudo bash install.sh --refresh-command"
  [ -f "$DIR/.env" ] && [ -f "$DIR/compose.yaml" ] || die "No Voxshift installation found in $DIR (it needs .env and compose.yaml). Nothing changed."
  START=1
  step "Refreshing the voxshift command in $DIR"
  check_backup_recipients
  write_command
  case "$AUTO_UPDATE" in daily|weekly) "$DIR/voxshift" auto-update on "$AUTO_UPDATE" ;; esac
  [ ${#BACKUP_RECIPIENTS[@]} -eq 0 ] || "$DIR/voxshift" backup-encryption on "${BACKUP_RECIPIENTS[@]}"
  say "  Settings, secrets, data and containers were not touched. Try: voxshift help"
  exit 0
fi

# ---------------------------------------------------------------------------------------------------------- preflight
step "Checking this host"
if [ "$START" = 1 ]; then
  [ "$(uname -s)" = "Linux" ] || die "This installer is for Linux."
  [ "$(id -u)" -eq 0 ] || die "Run it as root: sudo bash install.sh ..."
  case "$(uname -m)" in
    x86_64|amd64) ok "x86-64 CPU" ;;
    aarch64|arm64)
      ARM64=1
      warn "64-bit ARM CPU ($(uname -m)): ARM64 support is EXPERIMENTAL (for example a Raspberry Pi 4 or 5). Use x86-64 for anything that matters."
      ;;
    armv7l|armv6l|armhf|arm*) die "This host runs a 32-bit ARM system ($(uname -m)). Voxshift needs a 64-bit operating system (on a Raspberry Pi: Raspberry Pi OS Lite, 64-bit). Reinstall it with the 64-bit image and run this again." ;;
    *) die "Voxshift images are built for x86-64 (and, experimentally, 64-bit ARM) only; this host is $(uname -m)." ;;
  esac
fi

OS_ID="unknown"; OS_LIKE=""
if [ -r /etc/os-release ]; then # shellcheck disable=SC1091
  . /etc/os-release; OS_ID="${ID:-unknown}"; OS_LIKE="${ID_LIKE:-}"
fi
ok "OS: ${PRETTY_NAME:-$OS_ID}"

if [ "$START" = 1 ]; then
  mem_kb="$(awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
  [ "$mem_kb" -ge 3500000 ] || warn "Only $((mem_kb / 1024)) MB of memory. 4 GB or more is recommended (discovery runs use PowerShell)."
  mkdir -p "$(dirname "$DIR")"
  free_kb="$(df -Pk "$(dirname "$DIR")" | awk 'NR==2 {print $4}')"
  [ "$free_kb" -ge 10000000 ] || warn "Less than 10 GB free for $DIR. Images, the database and files need room."
  if [ "$ARM64" = 1 ]; then
    root_dev="$(findmnt -no SOURCE / 2>/dev/null || true)"
    case "$root_dev" in *mmcblk*) warn "This system runs from an SD card ($root_dev). The database writes all the time and wears an SD card out, and it is slow: use a USB SSD." ;; esac
  fi
  if ! command -v curl >/dev/null 2>&1; then die "curl is required. Install it (apt install curl / dnf install curl) and re-run."; fi
fi

case "$DIR" in /*) ;; *) die "--dir must be an absolute path." ;; esac
case "$DIR" in *[!A-Za-z0-9._/-]*) die "--dir may only contain letters, digits and . _ / -" ;; esac

# ---------------------------------------------------------------------------------------------------------- answers
step "Settings"
ask BASE_URL "Web address people will use (e.g. https://voice.contoso.com)"
ask ADMIN_EMAIL "First Super Admin email"
BASE_URL="${BASE_URL%/}"
case "$BASE_URL" in http://*|https://*) ;; *) die "--base-url must start with http:// or https://" ;; esac
case "$BASE_URL" in *[!A-Za-z0-9:/._\[\]-]*) die "--base-url has characters that cannot be part of an address." ;; esac
hostport="${BASE_URL#*://}"
case "$hostport" in */*) die "--base-url must be just the address, with no path (e.g. https://voice.contoso.com)." ;; esac
SCHEME="${BASE_URL%%://*}"
HOST="${hostport%%:*}"
case "$hostport" in \[*) HOST="${hostport%%]*}]" ;; esac
PORT=""; case "$hostport" in *:*) PORT="${hostport##*:}" ;; esac
case "$ADMIN_EMAIL" in *@*.*) ;; *) die "--admin-email does not look like an email address." ;; esac
plain "$ADMIN_EMAIL" "--admin-email"

if [ -z "$AUTO_UPDATE" ]; then
  AUTO_UPDATE="no"
  if [ "$ASSUME_YES" != 1 ] && [ -t 0 ] && [ "$START" = 1 ]; then
    say ""
    say "  Updates: Voxshift can check for a new version every night and install it by itself (backup first, restart only"
    say "  when something new is out). You can still run 'voxshift update' by hand, and change this later."
    reply=""
    read -r -p "  Install updates automatically every night? [y/N]: " reply || true
    case "$reply" in y|Y|yes|YES) AUTO_UPDATE="daily" ;; esac
  fi
fi
if [ "$AUTO_UPDATE" != "no" ] && [ "$TAG" != "latest" ]; then
  warn "--version $TAG pins an exact release, so there is nothing for an update job to fetch. Automatic updates left off."
  AUTO_UPDATE="no"
fi

if [ ${#BACKUP_RECIPIENTS[@]} -eq 0 ] && [ "$ASSUME_YES" != 1 ] && [ -t 0 ] && [ "$START" = 1 ]; then
  say ""
  say "  Backups: 'voxshift backup' saves the database, the secrets and the certificate private keys. They can be encrypted so that a stolen or"
  say "  copied backup is useless without your private key. For that, make a key pair on your OWN computer (age-keygen; see docs/INSTALL-LINUX-REFERENCE.md,"
  say "  Backups) and keep the private key off this host: this host is only given the public key (starts with age1)."
  reply=""
  read -r -p "  Public key to encrypt backups to (Enter to leave backups unencrypted for now): " reply || true
  [ -z "$reply" ] || BACKUP_RECIPIENTS+=("$reply")
fi
check_backup_recipients

# True for a name or address that Let's Encrypt can never issue a certificate for: an address, a name with no dot (a bare host name), or a name
# ending in a suffix that is reserved or only ever used inside a network (.local .lan .internal .corp .home .home.arpa ...). A dotted name with
# some other, unlisted suffix cannot be judged from here (that needs the public suffix list), so the "auto" choice also checks DNS (below).
is_private_host() {
  h="$(printf '%s' "$1" | tr 'A-Z' 'a-z')"; h="${h%.}"
  case "$h" in
    localhost|127.*|10.*|192.168.*|169.254.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*|100.6[4-9].*|100.[7-9][0-9].*|100.1[01][0-9].*|100.12[0-7].*|\[*\]) return 0 ;;
    *.local|*.lan|*.internal|*.intranet|*.private|*.corp|*.home|*.home.arpa|*.lab|*.localdomain|*.localhost|*.test|*.example|*.invalid|*.workgroup) return 0 ;;
  esac
  case "$h" in *.*) return 1 ;; *) return 0 ;; esac
}
is_ip() { case "$1" in *[!0-9.]*) return 1 ;; esac; case "$1" in *.*.*.*) return 0 ;; esac; return 1; }

TLS_WAS_AUTO=0
if [ "$TLS" = "auto" ]; then
  TLS_WAS_AUTO=1
  if [ "$SCHEME" = "http" ]; then TLS="none"
  elif is_ip "$HOST" || is_private_host "$HOST"; then TLS="internal"
  else TLS="acme"; fi
fi
case "$TLS" in none|acme|internal|custom|selfsigned) ;; *) die "--tls must be auto, none, acme, internal, custom or selfsigned." ;; esac
if [ "$TLS" = "none" ] && [ "$SCHEME" = "https" ]; then die "--tls none serves plain http, but the base URL is https://. Use an http:// address, or choose a TLS mode."; fi
if [ "$TLS" != "none" ] && [ "$SCHEME" = "http" ]; then die "A TLS mode needs an https:// base URL."; fi
if [ "$TLS" != "none" ] && [ -n "$PORT" ] && [ "$PORT" != "443" ]; then die "TLS modes use ports 80 and 443; leave the port out of the base URL."; fi
if [ "$TLS" = "acme" ] && { is_ip "$HOST" || is_private_host "$HOST"; }; then die "Let's Encrypt cannot issue a certificate for '$HOST'. Use --tls internal or --tls custom."; fi
if [ "$TLS" = "selfsigned" ]; then
  [ -z "$CERT_FILE$KEY_FILE" ] || die "--tls selfsigned makes its own certificate; leave --cert and --key out (or use --tls custom for your own)."
  case "$SELFSIGNED_DAYS" in ''|*[!0-9]*) die "--selfsigned-days must be a whole number of days." ;; esac
  [ "$SELFSIGNED_DAYS" -ge 30 ] && [ "$SELFSIGNED_DAYS" -le 825 ] || die "--selfsigned-days must be between 30 and 825."
  case "$HOST" in \[*) die "--tls selfsigned does not support an IPv6 address; use --tls custom." ;; esac
  [ "${#HOST}" -le 64 ] || die "A certificate name can be at most 64 characters; '$HOST' is longer. Use --tls custom."
  if [ "$START" = 1 ] && ! command -v openssl >/dev/null 2>&1; then
    say "  Installing openssl (needed to make the certificate)..."
    if command -v apt-get >/dev/null 2>&1; then DEBIAN_FRONTEND=noninteractive apt-get install -y openssl >/dev/null 2>&1 || { apt-get update -qq >/dev/null 2>&1 && DEBIAN_FRONTEND=noninteractive apt-get install -y openssl >/dev/null 2>&1; } || true
    elif command -v dnf >/dev/null 2>&1; then dnf install -y openssl >/dev/null 2>&1 || true
    elif command -v yum >/dev/null 2>&1; then yum install -y openssl >/dev/null 2>&1 || true; fi
  fi
  command -v openssl >/dev/null 2>&1 || die "openssl is needed to make a self-signed certificate and could not be installed. Install it (apt install openssl / dnf install openssl) and re-run."
fi
if [ "$TLS" = "custom" ]; then
  [ -n "$CERT_FILE" ] && [ -n "$KEY_FILE" ] || die "--tls custom needs --cert FILE and --key FILE."
  [ -r "$CERT_FILE" ] || die "Cannot read certificate $CERT_FILE"
  [ -r "$KEY_FILE" ] || die "Cannot read key $KEY_FILE"
fi
HTTP_PORT=80; HTTPS_PORT=443
if [ "$TLS" = "none" ] && [ -n "$PORT" ]; then HTTP_PORT="$PORT"; fi
[ -n "$SMTP_HOST" ] && { plain "$SMTP_HOST" "--smtp-host"; plain "$SMTP_USER" "--smtp-user"; plain "$SMTP_PASS" "--smtp-pass"; plain "$MAIL_FROM_ADDR" "--mail-from"; }
if [ -n "$ADMIN_PASSWORD" ]; then
  [ "${#ADMIN_PASSWORD}" -ge 12 ] || die "--admin-password must be at least 12 characters."
  plain "$ADMIN_PASSWORD" "--admin-password"
fi
[ -z "$ACME_EMAIL" ] || plain "$ACME_EMAIL" "--acme-email"
case "$HSTS_MAX_AGE" in ''|*[!0-9]*) die "--hsts-max-age must be a whole number of seconds (0 switches HSTS off)." ;; esac
if [ "$WITH_KUMA" = 1 ]; then
  case "$KUMA_PORT" in ''|*[!0-9]*) die "--kuma-port must be a whole number from 1024 to 65535." ;; esac
  { [ "$KUMA_PORT" -ge 1024 ] && [ "$KUMA_PORT" -le 65535 ]; } || die "--kuma-port must be from 1024 to 65535."
  if [ -n "$KUMA_WEB_PORT" ]; then
    case "$KUMA_WEB_PORT" in *[!0-9]*) die "--kuma-web-port must be a whole number from 1024 to 65535." ;; esac
    { [ "$KUMA_WEB_PORT" -ge 1024 ] && [ "$KUMA_WEB_PORT" -le 65535 ]; } || die "--kuma-web-port must be from 1024 to 65535."
    [ "$KUMA_WEB_PORT" != "$KUMA_PORT" ] || die "--kuma-web-port and --kuma-port must differ."
  fi
elif [ "$KUMA_PORT" != "3001" ] || [ -n "$KUMA_WEB_PORT" ]; then
  die "--kuma-port, --kuma-web and --kuma-web-port only make sense together with --with-kuma."
fi
[ "${#HSTS_MAX_AGE}" -le 9 ] && [ "$HSTS_MAX_AGE" -le 63072000 ] || die "--hsts-max-age may be at most 63072000 (two years)."
HSTS_MAX_AGE=$((10#$HSTS_MAX_AGE))

ok "Address: $BASE_URL   (secured: $TLS)"
if [ "$TLS_WAS_AUTO" = 1 ] && [ "$TLS" = "internal" ]; then say "  '$HOST' looks like an internal name or address, which Let's Encrypt cannot issue for, so Voxshift's own certificate authority is used. Browsers warn until they trust it (see the end of this output); --tls custom uses your own certificate instead."; fi
if [ "$TLS" = "none" ]; then
  [ "$HSTS_MAX_AGE" = "31536000" ] || warn "--hsts-max-age is ignored with --tls none: HSTS is only ever sent over https."
elif [ "$HSTS_MAX_AGE" -gt 0 ]; then ok "HSTS: Strict-Transport-Security max-age=$HSTS_MAX_AGE (no includeSubDomains, no preload)"
else ok "HSTS: off (--hsts-max-age 0)"; fi
ok "Install directory: $DIR"

if [ -f "$DIR/.env" ]; then
  die "$DIR already holds an installation. Re-running would not keep its secrets, so this installer stops. To upgrade, run: voxshift update. To start again from nothing (this DELETES its data): sudo bash uninstall.sh"
fi

# ---------------------------------------------------------------------------------------------------------- random values
rand_hex()   { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
rand_b64()   { head -c "$1" /dev/urandom | base64 | tr -d '\n'; }
rand_alnum() { LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c "$1" || true; }

# ---------------------------------------------------------------------------------------------------------- backup encryption tool
# Done before anything is installed or started: if encryption was asked for and the tool cannot be installed, stop now, with nothing changed.
if [ "$START" = 1 ] && [ ${#BACKUP_RECIPIENTS[@]} -gt 0 ] && ! command -v age >/dev/null 2>&1; then
  step "Backup encryption (the 'age' program)"
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y age >/dev/null 2>&1 || { apt-get update -qq >/dev/null 2>&1 && DEBIAN_FRONTEND=noninteractive apt-get install -y age >/dev/null 2>&1; } || true
  else
    for pm in dnf yum; do
      command -v "$pm" >/dev/null 2>&1 || continue
      "$pm" install -y age >/dev/null 2>&1 || { "$pm" install -y epel-release >/dev/null 2>&1 && "$pm" install -y age >/dev/null 2>&1; } || true
      break
    done
  fi
  command -v age >/dev/null 2>&1 || die "Backup encryption was asked for, but the 'age' program could not be installed here. Install it (Debian/Ubuntu: apt install age; RHEL family: dnf install epel-release age; or https://github.com/FiloSottile/age/releases) and re-run, or leave out --backup-recipient and switch encryption on later. Nothing was installed."
  ok "age installed ($(age --version 2>&1 | head -n 1))"
fi

# ---------------------------------------------------------------------------------------------------------- docker
if [ "$START" = 1 ]; then
  step "Docker"
  if ! command -v docker >/dev/null 2>&1; then
    [ "$INSTALL_DOCKER" = 1 ] || die "Docker is not installed (and --no-docker-install was given)."
    case " $OS_ID $OS_LIKE " in
      *" ubuntu "*|*" debian "*|*" rhel "*|*" centos "*|*" fedora "*|*" rocky "*|*" almalinux "*) ;;
      *) die "Cannot install Docker automatically on '$OS_ID'. Install Docker Engine and the compose plugin (https://docs.docker.com/engine/install/), then re-run." ;;
    esac
    say "  Installing Docker Engine from Docker's own installer (get.docker.com)..."
    curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
    sh /tmp/get-docker.sh
    rm -f /tmp/get-docker.sh
  fi
  command -v systemctl >/dev/null 2>&1 && systemctl enable --now docker >/dev/null 2>&1 || true
  docker info >/dev/null 2>&1 || die "Docker is installed but not running or not reachable. Try: systemctl start docker"
  docker compose version >/dev/null 2>&1 || die "The Docker Compose plugin is missing. Install 'docker-compose-plugin' and re-run."
  ok "$(docker --version)"; ok "$(docker compose version)"

  step "Network"
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 https://ghcr.io/v2/ || true)"
  case "$code" in 200|401) ok "ghcr.io reachable (the images come from there)" ;;
    *) die "Cannot reach https://ghcr.io (got '$code'). This host needs outbound HTTPS to ghcr.io; behind a proxy, configure Docker's proxy first." ;; esac
  if [ "$ARM64" = 1 ]; then
    # The images only carry an ARM64 build once a release has been through the ARM64 workflow; say so now rather than fail in the middle of a pull.
    mf="$(docker manifest inspect "ghcr.io/$IMAGE_OWNER/tvmf-api:$TAG" 2>/dev/null || true)"
    if [ -n "$mf" ]; then
      case "$mf" in
        *'"architecture": "arm64"'*|*'"architecture":"arm64"'*) ok "this release has ARM64 images" ;;
        *) die "Release '$TAG' has no ARM64 images (ARM64 images are added a little after each release, and only releases made after ARM64 support began have them). Try again in a few minutes, or choose a newer release with --version." ;;
      esac
    else
      warn "Could not check whether '$TAG' has ARM64 images; carrying on (the download will say if it does not)."
    fi
  fi
  busy=""
  for p in "$HTTP_PORT" $([ "$TLS" != "none" ] && echo "$HTTPS_PORT"); do
    listening="$(ss -ltn 2>/dev/null | awk '{print $4}' || true)"
    case "$listening" in *":$p"|*":$p"$'\n'*) busy="$busy $p" ;; esac
  done
  [ -z "$busy" ] || die "Port(s)$busy already in use on this host (a web server?). Stop it or free the port, then re-run."
  ok "ports free"
  if [ "$TLS" = "acme" ]; then
    if ! getent hosts "$HOST" >/dev/null 2>&1; then
      # Chosen by "auto" and unknown to DNS: this is probably an internal name with a suffix we do not recognise, and Let's Encrypt would never issue for it.
      # Say so and stop, rather than leave a web address that never gets a certificate. (A name asked for with --tls acme only gets the warning.)
      [ "$TLS_WAS_AUTO" = 1 ] && die "'$HOST' does not resolve from this host, so the installer cannot tell whether it is a public name (Let's Encrypt) or one used only inside your network. Say which, and re-run: --tls acme (a public name: create its DNS record first), --tls internal (Voxshift's own certificate authority; browsers must trust it) or --tls custom (your own certificate)."
      warn "'$HOST' does not resolve from this host yet. Let's Encrypt needs its DNS record to point here before it can issue the certificate."
    fi
  fi
fi

# ---------------------------------------------------------------------------------------------------------- files
step "Writing $DIR"
umask 077
mkdir -p "$DIR"
chmod 700 "$DIR"

POSTGRES_PASSWORD="$(rand_hex 24)"
JWT_ACCESS_SECRET="$(rand_b64 48)"
JWT_REFRESH_SECRET="$(rand_b64 48)"
DATA_ENCRYPTION_KEY="$(rand_b64 32)"
if [ -z "$ADMIN_PASSWORD" ]; then ADMIN_PASSWORD="$(rand_alnum 20)"; GENERATED_ADMIN_PASSWORD=1; fi
COOKIE_SECURE="false"; [ "$SCHEME" = "https" ] && COOKIE_SECURE="true"

cat > "$DIR/.env" <<EOF
# Voxshift configuration, written by install.sh $VERSION_OF_INSTALLER on $(date -u +%Y-%m-%dT%H:%MZ).
# KEEP THIS FILE SAFE AND BACKED UP. DATA_ENCRYPTION_KEY protects stored secrets: without it, they cannot be read.
# After editing, apply with:  voxshift restart

POSTGRES_USER=tvmf
POSTGRES_PASSWORD='$POSTGRES_PASSWORD'
POSTGRES_DB=tvmf
DATABASE_URL='postgres://tvmf:$POSTGRES_PASSWORD@postgres:5432/tvmf'
REDIS_URL=redis://redis:6379

API_PORT=4000
JWT_ACCESS_SECRET='$JWT_ACCESS_SECRET'
JWT_REFRESH_SECRET='$JWT_REFRESH_SECRET'
ACCESS_TOKEN_TTL=900
REFRESH_TOKEN_TTL=2592000
DATA_ENCRYPTION_KEY='$DATA_ENCRYPTION_KEY'

# The address people use. This is the installation default; Administration > Platform settings can change it later.
WEB_ORIGIN=$BASE_URL
COOKIE_DOMAIN=
COOKIE_SECURE=$COOKIE_SECURE
TOTP_ISSUER=Voxshift
FILES_DIR=/data/files

# The first Super Admin. The password is used only to CREATE the account on the first start; later starts leave the
# account alone, so a password changed in the app stays. To recover a lost password run: voxshift reset-admin
BOOTSTRAP_ADMIN_EMAIL='$ADMIN_EMAIL'
BOOTSTRAP_ADMIN_PASSWORD='$ADMIN_PASSWORD'

TEAMS_EXECUTOR=pwsh
TEAMS_SESSION_TTL_MINUTES=240
TEAMS_COMMAND_TIMEOUT_MS=900000

# Email. Leave SMTP_HOST empty and no email is sent (messages are logged by the worker). Switch email on or off for the
# whole platform in Administration > Platform settings.
SMTP_HOST='$SMTP_HOST'
SMTP_PORT=$SMTP_PORT
SMTP_SECURE=$SMTP_SECURE
SMTP_USER='$SMTP_USER'
SMTP_PASS='$SMTP_PASS'
MAIL_FROM='$MAIL_FROM_ADDR'

# Used by compose.yaml (not read by the application).
HTTP_PORT=$HTTP_PORT
HTTPS_PORT=$HTTPS_PORT
IMAGE_TAG=$TAG
EOF
chmod 600 "$DIR/.env"
# MAIL_FROM='' would override the application's default sender with an empty one; drop empty optional lines.
grep -vE "^(MAIL_FROM|SMTP_USER|SMTP_PASS)=''$" "$DIR/.env" > "$DIR/.env.tmp" && mv "$DIR/.env.tmp" "$DIR/.env" && chmod 600 "$DIR/.env"
ok ".env (secrets generated; mode 600)"

# --- compose.yaml: same services as deploy/dockge/compose.yaml, with Caddy in front (the one published entry point).
PORTS='      - "${HTTP_PORT:-80}:80"'
if [ "$TLS" != "none" ]; then PORTS="$PORTS
      - \"\${HTTPS_PORT:-443}:443\""; fi
CERT_MOUNT=""
if [ "$TLS" = "custom" ]; then
  mkdir -p "$DIR/certs"
  cp "$CERT_FILE" "$DIR/certs/server.crt"; cp "$KEY_FILE" "$DIR/certs/server.key"
  chmod 600 "$DIR/certs/server.key"
  CERT_MOUNT='
      - ./certs:/certs:ro'
fi
if [ "$TLS" = "selfsigned" ]; then
  mkdir -p "$DIR/certs"; chmod 700 "$DIR/certs"
  make_selfsigned "$HOST" "$SELFSIGNED_DAYS" "$DIR/certs" || die "Could not make the self-signed certificate."
  chmod 644 "$DIR/certs/server.crt"; chmod 600 "$DIR/certs/server.key"
  ok "self-signed certificate for $HOST (valid $SELFSIGNED_DAYS days)"
  CERT_MOUNT='
      - ./certs:/certs:ro'
fi

cat > "$DIR/compose.yaml" <<EOF
# Voxshift - written by install.sh $VERSION_OF_INSTALLER. Edit .env, not this file; 'voxshift update' pulls new images.
# Every service: no-new-privileges, all Linux capabilities dropped (only the few each image needs are added back) and capped log files.
# api, web and redis also have a read-only root filesystem. api, worker and web have healthchecks.
name: voxshift
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    cap_add:
      - CHOWN
      - DAC_OVERRIDE
      - FOWNER
      - SETGID
      - SETUID
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
    environment:
      POSTGRES_USER: \${POSTGRES_USER:-tvmf}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}
      POSTGRES_DB: \${POSTGRES_DB:-tvmf}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U \${POSTGRES_USER:-tvmf} -d \${POSTGRES_DB:-tvmf}"]
      interval: 5s
      timeout: 5s
      retries: 15

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    read_only: true
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    cap_add:
      - CHOWN
      - DAC_OVERRIDE
      - SETGID
      - SETUID
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
    command: ["redis-server", "--appendonly", "yes"]
    volumes:
      - redisdata:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 15

  api:
    image: ghcr.io/$IMAGE_OWNER/tvmf-api:\${IMAGE_TAG:-latest}
    restart: unless-stopped
    read_only: true
    tmpfs:
      - /tmp
    security_opt:
      - no-new-privileges:true
    # The entrypoint starts as root only to hand an older, root-owned files volume to the app user once, then drops to "node".
    cap_drop:
      - ALL
    cap_add:
      - CHOWN
      - SETGID
      - SETUID
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
    env_file: .env
    environment:
      NODE_ENV: production
    # Apply platform + tenant migrations, upsert the bootstrap admin, then start.
    command: ["sh", "-c", "node packages/db/dist/migrate.js && node packages/db/dist/seed.js && node apps/api/dist/main.js"]
    volumes:
      - filesdata:/data/files
    # Not published on the host: only the web container (and through it, Caddy) reaches it.
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 120s
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy

  worker:
    image: ghcr.io/$IMAGE_OWNER/tvmf-worker:\${IMAGE_TAG:-latest}
    restart: unless-stopped
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
    env_file: .env
    environment:
      NODE_ENV: production
    # The worker touches /tmp/worker-alive every 15 s; a stale file means its event loop is stuck.
    healthcheck:
      test: ["CMD", "node", "-e", "try{process.exit(Date.now()-require('fs').statSync('/tmp/worker-alive').mtimeMs<120000?0:1)}catch{process.exit(1)}"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 90s
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      api:
        condition: service_started

  web:
    image: ghcr.io/$IMAGE_OWNER/tvmf-web:\${IMAGE_TAG:-latest}
    restart: unless-stopped
    read_only: true
    tmpfs:
      - /tmp
      - /run
      - /var/cache/nginx
    security_opt:
      - no-new-privileges:true
    # nginx starts as root only to run its workers as "nginx"; it listens on port 80 inside the container and is not published (Caddy is the front door).
    cap_drop:
      - ALL
    cap_add:
      - CHOWN
      - NET_BIND_SERVICE
      - SETGID
      - SETUID
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
    # Not published: Caddy is the single front door (the API counts exactly two proxy hops: Caddy, then this nginx).
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1/version.json"]
      interval: 30s
      timeout: 5s
      retries: 3
    depends_on:
      - api

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    cap_add:
      - NET_BIND_SERVICE
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
    ports:
$PORTS
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddydata:/data
      - caddyconfig:/config$CERT_MOUNT
    depends_on:
      - web

volumes:
  pgdata:
  redisdata:
  filesdata:
  caddydata:
  caddyconfig:
EOF
cat -s "$DIR/compose.yaml" > "$DIR/compose.tmp" && mv "$DIR/compose.tmp" "$DIR/compose.yaml"

# --- Caddyfile
# HSTS is set here and nowhere else: the web container's nginx cannot tell whether the address is https, and the API (helmet) has its own HSTS
# switched off (apps/api/src/main.ts), so a browser gets exactly one value. A tab-indented line inside the https site block; empty when off.
HSTS_LINE=""
if [ "$TLS" != "none" ] && [ "$HSTS_MAX_AGE" -gt 0 ]; then HSTS_LINE="	header Strict-Transport-Security \"max-age=$HSTS_MAX_AGE\"
"; fi
case "$TLS" in
  none)
    cat > "$DIR/Caddyfile" <<EOF
{
	auto_https off
}
:80 {
	encode gzip
	reverse_proxy web:80
}
EOF
    ;;
  acme)
    { [ -z "$ACME_EMAIL" ] || printf '{\n\temail %s\n}\n' "$ACME_EMAIL"; } > "$DIR/Caddyfile"
    cat >> "$DIR/Caddyfile" <<EOF
$HOST {
	encode gzip
${HSTS_LINE}	reverse_proxy web:80
}
EOF
    ;;
  internal)
    cat > "$DIR/Caddyfile" <<EOF
$HOST {
	tls internal
	encode gzip
${HSTS_LINE}	reverse_proxy web:80
}
EOF
    ;;
  custom|selfsigned)
    cat > "$DIR/Caddyfile" <<EOF
$HOST {
	tls /certs/server.crt /certs/server.key
	encode gzip
${HSTS_LINE}	reverse_proxy web:80
}
EOF
    ;;
esac
ok "compose.yaml and Caddyfile"
if [ "$WITH_KUMA" = 1 ]; then
  kuma_override "$KUMA_PORT" "$KUMA_WEB_PORT" > "$DIR/compose.override.yaml"; chmod 644 "$DIR/compose.override.yaml"
  ok "compose.override.yaml (Uptime Kuma for device status, on this host only: 127.0.0.1:$KUMA_PORT)"
  if [ -n "$KUMA_WEB_PORT" ]; then
    kmode="$TLS"; [ "$kmode" != "selfsigned" ] || kmode="custom"
    kuma_caddy_block "$HOST" "$kmode" "$KUMA_WEB_PORT" >> "$DIR/Caddyfile"
    ok "Kuma's screen is also served through the web front door on port $KUMA_WEB_PORT (Caddyfile)"
  fi
fi

write_command


if [ "$START" = 1 ] && [ "$AUTO_UPDATE" != "no" ]; then
  step "Automatic updates"
  "$DIR/voxshift" auto-update on "$AUTO_UPDATE" || warn "Could not set up the update job. Install updates by hand with: voxshift update (or retry: voxshift auto-update on)"
fi

if [ "$START" = 1 ] && [ ${#BACKUP_RECIPIENTS[@]} -gt 0 ]; then
  step "Backup encryption"
  "$DIR/voxshift" backup-encryption on "${BACKUP_RECIPIENTS[@]}" || die "Voxshift is installed, but backup encryption could NOT be switched on (see above), so backups would be unencrypted. Fix it and run: voxshift backup-encryption on <public-key>"
fi

if [ "$START" = 0 ]; then
  step "Files written (nothing started)"
  say "  Review $DIR, then start with:  cd $DIR && docker compose up -d"
  exit 0
fi

# ---------------------------------------------------------------------------------------------------------- firewall
if [ "$OPEN_FIREWALL" = 1 ]; then
  step "Firewall"
  ufw_state="$(ufw status 2>/dev/null || true)"
  if command -v ufw >/dev/null 2>&1 && [ "${ufw_state#*Status: active}" != "$ufw_state" ]; then
    ufw allow "$HTTP_PORT/tcp" >/dev/null; [ "$TLS" != "none" ] && ufw allow "$HTTPS_PORT/tcp" >/dev/null; [ -z "$KUMA_WEB_PORT" ] || ufw allow "$KUMA_WEB_PORT/tcp" >/dev/null; ok "ufw: opened the web ports"
  elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    firewall-cmd --permanent --add-port="$HTTP_PORT/tcp" >/dev/null; [ "$TLS" != "none" ] && firewall-cmd --permanent --add-port="$HTTPS_PORT/tcp" >/dev/null; [ -z "$KUMA_WEB_PORT" ] || firewall-cmd --permanent --add-port="$KUMA_WEB_PORT/tcp" >/dev/null
    firewall-cmd --reload >/dev/null; ok "firewalld: opened the web ports"
  else
    warn "No active ufw or firewalld found; nothing changed."
  fi
fi

# ---------------------------------------------------------------------------------------------------------- start
step "Pulling images and starting (a few minutes the first time)"
cd "$DIR"
docker compose pull
docker compose up -d
"$DIR/voxshift" status >/dev/null 2>&1 || true

step "Waiting for Voxshift to answer"
ready=0
for _ in $(seq 1 72); do
  out="$(docker compose exec -T web wget -q -O /dev/null -S http://127.0.0.1/api/auth/me 2>&1 || true)"
  case "$out" in *" 401 "*) ready=1; break ;; esac
  printf '.'; sleep 5
done
echo
if [ "$ready" != 1 ]; then
  warn "It has not answered after 6 minutes. Check: voxshift logs api    (the first start runs the database migrations)"
  exit 1
fi
ok "Voxshift is up"

# ---------------------------------------------------------------------------------------------------------- done
step "Done"
cat <<EOF

  Open:            $B$BASE_URL$N
  Sign in as:      $ADMIN_EMAIL
EOF
if [ "$GENERATED_ADMIN_PASSWORD" = 1 ]; then
  printf '  Password:        %s%s%s   (shown once here; also in %s/.env until you remove it. Set up MFA when asked. Lost it later? voxshift reset-admin)\n' "$B" "$ADMIN_PASSWORD" "$N" "$DIR"
else
  say "  Password:        the one you gave"
fi
cat <<EOF

  Next:
   1. Sign in, then open Administration > Platform settings to confirm the web address.
$( [ -n "$SMTP_HOST" ] || printf '      To send email, set SMTP_HOST (and the other SMTP_ lines) in %s/.env, then run: voxshift restart\n' "$DIR" )
   2. Back up regularly:  voxshift backup   (copy the result off this host)
$( if [ ${#BACKUP_RECIPIENTS[@]} -gt 0 ]; then printf '      Backups are ENCRYPTED. Keep the matching private key OFF this host; without it they cannot be read.\n'; else printf '      Backups are not encrypted yet: voxshift backup-encryption on <public-key>   (docs/INSTALL-LINUX-REFERENCE.md, Backups)\n'; fi )
$( if [ "$AUTO_UPDATE" != "no" ]; then printf '   3. Updates:            automatic (%s); see or change with: voxshift auto-update status\n' "$AUTO_UPDATE"; else printf '   3. Upgrade later:      voxshift update   (or let it do it for you: voxshift auto-update on)\n'; fi )
$( if [ "$WITH_KUMA" = 1 ]; then
  if [ -n "$KUMA_WEB_PORT" ]; then printf '   4. Device status:      Kuma is installed. Then open Monitoring in Voxshift, press Set up automatically and add the devices (Kuma needs nothing by hand).\n                          Kuma'"'"'s own screen, to look at it: %s://%s:%s (open that port in the firewall for staff networks only)\n' "$([ "$TLS" = none ] && echo http || echo https)" "${HOST:-<this server>}" "$KUMA_WEB_PORT"
  else printf '   4. Device status:      Kuma is installed (this host only, 127.0.0.1:%s). Open Monitoring in Voxshift, press Set up automatically and add the devices (Kuma needs nothing by hand).\n                          To look at Kuma'"'"'s own screen: voxshift kuma on --web, or an SSH tunnel. More: voxshift kuma status\n' "$KUMA_PORT"; fi
fi )
EOF
if [ "$TLS" = "internal" ]; then
  cat <<EOF

  Certificate: you chose Voxshift's private CA, so browsers will warn until they trust it. To get the root certificate:
     cd $DIR && docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./voxshift-root.crt
  and install it as a trusted root on staff computers (or use --tls custom with your own certificate next time).
EOF
fi
if [ "$TLS" = "selfsigned" ]; then
  cat <<EOF

  Certificate: you chose a self-signed certificate (valid $SELFSIGNED_DAYS days), so browsers will warn until each computer trusts it.
  Save the public certificate with:  sudo voxshift certificate export
  then install that file as a trusted certificate on each computer (the install guide has the steps).
  Check it any time with:  voxshift certificate status
EOF
fi
if [ "$TLS" = "none" ]; then
  warn "Plain http: sign-in cookies and passwords cross the network unencrypted. Fine for a test; use https for real use."
fi
