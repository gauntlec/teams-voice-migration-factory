#!/usr/bin/env bash
# The ONE place the security contact email address lives is the file deploy/security/SECURITY_CONTACT_EMAIL (until the real address is
# chosen it says "security-contact-to-be-confirmed"). The places that must show it are kept in step by this script:
#   SECURITY.md                                     (between the SECURITY_CONTACT_EMAIL markers; GitHub shows this as the Security policy)
#   apps/web/public/.well-known/security.txt        (the "Contact: mailto:" line; served at /.well-known/security.txt)
#   docs/SECURITY.md                                (the marker in the note at the top)
# Other documents do not repeat the address; they point at SECURITY.md.
#
#   bash deploy/security/set-contact.sh security@example.com   # set the address and update both places
#   bash deploy/security/set-contact.sh                        # update both places from the file (after editing it by hand)
#   bash deploy/security/set-contact.sh --check                # only check they agree (CI runs this); exit 1 if not
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SRC="$HERE/SECURITY_CONTACT_EMAIL"
MD="$ROOT/SECURITY.md"
TXT="$ROOT/apps/web/public/.well-known/security.txt"
DOC="$ROOT/docs/SECURITY.md"

# True for the placeholder or for something shaped like an address (letters, digits and . _ % + - around one @ with a dot after it).
valid() {
  [ "$1" = "security-contact-to-be-confirmed" ] && return 0
  case "$1" in *[!A-Za-z0-9._%+@-]*|""|@*|*@|*@*@*|*@.*|*.) return 1 ;; esac
  case "$1" in *@*.*) return 0 ;; *) return 1 ;; esac
}

mode="sync"
case "${1:-}" in
  --check) mode="check" ;;
  "") ;;
  -*) echo "Unknown option $1" >&2; exit 2 ;;
  *) valid "$1" || { echo "'$1' does not look like an email address." >&2; exit 2; }
     printf '%s\n' "$1" > "$SRC" ;;
esac

value="$(tr -d '[:space:]' < "$SRC")"
valid "$value" || { echo "$SRC holds '$value', which does not look like an email address." >&2; exit 2; }

in_md="$(sed -nE 's|.*<!--SECURITY_CONTACT_EMAIL-->([^<]*)<!--/SECURITY_CONTACT_EMAIL-->.*|\1|p' "$MD" | head -n 1)"
in_doc="$(sed -nE 's|.*<!--SECURITY_CONTACT_EMAIL-->([^<]*)<!--/SECURITY_CONTACT_EMAIL-->.*|\1|p' "$DOC" | head -n 1)"
in_txt="$(sed -nE 's|^Contact: mailto:(.*)$|\1|p' "$TXT" | head -n 1)"

if [ "$mode" = check ]; then
  rc=0
  [ "$in_md" = "$value" ] || { echo "SECURITY.md shows '$in_md' but deploy/security/SECURITY_CONTACT_EMAIL says '$value'. Run: bash deploy/security/set-contact.sh" >&2; rc=1; }
  [ "$in_doc" = "$value" ] || { echo "docs/SECURITY.md shows '$in_doc' but deploy/security/SECURITY_CONTACT_EMAIL says '$value'. Run: bash deploy/security/set-contact.sh" >&2; rc=1; }
  [ "$in_txt" = "$value" ] || { echo "security.txt shows '$in_txt' but deploy/security/SECURITY_CONTACT_EMAIL says '$value'. Run: bash deploy/security/set-contact.sh" >&2; rc=1; }
  [ "$rc" != 0 ] || echo "security contact: the same everywhere ($value)"
  exit "$rc"
fi

sed -E "s|(<!--SECURITY_CONTACT_EMAIL-->)[^<]*(<!--/SECURITY_CONTACT_EMAIL-->)|\\1$value\\2|" "$MD" > "$MD.new" && mv "$MD.new" "$MD"
sed -E "s|(<!--SECURITY_CONTACT_EMAIL-->)[^<]*(<!--/SECURITY_CONTACT_EMAIL-->)|\\1$value\\2|" "$DOC" > "$DOC.new" && mv "$DOC.new" "$DOC"
sed -E "s|^(Contact: mailto:).*\$|\\1$value|" "$TXT" > "$TXT.new" && mv "$TXT.new" "$TXT"
echo "Security contact is now: $value"
echo "Updated SECURITY.md, docs/SECURITY.md and apps/web/public/.well-known/security.txt. Commit both, and the file deploy/security/SECURITY_CONTACT_EMAIL."
