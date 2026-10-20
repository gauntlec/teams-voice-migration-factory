#!/usr/bin/env bash
# Renders the installer's files for a set of addresses (--generate-only: nothing is installed or started, no root or Docker needed)
# and checks what matters about the result: which TLS mode "auto" chooses, the Strict-Transport-Security line (https modes only),
# that the Caddyfile braces balance and that compose.yaml parses. Run:  bash deploy/install/check-render.sh
# Not a substitute for 'caddy validate' / 'docker compose config' on a real host.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
bad() { echo "FAIL: $*"; fail=1; }

# render <label> <expected-mode> <expect-hsts yes|no> <installer args...>
render() {
  label="$1"; mode="$2"; hsts="$3"; shift 3
  d="$TMP/$label"
  if ! bash "$HERE/install.sh" --generate-only -y --admin-email admin@example.com --dir "$d" "$@" >"$TMP/$label.log" 2>&1; then bad "$label: installer stopped: $(tail -1 "$TMP/$label.log")"; return; fi
  got="$(sed -n 's/.*secured: \([a-z]*\)).*/\1/p' "$TMP/$label.log" | head -1)"
  [ "$got" = "$mode" ] || bad "$label: expected TLS mode $mode, got '$got'"
  cf="$d/Caddyfile"
  [ "$(tr -cd '{' <"$cf" | wc -c)" = "$(tr -cd '}' <"$cf" | wc -c)" ] || bad "$label: Caddyfile braces do not balance"
  n="$(grep -c 'Strict-Transport-Security' "$cf")"
  if [ "$hsts" = yes ]; then [ "$n" = 1 ] || bad "$label: expected exactly one HSTS line, found $n"; else [ "$n" = 0 ] || bad "$label: HSTS must not be sent here"; fi
  if [ "$mode" = acme ]; then grep -q 'tls internal' "$cf" && bad "$label: acme must not use the internal CA"; fi
  if [ "$mode" = internal ]; then grep -q '^	tls internal$' "$cf" || bad "$label: internal mode lacks 'tls internal'"; fi
  [ "$mode" != none ] || grep -q 'auto_https off' "$cf" || bad "$label: none mode must switch automatic https off"
  if [ "$mode" = selfsigned ]; then grep -q "^$(printf '\t')tls /certs/server.crt /certs/server.key$" "$cf" || bad "$label: selfsigned mode lacks the certificate files"; [ -s "$d/certs/server.crt" ] && [ -s "$d/certs/server.key" ] || bad "$label: no certificate was made"; fi
  if command -v ruby >/dev/null 2>&1; then ruby -ryaml -e 'begin; YAML.load_file(ARGV[0], aliases: true); rescue ArgumentError; YAML.load_file(ARGV[0]); end' "$d/compose.yaml" 2>/dev/null || bad "$label: compose.yaml does not parse"; fi
}

render public-name      acme     yes --base-url https://voice.contoso.com
render uppercase-corp   internal yes --base-url https://Voice.Contoso.CORP
render corp             internal yes --base-url https://voice.contoso.corp
render home-arpa        internal yes --base-url https://voice.contoso.home.arpa
render local            internal yes --base-url https://voice.contoso.local
render bare-name        internal yes --base-url https://voice
render ip               internal yes --base-url https://10.1.2.3
render cgnat-ip         internal yes --base-url https://100.100.5.5
render http             none     no  --base-url http://voice.contoso.com
render http-port        none     no  --base-url http://10.0.0.20:8080
render acme-forced      acme     yes --base-url https://voice.contoso.com --tls acme --acme-email ops@contoso.com
render internal-forced  internal yes --base-url https://voice.contoso.com --tls internal
render hsts-off         acme     no  --base-url https://voice.contoso.com --hsts-max-age 0
render hsts-custom      acme     yes --base-url https://voice.contoso.com --hsts-max-age 300
render selfsigned-name  selfsigned yes --base-url https://voice.contoso.corp --tls selfsigned
render selfsigned-ip    selfsigned yes --base-url https://10.1.2.3 --tls selfsigned --selfsigned-days 730

# These must be refused with a message, not rendered.
refuse() { label="$1"; shift; if bash "$HERE/install.sh" --generate-only -y --admin-email admin@example.com --dir "$TMP/x-$label" "$@" >"$TMP/x-$label.log" 2>&1; then bad "$label: should have been refused"; fi; }
refuse acme-for-corp    --base-url https://voice.contoso.corp --tls acme
refuse acme-for-ip      --base-url https://10.1.2.3 --tls acme
refuse tls-on-http      --base-url http://voice.contoso.com --tls internal
refuse selfsigned-http  --base-url http://voice.contoso.com --tls selfsigned

[ "$fail" = 0 ] && echo "installer render checks: all passed"
exit "$fail"
