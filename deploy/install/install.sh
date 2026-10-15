#!/usr/bin/env bash
# Voxshift installer for a new Linux host (Debian/Ubuntu, RHEL/Rocky/Alma/CentOS/Fedora, or any Linux that already has Docker).
#
#   curl -fsSL https://raw.githubusercontent.com/gauntlec/teams-voice-migration-factory/main/deploy/install/install.sh -o install.sh
#   sudo bash install.sh --base-url https://voice.contoso.com --admin-email admin@contoso.com
#
# What it does: installs Docker if missing, writes /opt/voxshift (compose file, Caddy front door, .env with freshly
# generated secrets), pulls the images from ghcr.io, starts everything, waits until it answers, and installs the
# `voxshift` command (status / update / backup / logs ...). Safe to read first; it asks before doing anything unusual.
# Full guide: docs/INSTALL-LINUX.md.
set -Eeuo pipefail

VERSION_OF_INSTALLER="1.0"
IMAGE_OWNER="gauntlec"

# ---------------------------------------------------------------------------------------------------------- defaults
DIR="/opt/voxshift"
BASE_URL=""
ADMIN_EMAIL=""
ADMIN_PASSWORD=""
TLS="auto"            # auto | none | acme | internal | custom
CERT_FILE=""
KEY_FILE=""
ACME_EMAIL=""
TAG="latest"
INSTALL_DOCKER=1
OPEN_FIREWALL=0
START=1
ASSUME_YES=0
SMTP_HOST="" SMTP_PORT="587" SMTP_SECURE="false" SMTP_USER="" SMTP_PASS="" MAIL_FROM_ADDR=""
GENERATED_ADMIN_PASSWORD=0

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
                           auto      https + a public name -> acme; https + an IP or private name -> internal; http -> none
                           none      plain http (a test install, or behind a network you trust)
                           acme      a free Let's Encrypt certificate (the host must be reachable from the internet on 80/443)
                           internal  a certificate from Voxshift's own private CA (staff browsers must trust it once)
                           custom    your own certificate: --cert FILE --key FILE
  --cert FILE --key FILE Certificate (full chain, PEM) and private key for --tls custom
  --acme-email EMAIL     Contact address for Let's Encrypt expiry notices (acme)
  --dir PATH             Install directory (default $DIR)
  --version TAG          Image tag: latest (default) or sha-<commit>

Email (optional; can be set later in $DIR/.env, and switched off in Administration > Platform settings):
  --smtp-host H --smtp-port P --smtp-secure true|false --smtp-user U --smtp-pass PW --mail-from ADDR

Other:
  --no-docker-install    Do not install Docker; stop if it is missing
  --open-firewall        Open ports 80/443 in ufw or firewalld if one is active
  --generate-only        Write the files, but do not install Docker or start anything (for review)
  -y, --yes              Do not ask questions; use defaults
  -h, --help             This text
EOF
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
    --acme-email) ACME_EMAIL="${2:-}"; shift 2 ;;
    --dir) DIR="${2:-}"; shift 2 ;;
    --version) TAG="${2:-}"; shift 2 ;;
    --smtp-host) SMTP_HOST="${2:-}"; shift 2 ;;
    --smtp-port) SMTP_PORT="${2:-}"; shift 2 ;;
    --smtp-secure) SMTP_SECURE="${2:-}"; shift 2 ;;
    --smtp-user) SMTP_USER="${2:-}"; shift 2 ;;
    --smtp-pass) SMTP_PASS="${2:-}"; shift 2 ;;
    --mail-from) MAIL_FROM_ADDR="${2:-}"; shift 2 ;;
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

# ---------------------------------------------------------------------------------------------------------- preflight
step "Checking this host"
if [ "$START" = 1 ]; then
  [ "$(uname -s)" = "Linux" ] || die "This installer is for Linux."
  [ "$(id -u)" -eq 0 ] || die "Run it as root: sudo bash install.sh ..."
  case "$(uname -m)" in
    x86_64|amd64) ok "x86-64 CPU" ;;
    *) die "Voxshift images are built for x86-64 only; this host is $(uname -m)." ;;
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

is_private_host() { case "$1" in localhost|127.*|10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*|\[*\]|*.local|*.lan|*.internal|*.test|*.localdomain) return 0 ;; esac; case "$1" in *.*) return 1 ;; *) return 0 ;; esac; }
is_ip() { case "$1" in *[!0-9.]*) return 1 ;; esac; case "$1" in *.*.*.*) return 0 ;; esac; return 1; }

if [ "$TLS" = "auto" ]; then
  if [ "$SCHEME" = "http" ]; then TLS="none"
  elif is_ip "$HOST" || is_private_host "$HOST"; then TLS="internal"
  else TLS="acme"; fi
fi
case "$TLS" in none|acme|internal|custom) ;; *) die "--tls must be auto, none, acme, internal or custom." ;; esac
if [ "$TLS" = "none" ] && [ "$SCHEME" = "https" ]; then die "--tls none serves plain http, but the base URL is https://. Use an http:// address, or choose a TLS mode."; fi
if [ "$TLS" != "none" ] && [ "$SCHEME" = "http" ]; then die "A TLS mode needs an https:// base URL."; fi
if [ "$TLS" != "none" ] && [ -n "$PORT" ] && [ "$PORT" != "443" ]; then die "TLS modes use ports 80 and 443; leave the port out of the base URL."; fi
if [ "$TLS" = "acme" ] && { is_ip "$HOST" || is_private_host "$HOST"; }; then die "Let's Encrypt cannot issue a certificate for '$HOST'. Use --tls internal or --tls custom."; fi
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

ok "Address: $BASE_URL   (secured: $TLS)"
ok "Install directory: $DIR"

if [ -f "$DIR/.env" ]; then
  die "$DIR already holds an installation. Re-running would not keep its secrets, so this installer stops. To upgrade, run: voxshift update. To start again from nothing (this DELETES its data): sudo bash uninstall.sh"
fi

# ---------------------------------------------------------------------------------------------------------- random values
rand_hex()   { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
rand_b64()   { head -c "$1" /dev/urandom | base64 | tr -d '\n'; }
rand_alnum() { LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c "$1" || true; }

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
  busy=""
  for p in "$HTTP_PORT" $([ "$TLS" != "none" ] && echo "$HTTPS_PORT"); do
    listening="$(ss -ltn 2>/dev/null | awk '{print $4}' || true)"
    case "$listening" in *":$p"|*":$p"$'\n'*) busy="$busy $p" ;; esac
  done
  [ -z "$busy" ] || die "Port(s)$busy already in use on this host (a web server?). Stop it or free the port, then re-run."
  ok "ports free"
  if [ "$TLS" = "acme" ]; then
    getent hosts "$HOST" >/dev/null 2>&1 || warn "'$HOST' does not resolve from this host yet. Let's Encrypt needs its DNS record to point here before it can issue the certificate."
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

cat > "$DIR/compose.yaml" <<EOF
# Voxshift - written by install.sh $VERSION_OF_INSTALLER. Edit .env, not this file; 'voxshift update' pulls new images.
name: voxshift
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
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
    env_file: .env
    environment:
      NODE_ENV: production
    # Apply platform + tenant migrations, upsert the bootstrap admin, then start.
    command: ["sh", "-c", "node packages/db/dist/migrate.js && node packages/db/dist/seed.js && node apps/api/dist/main.js"]
    volumes:
      - filesdata:/data/files
    # Not published on the host: only the web container (and through it, Caddy) reaches it.
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy

  worker:
    image: ghcr.io/$IMAGE_OWNER/tvmf-worker:\${IMAGE_TAG:-latest}
    restart: unless-stopped
    env_file: .env
    environment:
      NODE_ENV: production
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
    # Not published: Caddy is the single front door (the API counts exactly two proxy hops: Caddy, then this nginx).
    depends_on:
      - api

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
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
	reverse_proxy web:80
}
EOF
    ;;
  internal)
    cat > "$DIR/Caddyfile" <<EOF
$HOST {
	tls internal
	encode gzip
	reverse_proxy web:80
}
EOF
    ;;
  custom)
    cat > "$DIR/Caddyfile" <<EOF
$HOST {
	tls /certs/server.crt /certs/server.key
	encode gzip
	reverse_proxy web:80
}
EOF
    ;;
esac
ok "compose.yaml and Caddyfile"

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
cd "$DIR"
dc() { docker compose "$@"; }
need_root() { [ "$(id -u)" -eq 0 ] || { echo "Run as root: sudo voxshift $*" >&2; exit 1; }; }

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

case "${1:-help}" in
  status)  dc ps ;;
  start)   need_root "$@"; dc up -d; wait_ready ;;
  stop)    need_root "$@"; dc stop ;;
  restart) need_root "$@"; dc up -d --force-recreate; wait_ready ;;
  logs)    shift; dc logs --tail 200 -f "$@" ;;
  reset-admin)
    # Recovery: new password for the first Super Admin (from BOOTSTRAP_ADMIN_EMAIL), role/status/lockout put right.
    read -r -s -p "New password for the first admin (12 or more characters): " pw; echo
    read -r -s -p "Again: " pw2; echo
    [ "$pw" = "$pw2" ] || { echo "The two passwords differ. Nothing changed." >&2; exit 1; }
    [ "${#pw}" -ge 12 ] || { echo "Use at least 12 characters. Nothing changed." >&2; exit 1; }
    BOOTSTRAP_ADMIN_RESET=true BOOTSTRAP_ADMIN_PASSWORD="$pw" dc exec -T -e BOOTSTRAP_ADMIN_RESET -e BOOTSTRAP_ADMIN_PASSWORD api node packages/db/dist/seed.js
    ;;
  update)
    need_root "$@"
    echo "Taking a backup first..."; "$0" backup
    dc pull
    dc up -d
    wait_ready
    docker image prune -f >/dev/null 2>&1 || true
    ;;
  backup)
    need_root "$@"
    dest="${2:-$DIR/backups}/$(date -u +%Y%m%d-%H%M%S)"
    mkdir -p "$dest"; chmod 700 "$dest"
    dc exec -T postgres pg_dump -U tvmf -Fc tvmf > "$dest/database.dump"
    docker run --rm -v voxshift_filesdata:/data:ro -v "$dest":/out alpine tar czf /out/files.tar.gz -C /data .
    cp .env "$dest/env"; chmod 600 "$dest/env"
    echo "Backup written to $dest  (database, stored files and .env - keep it somewhere safe, off this host)."
    # keep the last 14 local backups
    ls -1dt "$(dirname "$dest")"/*/ 2>/dev/null | tail -n +15 | xargs -r rm -rf
    ;;
  *)
    cat <<EOF
voxshift <command>
  status            what is running
  start | stop      start or stop everything
  restart           re-apply .env and recreate the containers
  update            back up, pull the newest images, restart, wait until it answers
  backup [DIR]      database + stored files + .env into DIR/<timestamp> (default $DIR/backups)
  logs [service]    follow logs (api, worker, web, caddy, postgres, redis)
  reset-admin       set a new password for the first Super Admin and unlock the account
Files: $DIR/.env (settings, secrets), $DIR/compose.yaml, $DIR/Caddyfile
EOF
    ;;
esac
CTL
# The command is a real file in /usr/local/bin, not a link into $DIR: $DIR is root-only, and a link into it would look
# like "command not found" to every other user. The directory it manages is written into it.
sed "s|@@DIR@@|$DIR|" "$DIR/voxshift" > "$DIR/voxshift.tmp" && mv "$DIR/voxshift.tmp" "$DIR/voxshift"
chmod 755 "$DIR/voxshift"
if [ "$START" = 1 ]; then install -m 755 "$DIR/voxshift" /usr/local/bin/voxshift; ok "installed the 'voxshift' command (works from any directory; asks for sudo itself)"; fi

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
    ufw allow "$HTTP_PORT/tcp" >/dev/null; [ "$TLS" != "none" ] && ufw allow "$HTTPS_PORT/tcp" >/dev/null; ok "ufw: opened the web ports"
  elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    firewall-cmd --permanent --add-port="$HTTP_PORT/tcp" >/dev/null; [ "$TLS" != "none" ] && firewall-cmd --permanent --add-port="$HTTPS_PORT/tcp" >/dev/null
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
   3. Upgrade later:      voxshift update
EOF
if [ "$TLS" = "internal" ]; then
  cat <<EOF

  Certificate: you chose Voxshift's private CA, so browsers will warn until they trust it. To get the root certificate:
     cd $DIR && docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./voxshift-root.crt
  and install it as a trusted root on staff computers (or use --tls custom with your own certificate next time).
EOF
fi
if [ "$TLS" = "none" ]; then
  warn "Plain http: sign-in cookies and passwords cross the network unencrypted. Fine for a test; use https for real use."
fi
