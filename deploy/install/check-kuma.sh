#!/usr/bin/env bash
# Checks the device status (Uptime Kuma) part of the installer without Docker, a database or root: the compose.override.yaml it writes
# (--with-kuma), that the installer and the generated 'voxshift' command write the same text, and the command's 'kuma on|off|status', backup and
# restore of Kuma's data, run against a STUB docker (a script that fakes the compose calls and the volume archives). Run:  bash deploy/install/check-kuma.sh
# Not a substitute for a real install on a Linux host.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SHELLCHECK="$(command -v shellcheck || true)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail=0
bad() { echo "FAIL: $*"; fail=1; }
good() { echo "  ok: $*"; }

# ---------------------------------------------------------------- one text, two places
echo "The installer and the generated command write the same Kuma file:"
blocks="$(awk '/^kuma_override\(\) \{/{f=1; n++} f{print > ("'"$T"'/block" n ".txt")} /^\}/{f=0}' "$HERE/install.sh"; ls "$T"/block*.txt 2>/dev/null | wc -l | tr -d ' ')"
[ "$blocks" = 2 ] && good "two kuma_override functions found" || bad "expected 2 kuma_override functions in install.sh, found $blocks"
cmp -s "$T/block1.txt" "$T/block2.txt" && good "they are identical" || bad "kuma_override differs between the installer and the generated command"
imgs="$(grep -c '^ *KUMA_IMAGE_DEFAULT="' "$HERE/install.sh")"; [ "$imgs" = 2 ] && [ "$(grep '^ *KUMA_IMAGE_DEFAULT="' "$HERE/install.sh" | sed 's/^ *//; s/" *#.*/"/' | sort -u | wc -l | tr -d ' ')" = 1 ] && good "one pinned Kuma image in both places" || bad "KUMA_IMAGE_DEFAULT differs or is missing"
grep -q '^KUMA_IMAGE_DEFAULT=".*:[0-9][0-9.]*-rootless"' "$HERE/install.sh" && good "the image is pinned to an exact version (rootless)" || bad "the Kuma image is not pinned to an exact version"

# ---------------------------------------------------------------- rendering
echo "Rendering:"
render() { label="$1"; shift; bash "$HERE/install.sh" --generate-only -y --admin-email admin@example.com --base-url http://10.0.0.20 --dir "$T/$label" "$@" >"$T/$label.log" 2>&1; }
render plain || bad "plain render failed: $(tail -2 "$T/plain.log")"
[ ! -e "$T/plain/compose.override.yaml" ] && good "no Kuma file unless asked for" || bad "compose.override.yaml written without --with-kuma"
render k1 --with-kuma || bad "--with-kuma render failed: $(tail -2 "$T/k1.log")"
f="$T/k1/compose.override.yaml"
[ -s "$f" ] && good "compose.override.yaml written" || bad "no compose.override.yaml with --with-kuma"
grep -q '"127.0.0.1:3001:3001"' "$f" && good "published on 127.0.0.1 only, port 3001 by default" || bad "port mapping is not 127.0.0.1:3001:3001"
grep -qE '"(0\.0\.0\.0:)?[0-9]+:3001"' "$f" && bad "Kuma is published on every interface" || good "never published on every interface"
for want in 'cap_drop:' '- ALL' '- NET_RAW' 'no-new-privileges:true' 'read_only: true' 'net.ipv4.ping_group_range: "1000 1000"' 'kumadata:/app/data' 'rootless'; do grep -qF -- "$want" "$f" || bad "compose.override.yaml lacks: $want"; done
good "hardening lines present"
grep -q '^# Written by Voxshift' "$f" && good "marked as written by Voxshift (so 'voxshift kuma' never overwrites someone else's file)" || bad "no 'Written by Voxshift' marker"
if command -v ruby >/dev/null 2>&1; then ruby -ryaml -e 'begin; YAML.load_file(ARGV[0], aliases: true); rescue ArgumentError; YAML.load_file(ARGV[0]); end' "$f" 2>/dev/null && good "it parses as YAML" || bad "compose.override.yaml does not parse"; fi
render k2 --with-kuma --kuma-port 3003 && grep -q '"127.0.0.1:3003:3001"' "$T/k2/compose.override.yaml" && good "--kuma-port 3003 is used" || bad "--kuma-port not applied"
refuse() { label="$1"; shift; if bash "$HERE/install.sh" --generate-only -y --admin-email admin@example.com --base-url http://10.0.0.20 --dir "$T/x-$label" "$@" >"$T/x-$label.log" 2>&1; then bad "$label: should have been refused"; else good "$label: refused"; fi; }
refuse port-80      --with-kuma --kuma-port 80
refuse port-text    --with-kuma --kuma-port abc
refuse port-big     --with-kuma --kuma-port 70000
refuse port-alone   --kuma-port 3003
bash "$HERE/install.sh" --help | grep -q -- '--with-kuma' && good "--help describes --with-kuma" || bad "--help lacks --with-kuma"

# ---------------------------------------------------------------- the generated command
echo "The generated command:"
D="$T/k1"
bash -n "$D/voxshift" && good "bash -n" || bad "the generated command has a syntax error"
if [ -n "$SHELLCHECK" ]; then
  if "$SHELLCHECK" -S warning -e SC2010 -s bash "$D/voxshift" >"$T/sc.log" 2>&1; then good "shellcheck (warnings and errors)"; else bad "shellcheck: $(head -20 "$T/sc.log")"; fi
else echo "  (shellcheck not installed - skipped)"; fi

STUB="$T/stub"; mkdir -p "$STUB"
export STUB_LOG="$T/docker.log" STUB_DUMP="$T/fake.dump" STUB_FLAG="$T/kuma-up" STUB_COUNTER="$T/counter"
: > "$STUB_LOG"; printf 'PGDMP fake\n' > "$STUB_DUMP"
cat > "$STUB/docker" <<'STUBEOF'
#!/usr/bin/env bash
echo "docker $*" >> "$STUB_LOG"
if [ "${1:-}" = compose ]; then
  shift
  case "$*" in
    *"up -d kuma"*) [ -z "${STUB_KUMA_FAILS:-}" ] || exit 1; : > "$STUB_FLAG" ;;
    *"rm -sf kuma"*) rm -f "$STUB_FLAG" ;;
    *"ps kuma"*) [ ! -f "$STUB_FLAG" ] || echo "voxshift-kuma-1  louislam/uptime-kuma:2.5.7-rootless  kuma  Up 5 seconds (healthy)  127.0.0.1:3001->3001/tcp" ;;
    *"exec -T postgres pg_dump"*) cat "$STUB_DUMP" ;;
    *"exec -T web wget -q -O - "*) echo '{"version":"2026.10.52"}' ;;
    *"wget -q -O /dev/null -S"*) echo "  HTTP/1.1 401 Unauthorized" >&2 ;;
    *"config --images"*) echo "ghcr.io/example/image:latest" ;;
    *) : ;;
  esac
  exit 0
fi
if [ "${1:-}" = run ]; then
  out=""; prev=""; file=""
  for a in "$@"; do
    case "$prev" in -v) case "$a" in *:/out) out="${a%%:/out*}" ;; esac ;; czf) file="${a#/out/}" ;; esac
    prev="$a"
  done
  [ -z "$out" ] || [ -z "$file" ] || printf 'stub archive %s\n' "$file" | gzip > "$out/$file"
  exit 0
fi
if [ "${1:-}" = image ] && [ "${2:-}" = inspect ]; then echo "sha256:1"; exit 0; fi
exit 0
STUBEOF
printf '#!/bin/sh\n[ "$1" = "-u" ] && echo 0 || /usr/bin/id "$@"\n' > "$STUB/id"
printf '#!/bin/sh\n[ "$1" = "-s" ] && echo Linux || /usr/bin/uname "$@"\n' > "$STUB/uname"
chmod +x "$STUB"/*
BASEPATH="$STUB:/usr/bin:/bin:/usr/sbin:/sbin"
vx() { PATH="$BASEPATH" bash "$D/voxshift" "$@"; }

echo "voxshift kuma on / status / off (on a plain install):"
P="$T/plain"; vp() { PATH="$BASEPATH" bash "$P/voxshift" "$@"; }
vp kuma status 2>&1 | grep -q 'not switched on' && good "status says it is not on" || bad "status on a plain install"
vp kuma on --port 80 >"$T/on0.log" 2>&1 && bad "kuma on accepted port 80" || good "kuma on refuses port 80"
vp kuma on --port 3005 >"$T/on1.log" 2>&1 || bad "kuma on failed: $(tail -3 "$T/on1.log")"
grep -q '"127.0.0.1:3005:3001"' "$P/compose.override.yaml" && good "kuma on wrote the file with the chosen port" || bad "kuma on did not write compose.override.yaml"
grep -q 'docker compose up -d kuma' "$STUB_LOG" && good "kuma on started the container" || bad "kuma on did not start Kuma"
grep -q 'Kuma is healthy' "$T/on1.log" && grep -q 'ssh -L 3005:127.0.0.1:3005' "$T/on1.log" && good "it says what to do next (SSH tunnel on that port)" || bad "no next steps: $(cat "$T/on1.log")"
cmp -s <(sed -n '/^# Written/,$p' "$P/compose.override.yaml") <(sed -n '/^# Written/,$p' "$T/k2/compose.override.yaml" | sed 's/3003:3001/3005:3001/') && good "same text as the installer writes" || bad "kuma on and --with-kuma write different text"
vp kuma status >"$T/st1.log" 2>&1; grep -q 'switched on, healthy' "$T/st1.log" && grep -q '127.0.0.1:3005' "$T/st1.log" && good "status reports it, with the port" || bad "status after on: $(cat "$T/st1.log")"
# someone else's file is never overwritten
printf 'services: {}\n' > "$T/foreign.yaml"; cp "$P/compose.override.yaml" "$T/mine.yaml"; cp "$T/foreign.yaml" "$P/compose.override.yaml"
vp kuma on >"$T/on2.log" 2>&1 && bad "kuma on overwrote a file Voxshift did not write" || { grep -q 'not written by Voxshift' "$T/on2.log" && cmp -s "$P/compose.override.yaml" "$T/foreign.yaml" && good "a foreign compose.override.yaml is left alone" || bad "foreign file handling: $(cat "$T/on2.log")"; }
cp "$T/mine.yaml" "$P/compose.override.yaml"
# a failed start puts things back
export STUB_KUMA_FAILS=1
vp kuma on --port 3006 >"$T/on3.log" 2>&1 && bad "kuma on reported success when the start failed" || { grep -q '3005' "$P/compose.override.yaml" && good "a failed start put the previous file back" || bad "failed start left a changed file"; }
unset STUB_KUMA_FAILS

echo "Backup and restore:"
mkdir -p "$P/backups"
vp backup >"$T/b1.log" 2>&1 || bad "backup with Kuma on failed: $(tail -3 "$T/b1.log")"
b="$(ls -1 "$P/backups" | grep -E '^[0-9]{8}-[0-9]{6}$' | head -n 1)"
for f in kuma-data.tar.gz compose.override.yaml database.dump manifest.txt; do [ -f "$P/backups/$b/$f" ] || bad "backup lacks $f"; done
grep -q 'kuma-data.tar.gz' "$P/backups/$b/manifest.txt" && grep -q 'compose.override.yaml' "$P/backups/$b/manifest.txt" && good "backup holds Kuma's data and settings file, both in the manifest" || bad "manifest lacks the Kuma files"
grep -n 'compose stop kuma\|voxshift_kumadata\|compose start kuma' "$STUB_LOG" | sed 's/^[0-9]*://' | tr '\n' '|' | grep -q 'compose stop kuma|docker run .*voxshift_kumadata.*|docker compose start kuma' && good "Kuma was stopped only while its data was copied, then started again" || bad "Kuma stop/copy/start order: $(grep -E 'stop kuma|kumadata|start kuma' "$STUB_LOG")"
: > "$STUB_LOG"; sleep 1
vp restore "$P/backups/$b" --yes >"$T/r1.log" 2>&1 || bad "restore with Kuma data failed: $(tail -5 "$T/r1.log")"
grep -q "Kuma's data" "$T/r1.log" && good "restore says it replaces Kuma's data" || bad "restore does not mention Kuma"
grep -q 'voxshift_kumadata:/data -v .*:/in:ro alpine sh -ec .*kuma-data.tar.gz' "$STUB_LOG" && good "restore put the data back into the Kuma volume" || bad "restore did not restore Kuma's data: $(grep -c . "$STUB_LOG") calls"
# a host with Kuma off makes backups without Kuma
vp kuma off >"$T/off1.log" 2>&1 || bad "kuma off failed"
[ ! -e "$P/compose.override.yaml" ] && grep -q 'rm -sf kuma' "$STUB_LOG" && good "kuma off removed the file and the container" || bad "kuma off left things behind"
grep -q 'voxshift_kumadata' "$T/off1.log" && good "kuma off says where the data stays" || bad "kuma off does not mention the data"
sleep 1; vp backup >"$T/b2.log" 2>&1 || bad "backup after kuma off failed"
b2="$(ls -1 "$P/backups" | grep -E '^[0-9]{8}-[0-9]{6}$' | tail -n 1)"
[ ! -e "$P/backups/$b2/kuma-data.tar.gz" ] && [ ! -e "$P/backups/$b2/compose.override.yaml" ] && good "no Kuma files in a backup when Kuma is off" || bad "Kuma files in a backup of a host without Kuma"
vp kuma off --delete-data >"$T/off2.log" 2>&1; vp kuma on >/dev/null 2>&1; vp kuma off --delete-data >"$T/off3.log" 2>&1
grep -q 'docker volume rm voxshift_kumadata' "$STUB_LOG" && good "--delete-data removes the volume" || bad "--delete-data did not remove the volume"

[ "$fail" = 0 ] && echo "device status (Kuma) installer checks: all passed"
exit "$fail"
