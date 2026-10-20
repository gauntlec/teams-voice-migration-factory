#!/usr/bin/env bash
# Exercises `voxshift self-update` (the checks on the installer it downloads) without the network: the installer renders the command
# (--generate-only), then the command runs against a STUB curl (serves files from a folder that stands in for the latest GitHub release)
# and a stub cosign. The "installer" it downloads is a stand-in that only records how it was started. Run:  bash deploy/install/check-selfupdate.sh
# Not a substitute for a real self-update against a real release (real signature verification needs a published, signed release).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail=0
bad() { echo "FAIL: $*"; fail=1; }
good() { echo "  ok: $*"; }

STUB="$T/stub"; mkdir -p "$STUB" "$T/tmp"
export TMPDIR="$T/tmp" REL="$T/release" OLD="$T/old-install.sh" RAN="$T/ran.txt" COSIGN_LOG="$T/cosign.txt"
cat > "$STUB/curl" <<'EOF'
#!/usr/bin/env bash
# Serves $REL/<file> for .../releases/latest/download/<file>, $OLD for the raw.githubusercontent.com URL.
out=""; url=""; want_code=0
while [ $# -gt 0 ]; do
  case "$1" in -o) out="$2"; shift 2 ;; -w) want_code=1; shift 2 ;; --max-time) shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac
done
code=000; src=""
if [ -n "${NET_DOWN:-}" ]; then code=000
else
  case "$url" in
    */releases/latest/download/*) f="$REL/${url##*/}"; if [ -n "${FORCE_CODE:-}" ] && [ "${url##*/}" = "${FORCE_FILE:-}" ]; then code="$FORCE_CODE"; elif [ -f "$f" ]; then code=200; src="$f"; else code=404; fi ;;
    https://raw.githubusercontent.com/*) if [ -f "$OLD" ]; then code=200; src="$OLD"; else code=404; fi ;;
  esac
fi
[ "$code" != 200 ] || cp "$src" "$out"
[ "$want_code" = 0 ] || printf '%s' "$code"
[ "$code" = 200 ] || [ "$want_code" = 1 ]
EOF
cat > "$STUB/cosign" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$COSIGN_LOG"
[ -z "${COSIGN_FAIL:-}" ] || { echo "Error: none of the expected identities matched" >&2; exit 1; }
EOF
chmod +x "$STUB"/*
mv "$STUB/cosign" "$T/cosign-stub"   # only on the PATH in the scenarios that want it
printf '#!/bin/sh\n[ "$1" = "-u" ] && echo 0 || /usr/bin/id "$@"\n' > "$STUB/id"; chmod +x "$STUB/id"

D="$T/vx"
bash "$HERE/install.sh" --generate-only -y --admin-email admin@example.com --dir "$D" --base-url http://10.0.0.20 >"$T/render.log" 2>&1 || { echo "FAIL: installer did not render"; exit 1; }
SIGNER="https://github.com/gauntlec/teams-voice-migration-factory/.github/workflows/build-images.yml@refs/heads/main"

sum() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

# A fresh "release": a stand-in installer that records its arguments, its SHA256SUMS and (optionally) a signature bundle.
new_release() {
  rm -rf "$REL" "$OLD" "$RAN" "$COSIGN_LOG"; mkdir -p "$REL"
  printf '#!/usr/bin/env bash\necho "$@" > "%s"\n' "$RAN" > "$REL/install.sh"
  printf '#!/usr/bin/env bash\necho uninstall\n' > "$REL/uninstall.sh"
  ( cd "$REL" && printf '%s  install.sh\n%s  uninstall.sh\n' "$(sum install.sh)" "$(sum uninstall.sh)" > SHA256SUMS )
  echo '{"stub":"bundle"}' > "$REL/SHA256SUMS.sigstore.json"
}
# run_self_update [with-cosign] [args...]: output in $T/out.txt, exit code in $rc
run_su() {
  local p="$STUB:/usr/bin:/bin:/usr/sbin:/sbin"
  if [ "${1:-}" = with-cosign ]; then cp "$T/cosign-stub" "$STUB/cosign"; shift; else rm -f "$STUB/cosign"; fi
  rc=0; PATH="$p" bash "$D/voxshift" self-update "$@" >"$T/out.txt" 2>&1 || rc=$?
  rm -f "$STUB/cosign"
}
installer_ran() { [ -s "$RAN" ]; }
no_leftovers() { [ -z "$(ls -A "$TMPDIR")" ]; }

echo "The generated command:"
bash -n "$D/voxshift" && good "bash -n" || bad "syntax error in the generated command"

echo "A release with checksums, cosign not installed:"
new_release; run_su
[ "$rc" = 0 ] && installer_ran && good "the installer ran" || bad "installer did not run (exit $rc): $(cat "$T/out.txt")"
grep -q -- "--refresh-command --dir $D" "$RAN" && good "it was started with --refresh-command --dir" || bad "wrong arguments: $(cat "$RAN" 2>/dev/null)"
grep -q 'matches the checksum' "$T/out.txt" && good "says the checksum was checked" || bad "no checksum message"
grep -q 'cosign is not installed' "$T/out.txt" && good "one-line notice that the signature was not checked" || bad "no cosign notice"
no_leftovers && good "no temporary files left" || bad "temporary files left: $(ls -A "$TMPDIR")"
new_release; run_su --auto-update weekly
grep -q -- "--auto-update weekly" "$RAN" && good "extra options reach the installer" || bad "extra options lost"

echo "The installer does not match its checksum:"
new_release; echo "# tampered" >> "$REL/install.sh"; run_su
[ "$rc" != 0 ] && ! installer_ran && grep -q 'does NOT match' "$T/out.txt" && good "refused, installer not run, plain message" || bad "tampered installer accepted or unclear (exit $rc): $(cat "$T/out.txt")"
no_leftovers && good "no temporary files left" || bad "temporary files left"
new_release; echo "# tampered" >> "$REL/install.sh"; run_su with-cosign
[ "$rc" != 0 ] && ! installer_ran && good "refused even when cosign would pass (checksum first)" || bad "mismatch not refused with cosign present"
new_release; printf '%s  uninstall.sh\n' "$(sum "$REL/uninstall.sh")" > "$REL/SHA256SUMS"; run_su
[ "$rc" != 0 ] && ! installer_ran && good "refused when SHA256SUMS does not list install.sh" || bad "unlisted installer accepted"

echo "With cosign installed:"
new_release; run_su with-cosign
[ "$rc" = 0 ] && installer_ran && good "verified and ran" || bad "failed (exit $rc): $(cat "$T/out.txt")"
grep -q "verify-blob" "$COSIGN_LOG" && grep -q -- "--certificate-identity $SIGNER" "$COSIGN_LOG" && grep -q -- "--certificate-oidc-issuer https://token.actions.githubusercontent.com" "$COSIGN_LOG" && grep -q -- "--bundle" "$COSIGN_LOG" \
  && good "cosign verify-blob got the bundle, this repository's workflow identity and GitHub's issuer" || bad "cosign arguments: $(cat "$COSIGN_LOG" 2>/dev/null)"
new_release; COSIGN_FAIL=1 run_su with-cosign
[ "$rc" != 0 ] && ! installer_ran && grep -q 'did NOT verify' "$T/out.txt" && good "a failed signature check stops it" || bad "failed signature accepted (exit $rc): $(cat "$T/out.txt")"
no_leftovers && good "no temporary files left" || bad "temporary files left"
new_release; rm "$REL/SHA256SUMS.sigstore.json"; run_su with-cosign
[ "$rc" != 0 ] && ! installer_ran && grep -q 'no SHA256SUMS.sigstore.json' "$T/out.txt" && good "cosign present but no signature file: refused" || bad "missing signature accepted (exit $rc)"

echo "A release without SHA256SUMS (the first run after this change):"
new_release; rm "$REL/SHA256SUMS" "$REL/SHA256SUMS.sigstore.json" "$REL/install.sh"; printf '#!/usr/bin/env bash\necho old-source "$@" > "%s"\n' "$RAN" > "$OLD"; run_su
[ "$rc" = 0 ] && installer_ran && grep -q '^old-source' "$RAN" && good "falls back to the old source" || bad "no fallback (exit $rc): $(cat "$T/out.txt")"
grep -q 'Warning: the latest release has no SHA256SUMS' "$T/out.txt" && good "with a visible warning" || bad "no warning"

echo "Never falling back when it should not:"
new_release; printf '#!/usr/bin/env bash\necho old-source > "%s"\n' "$RAN" > "$OLD"; rm "$REL/install.sh"; run_su
[ "$rc" != 0 ] && ! installer_ran && good "SHA256SUMS exists but install.sh does not: refused, no fallback" || bad "fell back although the release has SHA256SUMS"
new_release; printf '#!/usr/bin/env bash\necho old-source > "%s"\n' "$RAN" > "$OLD"; NET_DOWN=1 run_su
[ "$rc" != 0 ] && ! installer_ran && grep -q 'Could not reach GitHub' "$T/out.txt" && good "no network: refused, no fallback" || bad "network failure handled wrongly (exit $rc)"
new_release; printf '#!/usr/bin/env bash\necho old-source > "%s"\n' "$RAN" > "$OLD"; FORCE_CODE=503 FORCE_FILE=SHA256SUMS run_su
[ "$rc" != 0 ] && ! installer_ran && good "GitHub error (503) on SHA256SUMS: refused, no fallback" || bad "503 treated as 'no checksums'"
no_leftovers && good "no temporary files left" || bad "temporary files left"

[ "$fail" = 0 ] && echo "self-update checks: all passed"
exit "$fail"
