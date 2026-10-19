#!/usr/bin/env bash
# Removes a Voxshift installation made by install.sh, so install.sh can be run again on a clean host.
#
#   sudo bash uninstall.sh                    # shows what it will remove, asks you to type DELETE
#   sudo bash uninstall.sh --backup-to /root/voxshift-last-backup --yes
#
# Removes: the containers, the DATABASE and stored files (Docker volumes), the install directory (including .env and its
# secrets) and the `voxshift` command. Keeps: Docker itself, other containers, and any firewall rule you opened.
# This DELETES ALL VOXSHIFT DATA. Take a backup first (--backup-to does it for you).
set -Eeuo pipefail

DIR="/opt/voxshift"
PROJECT="voxshift"
BACKUP_TO=""
KEEP_CERTS=0
REMOVE_IMAGES=0
ASSUME_YES=0
DRY=0

if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'; else B=""; G=""; Y=""; R=""; N=""; fi
step() { printf '\n%s==> %s%s\n' "$B" "$*" "$N"; }
ok()   { printf '%s  ok%s  %s\n' "$G" "$N" "$*"; }
warn() { printf '%s  !!%s  %s\n' "$Y" "$N" "$*" >&2; }
die()  { printf '%s  error%s  %s\n' "$R" "$N" "$*" >&2; exit 1; }

usage() {
  cat <<EOF
Usage: sudo bash uninstall.sh [options]

  --dir PATH         Install directory (default $DIR)
  --backup-to DIR    Run 'voxshift backup DIR' first (database, files, .env, Caddy settings and data), then remove
  --keep-certs       Keep Caddy's certificate store, so a reinstall reuses the issued Let's Encrypt certificate
                     (Let's Encrypt limits how many certificates one name can get per week)
  --remove-images    Also delete the downloaded Voxshift, Postgres, Redis and Caddy images (the reinstall downloads them again)
  --dry-run          Show what would be removed; change nothing
  -y, --yes          Do not ask for confirmation
  -h, --help         This text
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="${2:-}"; shift 2 ;;
    --backup-to) BACKUP_TO="${2:-}"; shift 2 ;;
    --keep-certs) KEEP_CERTS=1; shift ;;
    --remove-images) REMOVE_IMAGES=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "Unknown option: $1" ;;
  esac
done

# In a dry run, say what would be done (on a saved copy of stdout, so a redirect on the command does not hide it) and do nothing.
exec 3>&1
run() { if [ "$DRY" = 1 ]; then printf '  [dry-run] %s\n' "$*" >&3; else "$@"; fi; }
did() { [ "$DRY" = 1 ] || ok "$*"; }

step "Checking"
[ "$(uname -s)" = "Linux" ] || die "This script is for Linux."
[ "$DRY" = 1 ] || [ "$(id -u)" -eq 0 ] || die "Run it as root: sudo bash uninstall.sh"
command -v docker >/dev/null 2>&1 || die "Docker is not installed, so there is nothing for this script to remove."
docker info >/dev/null 2>&1 || die "Docker is not running or not reachable (systemctl start docker)."

# Safety: only ever delete a directory that is clearly a Voxshift install, never something like / or /opt.
case "$DIR" in /*) ;; *) die "--dir must be an absolute path." ;; esac
case "$DIR" in /|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/var) die "Refusing to remove '$DIR'." ;; esac
DIR_PRESENT=0
if [ -d "$DIR" ]; then
  if [ -f "$DIR/compose.yaml" ] && grep -q "^name: $PROJECT\$" "$DIR/compose.yaml" && [ -f "$DIR/.env" ]; then DIR_PRESENT=1
  else die "$DIR does not look like a Voxshift installation (no compose.yaml named '$PROJECT' and .env). Nothing removed. Use --dir if it is somewhere else."; fi
fi

containers="$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT")"
volumes="$(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT")"
if [ "$KEEP_CERTS" = 1 ]; then volumes="$(printf '%s\n' "$volumes" | grep -vE "(^|_)(caddydata|caddyconfig)$" || true)"; fi
if [ -z "$containers$volumes" ] && [ "$DIR_PRESENT" = 0 ] && [ ! -e /usr/local/bin/voxshift ]; then
  ok "No Voxshift installation found. You can run install.sh."
  exit 0
fi

step "This will remove"
[ -n "$containers" ] && printf '  containers: %s\n' "$(docker ps -a --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Names}}' | tr '\n' ' ')"
[ -n "$volumes" ] && printf '  data volumes: %s\n' "$(printf '%s' "$volumes" | tr '\n' ' ')"
[ "$KEEP_CERTS" = 1 ] && printf '  (keeping the certificate store: --keep-certs)\n'
[ "$DIR_PRESENT" = 1 ] && printf '  directory: %s   (includes .env: the secrets and the admin password)\n' "$DIR"
[ -e /usr/local/bin/voxshift ] && printf '  command: /usr/local/bin/voxshift\n'
[ "$REMOVE_IMAGES" = 1 ] && printf '  the downloaded images\n'
[ -n "$BACKUP_TO" ] && printf '  (after a backup to %s)\n' "$BACKUP_TO"
printf '\n  %sAll Voxshift data on this host will be lost.%s Docker itself and your other containers are not touched.\n' "$R" "$N"

if [ "$ASSUME_YES" != 1 ] && [ "$DRY" != 1 ]; then
  [ -t 0 ] || die "Not a terminal. Pass --yes to confirm."
  read -r -p "  Type DELETE to continue: " reply || true
  [ "${reply:-}" = "DELETE" ] || die "Not confirmed. Nothing removed."
fi

if [ -n "$BACKUP_TO" ]; then
  step "Backup"
  [ "$DIR_PRESENT" = 1 ] && [ -x "$DIR/voxshift" ] || die "--backup-to needs a working install ($DIR/voxshift). Nothing removed."
  run "$DIR/voxshift" backup "$BACKUP_TO"
fi

step "Removing"
if [ -n "$containers" ]; then
  # shellcheck disable=SC2086
  run docker rm -f $containers >/dev/null && did "containers removed"
fi
if [ -n "$volumes" ]; then
  # shellcheck disable=SC2086
  run docker volume rm $volumes >/dev/null && did "data volumes removed"
fi
# The project's network, if Compose left it behind.
docker network ls -q --filter "label=com.docker.compose.project=$PROJECT" | while read -r n; do run docker network rm "$n" >/dev/null 2>&1 || true; done
if [ "$REMOVE_IMAGES" = 1 ]; then
  for img in $(docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^(ghcr\.io/[^/]+/tvmf-(api|worker|web):.+|postgres:16-alpine|redis:7-alpine|caddy:2-alpine)$' || true); do run docker rmi "$img" >/dev/null 2>&1 || true; done
  did "images removed"
fi
if [ -f /etc/cron.d/voxshift-update ]; then run rm -f /etc/cron.d/voxshift-update /etc/logrotate.d/voxshift-update && did "removed the automatic update job"; fi
if [ -L /usr/local/bin/voxshift ] || [ -f /usr/local/bin/voxshift ]; then run rm -f /usr/local/bin/voxshift && did "removed the voxshift command"; fi
if [ "$DIR_PRESENT" = 1 ]; then run rm -rf -- "$DIR" && did "removed $DIR"; fi

step "Done"
if [ "$DRY" = 1 ]; then echo "  Dry run: nothing was changed."; else
  echo "  Voxshift is removed. To install again: sudo bash install.sh ..."
  [ -z "$BACKUP_TO" ] || echo "  Your backup is in $BACKUP_TO"
  echo "  Left in place: Docker, and any firewall rule opened for ports 80/443."
fi
