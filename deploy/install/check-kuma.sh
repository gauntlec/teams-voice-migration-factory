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
for fn in kuma_override kuma_caddy_block; do
  rm -f "$T"/block*.txt
  blocks="$(awk '/^'"$fn"'\(\) \{/{f=1; n++} f{print > ("'"$T"'/block" n ".txt")} /^\}/{f=0}' "$HERE/install.sh"; ls "$T"/block*.txt 2>/dev/null | wc -l | tr -d ' ')"
  [ "$blocks" = 2 ] && good "two $fn functions found" || bad "expected 2 $fn functions in install.sh, found $blocks"
  cmp -s "$T/block1.txt" "$T/block2.txt" && good "$fn is identical in both" || bad "$fn differs between the installer and the generated command"
done
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
for want in 'cap_drop:' '- ALL' '- NET_RAW' 'no-new-privileges:true' 'read_only: true' 'net.ipv4.ping_group_range: "1000 1000"' 'kumadata:/app/data' 'rootless' 'UPTIME_KUMA_DB_TYPE: sqlite'; do grep -qF -- "$want" "$f" || bad "compose.override.yaml lacks: $want"; done
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


# ---------------------------------------------------------------- Kuma's screen through the web front door
echo "Serving Kuma's screen through the web front door (--kuma-web):"
caddy_ok() { [ "$(tr -cd '{' <"$1" | wc -c)" = "$(tr -cd '}' <"$1" | wc -c)" ]; }
renderw() { label="$1"; shift; bash "$HERE/install.sh" --generate-only -y --admin-email admin@example.com --dir "$T/$label" --with-kuma "$@" >"$T/$label.log" 2>&1; }
renderw w-acme --base-url https://voice.contoso.com --kuma-web || bad "acme + --kuma-web failed: $(tail -2 "$T/w-acme.log")"
grep -q '^voice.contoso.com:8443 {' "$T/w-acme/Caddyfile" && grep -q 'reverse_proxy kuma:3001' "$T/w-acme/Caddyfile" && good "acme: a Caddyfile block for voice.contoso.com:8443 proxies to Kuma" || bad "acme: no Kuma block in the Caddyfile"
awk '/^voice.contoso.com:8443 \{/,/^\}/' "$T/w-acme/Caddyfile" | grep -q 'tls' && bad "acme: the Kuma block must not set its own tls (Caddy gets the certificate by itself)" || good "acme: the Kuma block leaves the certificate to Caddy"
caddy_ok "$T/w-acme/Caddyfile" && good "acme: Caddyfile braces balance" || bad "acme: Caddyfile braces do not balance"
grep -q '^# BEGIN voxshift kuma' "$T/w-acme/Caddyfile" && grep -q '^# END voxshift kuma' "$T/w-acme/Caddyfile" && good "the block is marked so it can be found and removed" || bad "no BEGIN/END markers"
grep -q 'caddy:' "$T/w-acme/compose.override.yaml" && grep -q '"8443:8443"' "$T/w-acme/compose.override.yaml" && good "the override publishes 8443 on the front door" || bad "the override lacks the caddy port"
grep -q '"127.0.0.1:3001:3001"' "$T/w-acme/compose.override.yaml" && good "Kuma's own port is still host-only" || bad "Kuma's own port changed"
if command -v ruby >/dev/null 2>&1; then ruby -ryaml -e 'begin; d=YAML.load_file(ARGV[0], aliases: true); rescue ArgumentError; d=YAML.load_file(ARGV[0]); end; exit(d["services"]["caddy"]["ports"] == ["8443:8443"] ? 0 : 1)' "$T/w-acme/compose.override.yaml" && good "the override parses and adds the caddy port" || bad "override with a web port does not parse as expected"; fi
renderw w-int --base-url https://10.1.2.3 --kuma-web-port 9443 || bad "internal render failed"
awk '/^10.1.2.3:9443 \{/,/^\}/' "$T/w-int/Caddyfile" | grep -q '^	tls internal$' && good "internal: the Kuma block uses the private CA too" || bad "internal: Kuma block lacks tls internal"
renderw w-self --base-url https://voice.contoso.corp --tls selfsigned --kuma-web || bad "selfsigned render failed"
awk '/^voice.contoso.corp:8443 \{/,/^\}/' "$T/w-self/Caddyfile" | grep -q '^	tls /certs/server.crt /certs/server.key$' && good "self-signed: the Kuma block uses the same certificate files" || bad "self-signed: Kuma block lacks the certificate"
renderw w-none --base-url http://10.0.0.20 --kuma-web || bad "http render failed"
grep -q '^:8443 {' "$T/w-none/Caddyfile" && caddy_ok "$T/w-none/Caddyfile" && good "http: a plain :8443 block" || bad "http: no :8443 block"
refuse web-without-kuma --kuma-web
refuse web-port-80      --with-kuma --kuma-web-port 80
refuse web-port-clash   --with-kuma --kuma-port 3003 --kuma-web-port 3003
refuse web-port-text    --with-kuma --kuma-web-port x
render w-none2 --with-kuma && ! grep -q 'voxshift kuma' "$T/w-none2/Caddyfile" && good "no Kuma block without --kuma-web" || bad "Kuma block written without --kuma-web"

# ---------------------------------------------------------------- the generated command
echo "The generated command:"
D="$T/k1"
bash -n "$D/voxshift" && good "bash -n" || bad "the generated command has a syntax error"
if [ -n "$SHELLCHECK" ]; then
  if "$SHELLCHECK" -S warning -e SC2010,SC2120 -s bash "$D/voxshift" >"$T/sc.log" 2>&1; then good "shellcheck (warnings and errors)"; else bad "shellcheck: $(head -20 "$T/sc.log")"; fi
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
    *"ps --services --filter status=running"*) echo caddy ;;
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
grep -q 'Kuma is healthy' "$T/on1.log" && grep -q 'ssh -L 3005:127.0.0.1:3005' "$T/on1.log" && grep -q 'Set up automatically' "$T/on1.log" && good "it says what to do next (SSH tunnel on that port)" || bad "no next steps: $(cat "$T/on1.log")"
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


echo "voxshift kuma on --web / --no-web (http install, then https):"
P="$T/plain"; vp() { PATH="$BASEPATH" bash "$P/voxshift" "$@"; }
vp kuma on --port 3007 --web >"$T/w1.log" 2>&1 || bad "kuma on --web failed: $(tail -3 "$T/w1.log")"
grep -q '^:8443 {' "$P/Caddyfile" && grep -q '"8443:8443"' "$P/compose.override.yaml" && good "--web: Caddyfile block and front-door port added (default 8443)" || bad "--web did not add the block and port"
grep -q 'docker compose up -d kuma caddy' "$STUB_LOG" && good "--web: the front door is recreated to publish the port" || bad "--web did not recreate caddy"
grep -q 'firewall' "$T/w1.log" && grep -q 'Open port 8443' "$T/w1.log" && good "--web: tells you to open the port (it never touches the firewall)" || bad "--web: no firewall note"
vp kuma status 2>&1 | grep -q 'Screen:.*:8443' && good "status shows the web address" || bad "status does not show the web address"
vp kuma on >"$T/w2.log" 2>&1 || bad "kuma on (again) failed"
grep -q '"127.0.0.1:3007:3001"' "$P/compose.override.yaml" && grep -q '"8443:8443"' "$P/compose.override.yaml" && good "running 'kuma on' again keeps the port and the web setting" || bad "a second 'kuma on' lost a setting"
[ "$(grep -c '^# BEGIN voxshift kuma' "$P/Caddyfile")" = 1 ] && good "... and the block is not duplicated" || bad "the Caddyfile block was duplicated"
vp kuma on --web 9443 >/dev/null 2>&1; grep -q '^:9443 {' "$P/Caddyfile" && ! grep -q '^:8443 {' "$P/Caddyfile" && good "changing the web port replaces the block" || bad "web port change left the old block"
vp kuma on --no-web >/dev/null 2>&1; ! grep -q 'voxshift kuma' "$P/Caddyfile" && ! grep -q '"9443:9443"' "$P/compose.override.yaml" && good "--no-web removes the block and the port" || bad "--no-web left something behind"
vp kuma on --web 3007 >"$T/w3.log" 2>&1 && bad "the web port was allowed to equal Kuma's own port" || good "refuses a web port equal to Kuma's own"
vp kuma on --web 8443 >/dev/null 2>&1
vp backup >/dev/null 2>&1 || bad "backup with the web setting failed"
vp kuma off >/dev/null 2>&1; ! grep -q 'voxshift kuma' "$P/Caddyfile" && good "kuma off takes the block out of the Caddyfile" || bad "kuma off left the Caddyfile block"
# restore puts the override back and the Caddyfile follows it
sleep 1; bk="$(ls -1 "$P/backups" | grep -E '^[0-9]{8}-[0-9]{6}$' | tail -n 1)"
vp restore "$P/backups/$bk" --yes >"$T/w4.log" 2>&1 || bad "restore failed: $(tail -3 "$T/w4.log")"
grep -q '^:8443 {' "$P/Caddyfile" && good "restore brings the Caddyfile block back with the override" || bad "restore left the Caddyfile without the Kuma block"
vp kuma off >/dev/null 2>&1

H="$T/w-acme"; vh() { CERT_WAIT=0 PATH="$BASEPATH" bash "$H/voxshift" "$@"; }
vh certificate selfsigned --name voice.contoso.com >"$T/c1.log" 2>&1 || bad "certificate selfsigned failed: $(tail -3 "$T/c1.log")"
awk '/^voice.contoso.com:8443 \{/,/^\}/' "$H/Caddyfile" | grep -q '^	tls /certs/server.crt /certs/server.key$' && awk '/^voice.contoso.com \{/,/^\}/' "$H/Caddyfile" | grep -q '^	tls /certs/server.crt' && good "a certificate change reaches the Kuma block too" || bad "the Kuma block kept the old certificate setting after 'certificate selfsigned'"
vh kuma on --no-web >/dev/null 2>&1; vh kuma on --web >/dev/null 2>&1
awk '/^voice.contoso.com:8443 \{/,/^\}/' "$H/Caddyfile" | grep -q '^	tls /certs/server.crt /certs/server.key$' && good "turning --web on later follows the current certificate mode" || bad "a later --web did not follow the certificate mode"

[ "$fail" = 0 ] && echo "device status (Kuma) installer checks: all passed"
exit "$fail"
