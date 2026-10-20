#!/usr/bin/env bash
# Exercises the installer's self-signed mode and the `voxshift certificate` command (status, selfsigned, install, export) without Docker or root:
# the installer writes the files (--generate-only), then the generated command is run against a STUB docker and a stub `id` (so it believes it is
# root). openssl is the REAL program, so the certificates, the key checks and the name checks are real. Run:  bash deploy/install/check-certificate.sh
# Not a substitute for installing a certificate on a real host and opening the address in a browser.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
command -v openssl >/dev/null 2>&1 || { echo "SKIPPED: openssl is needed for this check."; exit 0; }
SHELLCHECK="$(command -v shellcheck || true)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail=0
bad() { echo "FAIL: $*"; fail=1; }
good() { echo "  ok: $*"; }

# ---------------------------------------------------------------- stubs
STUB="$T/stub"; mkdir -p "$STUB"
export STUB_LOG="$T/docker.log"; : > "$STUB_LOG"
cat > "$STUB/docker" <<'EOF'
#!/usr/bin/env bash
echo "docker $*" >> "$STUB_LOG"
[ "${1:-}" = compose ] || exit 0
shift
case "$*" in
  *"ps --services --filter status=running"*) [ -n "${STUB_CADDY_DOWN:-}" ] || echo caddy ;;
  *"cp caddy:/data/caddy/pki/authorities/local/root.crt "*) printf -- '-----BEGIN CERTIFICATE-----\nSTUB ROOT\n-----END CERTIFICATE-----\n' > "${!#}" ;;
  *"logs --tail"*) echo "stub caddy log line" ;;
  *) : ;;
esac
exit 0
EOF
printf '#!/bin/sh\n[ "$1" = "-u" ] && echo 0 || /usr/bin/id "$@"\n' > "$STUB/id"
printf '#!/bin/sh\n[ "$1" = "-s" ] && echo Linux || /usr/bin/uname "$@"\n' > "$STUB/uname"
chmod +x "$STUB"/*
BASEPATH="$STUB:/usr/bin:/bin:/usr/sbin:/sbin:$(dirname "$(command -v openssl)")"
export CERT_WAIT=0

# render <name> <installer args...>: a fresh install directory $T/<name>
render() { n="$1"; shift; bash "$HERE/install.sh" --generate-only -y --admin-email admin@example.com --dir "$T/$n" "$@" >"$T/$n.log" 2>&1 || { bad "$n: installer stopped: $(tail -1 "$T/$n.log")"; return 1; }; }
vx() { d="$1"; shift; PATH="$BASEPATH" bash "$d/voxshift" "$@"; }
count() { grep -c "$1" "$2" 2>/dev/null || true; }
san_of() { openssl x509 -in "$1" -noout -text | awk '/Subject Alternative Name/ {getline; gsub(/^ +/,""); print}'; }

echo "Installer: --tls selfsigned"
render ss1 --base-url https://voice.contoso.corp --tls selfsigned --selfsigned-days 400 || exit 1
C="$T/ss1/certs/server.crt"; K="$T/ss1/certs/server.key"
[ -s "$C" ] && [ -s "$K" ] && good "certificate and key written" || bad "certificate or key missing"
[ "$(san_of "$C")" = "DNS:voice.contoso.corp" ] && good "valid for the name (DNS:voice.contoso.corp)" || bad "wrong names: $(san_of "$C")"
openssl x509 -in "$C" -noout -text | grep -q "TLS Web Server Authentication" && good "server-authentication use" || bad "missing server-authentication use"
openssl x509 -in "$C" -noout -text | grep -q "CA:FALSE" && good "not a certificate authority" || bad "must not be a CA"
openssl x509 -in "$C" -noout -checkend $((399*86400)) >/dev/null && openssl x509 -in "$C" -noout -checkend $((402*86400)) >/dev/null 2>&1 && bad "lasts longer than 400 days" || good "lasts about the 400 days asked for"
[ "$(openssl x509 -in "$C" -noout -pubkey | openssl sha256)" = "$(openssl pkey -in "$K" -pubout | openssl sha256)" ] && good "key matches the certificate" || bad "key does not match"
[ "$(stat -c %a "$K" 2>/dev/null || stat -f %Lp "$K")" = 600 ] && good "key is mode 600" || bad "key must be mode 600"
grep -q '^	tls /certs/server.crt /certs/server.key$' "$T/ss1/Caddyfile" && [ "$(count 'Strict-Transport-Security' "$T/ss1/Caddyfile")" = 1 ] && good "Caddyfile uses the files and sends HSTS once" || bad "Caddyfile wrong"
[ "$(count './certs:/certs:ro' "$T/ss1/compose.yaml")" = 1 ] && good "compose mounts the certificate folder once" || bad "compose mount wrong"
render ssip --base-url https://10.1.2.3 --tls selfsigned && [ "$(san_of "$T/ssip/certs/server.crt")" = "IP Address:10.1.2.3" ] && good "an IP address gets an IP entry" || bad "IP certificate wrong"
refuse() { l="$1"; shift; if bash "$HERE/install.sh" --generate-only -y --admin-email admin@example.com --dir "$T/x-$l" "$@" >"$T/x-$l.log" 2>&1; then bad "$l should have been refused"; else good "refused: $l"; fi; }
refuse with-cert  --base-url https://voice.contoso.corp --tls selfsigned --cert "$C" --key "$K"
refuse bad-days   --base-url https://voice.contoso.corp --tls selfsigned --selfsigned-days 10
refuse huge-days  --base-url https://voice.contoso.corp --tls selfsigned --selfsigned-days 5000
refuse text-days  --base-url https://voice.contoso.corp --tls selfsigned --selfsigned-days soon
refuse http-addr  --base-url http://voice.contoso.corp --tls selfsigned

echo "The generated command:"
bash -n "$T/ss1/voxshift" && good "bash -n" || bad "syntax error in the generated command"
if [ -n "$SHELLCHECK" ]; then
  "$SHELLCHECK" -S warning -e SC2010 "$HERE/install.sh" >"$T/sc.log" 2>&1 && good "shellcheck (installer)" || { bad "shellcheck found problems"; head -12 "$T/sc.log"; }
  "$SHELLCHECK" -S warning -e SC2010 "$T/ss1/voxshift" >"$T/sc2.log" 2>&1 && good "shellcheck (generated command)" || { bad "shellcheck found problems in the generated command"; head -12 "$T/sc2.log"; }
fi

echo "The two copies of the certificate maker agree:"
render ssp --base-url https://voice.contoso.corp --tls internal
mkdir -p "$T/maker"; vx "$T/ssp" certificate selfsigned --days 400 >/dev/null 2>&1
norm() { openssl x509 -in "$1" -noout -text | grep -E "Subject:|DNS:|IP Address:|CA:FALSE|Digital Signature|TLS Web Server|Signature Algorithm|Public-Key" | sed 's/^ *//' | sort; }
[ "$(norm "$T/ss1/certs/server.crt")" = "$(norm "$T/ssp/certs/server.crt")" ] && good "installer and command make the same kind of certificate" || bad "the two certificate makers differ"

echo "voxshift certificate:"
# internal -> self-signed
render a1 --base-url https://voice.contoso.corp --tls internal
vx "$T/a1" certificate status 2>&1 | grep -q "own certificate authority" && good "status: internal mode named" || bad "status for internal"
cp "$T/a1/Caddyfile" "$T/a1.Caddyfile.orig"
vx "$T/a1" certificate selfsigned >"$T/a1.out" 2>&1 && good "selfsigned from internal mode succeeds" || { bad "selfsigned failed: $(tail -2 "$T/a1.out")"; }
[ "$(count '^	tls ' "$T/a1/Caddyfile")" = 1 ] && grep -q '^	tls /certs/server.crt /certs/server.key$' "$T/a1/Caddyfile" && ! grep -q 'tls internal' "$T/a1/Caddyfile" && good "Caddyfile now uses the files (one tls line, no tls internal)" || bad "Caddyfile after selfsigned: $(cat "$T/a1/Caddyfile")"
[ "$(count 'Strict-Transport-Security' "$T/a1/Caddyfile")" = 1 ] && good "HSTS line kept exactly once" || bad "HSTS line lost or duplicated"
[ "$(count './certs:/certs:ro' "$T/a1/compose.yaml")" = 1 ] && good "compose mount added once" || bad "compose mount missing or duplicated"
grep -q "docker compose up -d caddy" "$STUB_LOG" && good "Caddy was restarted" || bad "Caddy was not restarted"
vx "$T/a1" certificate selfsigned --days 90 >"$T/a1b.out" 2>&1 && [ "$(count './certs:/certs:ro' "$T/a1/compose.yaml")" = 1 ] && [ "$(count '^	tls ' "$T/a1/Caddyfile")" = 1 ] && good "running it again (a renewal) changes nothing else" || bad "renewal duplicated settings"
vx "$T/a1" certificate status 2>&1 | grep -q "self-signed" && good "status reports a self-signed certificate" || bad "status should say self-signed"
vx "$T/a1" certificate selfsigned --days 5 >/dev/null 2>&1 && bad "--days 5 should be refused" || good "--days out of range refused"

# acme (with an e-mail in a global block) -> self-signed keeps the global block
render a2 --base-url https://voice.contoso.com --tls acme --acme-email ops@contoso.com
vx "$T/a2" certificate selfsigned --name voice.contoso.com >/dev/null 2>&1 && grep -q 'email ops@contoso.com' "$T/a2/Caddyfile" && grep -q '^	tls /certs/' "$T/a2/Caddyfile" && good "acme install switched; the global block is kept" || bad "acme switch failed: $(cat "$T/a2/Caddyfile")"

# a certificate from a certificate authority: a throwaway CA and server certificates
CA="$T/ca"; mkdir -p "$CA"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$CA/ca.key" -out "$CA/ca.crt" -days 30 -subj "/CN=Test CA" >/dev/null 2>&1
mkleaf() { # name sans days outprefix
  printf '[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=%s\n[v3]\nsubjectAltName=%s\nextendedKeyUsage=serverAuth\n' "$1" "$2" > "$CA/leaf.cnf"
  openssl req -new -newkey rsa:2048 -nodes -keyout "$4.key" -out "$4.csr" -config "$CA/leaf.cnf" >/dev/null 2>&1
  openssl x509 -req -in "$4.csr" -CA "$CA/ca.crt" -CAkey "$CA/ca.key" -CAcreateserial -days "$3" -out "$4.crt" -extfile "$CA/leaf.cnf" -extensions v3 >/dev/null 2>&1
}
mkleaf voice.contoso.corp "DNS:voice.contoso.corp" 10 "$CA/good"; cat "$CA/good.crt" "$CA/ca.crt" > "$CA/good-full.pem"
mkleaf other.contoso.corp "DNS:other.contoso.corp" 10 "$CA/other"
mkleaf wild "DNS:*.contoso.corp" 10 "$CA/wild"
mkleaf voice.contoso.corp "DNS:voice.contoso.corp" 10 "$CA/second"

render b1 --base-url https://voice.contoso.corp --tls internal
cp "$T/b1/Caddyfile" "$T/b1.orig"; cp "$T/b1/compose.yaml" "$T/b1.compose.orig"
vx "$T/b1" certificate install --cert "$CA/good-full.pem" --key "$CA/good.key" >"$T/b1.out" 2>&1 && good "a CA-issued certificate is installed" || bad "install failed: $(tail -3 "$T/b1.out")"
grep -q '^	tls /certs/server.crt' "$T/b1/Caddyfile" && [ "$(grep -c 'BEGIN CERTIFICATE' "$T/b1/certs/server.crt")" = 2 ] && good "the chain was kept (2 certificates in the file)" || bad "chain not kept"
vx "$T/b1" certificate status 2>&1 | grep -q "status: valid for more than 30 days\|expires within 30 days" && good "status reads the installed certificate" || bad "status for the installed certificate"
vx "$T/b1" certificate status 2>&1 | grep -q "expires within 30 days" && good "a certificate close to expiry is flagged" || bad "short certificate not flagged (10 days)"

before="$(cat "$T/b1/Caddyfile")"
vx "$T/b1" certificate install --cert "$CA/good.crt" --key "$CA/other.key" >"$T/b1x.out" 2>&1 && bad "a key that does not match must be refused" || good "refused: key does not match the certificate"
[ "$(cat "$T/b1/Caddyfile")" = "$before" ] && good "nothing changed after the refusal" || bad "files changed after a refusal"
vx "$T/b1" certificate install --cert "$CA/other.crt" --key "$CA/other.key" >"$T/b1y.out" 2>&1 && bad "a certificate for another name must be refused" || { grep -q "not valid for voice.contoso.corp" "$T/b1y.out" && good "refused: certificate is for another name (and the message says which)"; }
vx "$T/b1" certificate install --cert "$CA/other.crt" --key "$CA/other.key" --force >/dev/null 2>&1 && good "--force installs it anyway" || bad "--force should allow the other name"
vx "$T/b1" certificate install --cert "$CA/wild.crt" --key "$CA/wild.key" >/dev/null 2>&1 && good "a wildcard certificate (*.contoso.corp) covers voice.contoso.corp" || bad "wildcard should be accepted"
printf 'not a certificate\n' > "$T/junk.pem"
vx "$T/b1" certificate install --cert "$T/junk.pem" --key "$CA/good.key" >/dev/null 2>&1 && bad "a junk file must be refused" || good "refused: not a certificate"
vx "$T/b1" certificate install --cert "$CA/good.crt" >/dev/null 2>&1 && bad "missing --key must be refused" || good "refused: --key missing"

# a failing front door puts everything back
render c1 --base-url https://voice.contoso.corp --tls internal
cp "$T/c1/Caddyfile" "$T/c1.Caddyfile.orig"; cp "$T/c1/compose.yaml" "$T/c1.compose.orig"
STUB_CADDY_DOWN=1 vx "$T/c1" certificate install --cert "$CA/good-full.pem" --key "$CA/good.key" >"$T/c1.out" 2>&1 && bad "should fail when Caddy does not start" || good "reported failure when Caddy did not stay up"
cmp -s "$T/c1/Caddyfile" "$T/c1.Caddyfile.orig" && cmp -s "$T/c1/compose.yaml" "$T/c1.compose.orig" && [ ! -e "$T/c1/certs/server.crt" ] && good "Caddyfile, compose.yaml and certs put back exactly as before" || bad "rollback incomplete"
grep -q "Putting the old settings back" "$T/c1.out" && good "the message says the old settings were put back" || bad "no rollback message"

# plain http installs have no certificate
render n1 --base-url http://10.0.0.20 --tls none
vx "$T/n1" certificate selfsigned >/dev/null 2>&1 && bad "plain http must refuse selfsigned" || good "refused on a plain-http install"
vx "$T/n1" certificate export >/dev/null 2>&1 && bad "plain http has nothing to export" || good "export refused on a plain-http install"

# export
( cd "$T" && PATH="$BASEPATH" bash "$T/a1/voxshift" certificate export ) >"$T/exp1.out" 2>&1 && [ -s "$T/voxshift-certificate.crt" ] && cmp -s "$T/voxshift-certificate.crt" "$T/a1/certs/server.crt" && good "export saves the certificate in the folder you ran it from" || bad "export to the current folder"
vx "$T/a1" certificate export "$T/chosen.crt" >/dev/null 2>&1 && cmp -s "$T/chosen.crt" "$T/a1/certs/server.crt" && good "export to a chosen file" || bad "export to a chosen file"
render e1 --base-url https://voice.contoso.corp --tls internal
vx "$T/e1" certificate export "$T/root.crt" >/dev/null 2>&1 && grep -q "STUB ROOT" "$T/root.crt" && good "internal mode exports Voxshift's root certificate" || bad "internal export"
render e2 --base-url https://voice.contoso.com --tls acme
vx "$T/e2" certificate export "$T/none.crt" 2>&1 | grep -q "nothing to install" && [ ! -e "$T/none.crt" ] && good "a public certificate says there is nothing to install" || bad "acme export"

[ "$fail" = 0 ] && echo "certificate checks: all passed"
exit "$fail"
