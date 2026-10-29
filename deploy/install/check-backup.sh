#!/usr/bin/env bash
# Exercises the `voxshift` command's backup, backup encryption and restore without Docker, a database or root: the installer writes the files
# (--generate-only), then the generated command is run against a STUB docker (a script that fakes pg_dump, the volume archives and pg_restore)
# and a stub `id` (so it believes it is root). `age` is the REAL program, so the encryption round trip is real. Run:  bash deploy/install/check-backup.sh
# Needs: age and age-keygen on the PATH (https://age-encryption.org). Not a substitute for a real backup and restore on a Linux host.
# shellcheck disable=SC2010  # file names here are fixed timestamps; ls | grep is fine
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
command -v age >/dev/null 2>&1 && command -v age-keygen >/dev/null 2>&1 || { echo "SKIPPED: age and age-keygen are needed for this check (brew install age / apt install age)."; exit 0; }
AGE_BIN="$(command -v age)"; AGE_KEYGEN_BIN="$(command -v age-keygen)"
SHELLCHECK="$(command -v shellcheck || true)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail=0
bad() { echo "FAIL: $*"; fail=1; }
good() { echo "  ok: $*"; }

# ---------------------------------------------------------------- stubs
STUB="$T/stub"; mkdir -p "$STUB"
export STUB_LOG="$T/docker.log" STUB_DUMP="$T/fake.dump" STUB_RESTORED="$T/pg_restore.stdin" STUB_COUNTER="$T/counter"
: > "$STUB_LOG"
DUMP_MARKER="DATABASE-CONTENT-MARKER-$$-$RANDOM"
printf 'PGDMP fake custom-format dump\n%s\n' "$DUMP_MARKER" > "$STUB_DUMP"
cat > "$STUB/docker" <<'EOF'
#!/usr/bin/env bash
echo "docker $*" >> "$STUB_LOG"
if [ "${1:-}" = compose ]; then
  shift
  case "$*" in
    *"exec -T postgres pg_dump"*) cat "$STUB_DUMP" ;;
    *"exec -T web wget -q -O - "*) echo '{"version":"2026.10.20"}' ;;
    *"pg_restore"*) cat > "$STUB_RESTORED"; [ -z "${STUB_FAIL_RESTORE:-}" ] || exit 1 ;;
    *"psql"*) [ -z "${STUB_FAIL_RESTORE:-}" ] || exit 1 ;;
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
if [ "${1:-}" = image ] && [ "${2:-}" = inspect ]; then
  n=$(( $(cat "$STUB_COUNTER" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$STUB_COUNTER"; echo "sha256:$n"; exit 0
fi
exit 0
EOF
printf '#!/bin/sh\n[ "$1" = "-u" ] && echo 0 || /usr/bin/id "$@"\n' > "$STUB/id"
printf '#!/bin/sh\n[ "$1" = "-s" ] && echo Linux || /usr/bin/uname "$@"\n' > "$STUB/uname"
# df: the real one, unless STUB_DF_FREE_KB is set (then every path is on one disk with that much free)
printf '#!/bin/sh\n[ -n "${STUB_DF_FREE_KB:-}" ] || exec /bin/df "$@"\necho "Filesystem 1024-blocks Used Available Capacity Mounted on"\necho "/dev/fake 20000000 1 $STUB_DF_FREE_KB 1%% /"\n' > "$STUB/df"
chmod +x "$STUB"/*
ln -s "$AGE_BIN" "$STUB/age"; ln -s "$AGE_KEYGEN_BIN" "$STUB/age-keygen"
BASEPATH="$STUB:/usr/bin:/bin:/usr/sbin:/sbin"

# ---------------------------------------------------------------- render an install, make keys
D="$T/vx"
bash "$HERE/install.sh" --generate-only -y --admin-email admin@example.com --dir "$D" --base-url http://10.0.0.20 >"$T/render.log" 2>&1 || { echo "FAIL: installer did not render: $(tail -2 "$T/render.log")"; exit 1; }
vx() { PATH="$BASEPATH" bash "$D/voxshift" "$@"; }
BK="$D/backups"
status_has() { vx backup-encryption status >"$T/st.log" 2>&1; grep -q "$1" "$T/st.log"; }

KEY="$T/key.txt"; "$AGE_KEYGEN_BIN" -o "$KEY" 2>/dev/null
PUB="$("$AGE_KEYGEN_BIN" -y "$KEY")"
KEY2="$T/key2.txt"; "$AGE_KEYGEN_BIN" -o "$KEY2" 2>/dev/null
PUB2="$("$AGE_KEYGEN_BIN" -y "$KEY2")"
WRONG="$T/wrong.txt"; "$AGE_KEYGEN_BIN" -o "$WRONG" 2>/dev/null
PGPASS="$(sed -n "s/^POSTGRES_PASSWORD='\(.*\)'/\1/p" "$D/.env")"

echo "The generated command:"
bash -n "$D/voxshift" && good "bash -n" || bad "the generated command has a syntax error"
if [ -n "$SHELLCHECK" ]; then
  if "$SHELLCHECK" -S warning -e SC2010 -s bash "$D/voxshift" >"$T/sc.log" 2>&1; then good "shellcheck (warnings and errors)"; else bad "shellcheck: $(head -20 "$T/sc.log")"; fi
else echo "  (shellcheck not installed - skipped)"; fi

# ---------------------------------------------------------------- 1. unencrypted backup still works
echo "Encryption off (the default):"
status_has 'OFF' && good "status says OFF" || bad "status does not say OFF"
vx backup >"$T/b1.log" 2>&1 || bad "plain backup failed: $(tail -3 "$T/b1.log")"
plain="$(ls -1 "$BK" | grep -E '^[0-9]{8}-[0-9]{6}$' | head -n 1)"
[ -n "$plain" ] && [ -f "$BK/$plain/manifest.txt" ] && [ -f "$BK/$plain/database.dump" ] && good "plain backup is a folder with a manifest" || bad "no plain backup folder"
grep -q 'NOT encrypted' "$T/b1.log" && good "the backup output says it is not encrypted" || bad "no 'not encrypted' notice"

# ---------------------------------------------------------------- 2. switching it on
echo "Switching encryption on:"
vx backup-encryption on "$KEY" >"$T/on1.log" 2>&1 && bad "a PRIVATE key file was accepted" || { grep -q 'PRIVATE' "$T/on1.log" && good "refuses a file holding a private key" || bad "private key refusal has no message"; }
SECRET_LINE="$(grep AGE-SECRET-KEY- "$KEY")"
vx backup-encryption on "$SECRET_LINE" >"$T/on2.log" 2>&1 && bad "a private key string was accepted" || good "refuses a private key typed in"
vx backup-encryption on "not-a-key" >"$T/on3.log" 2>&1 && bad "garbage was accepted" || good "refuses something that is not a key"
vx backup-encryption on "age1notarealkeybutlooksliketoolongtobevalidxxxxxxxxxxxxxxxxxxxxxxx" >"$T/on4.log" 2>&1 && bad "an invalid age1 string was accepted" || good "refuses an age1... string that age rejects"
[ ! -e "$D/backup-recipients" ] && good "nothing was written by the refusals" || bad "a refusal left a recipients file"
vx backup-encryption on "$PUB" >"$T/on5.log" 2>&1 || bad "switching on with a public key failed: $(tail -3 "$T/on5.log")"
[ "$(wc -l < "$D/backup-recipients" | tr -d ' ')" = 1 ] && grep -qx "$PUB" "$D/backup-recipients" && good "backup-recipients holds the public key" || bad "backup-recipients is wrong"
grep -q 'AGE-SECRET-KEY' "$D/backup-recipients" && bad "a private key is on the host" || good "no private key on the host"
perm="$(ls -l "$D/backup-recipients" | cut -c1-10)"; [ "$perm" = "-rw-------" ] && good "mode 600" || bad "backup-recipients mode is $perm"
grep -q 'backup-recipients\|BACKUP_RECIP\|age1' "$D/.env" && bad "recipient settings leaked into .env" || good "nothing about it in .env"
grep -q '1 older backup' "$T/on5.log" && good "warns about the earlier unencrypted backup" || { grep -q 'NOT encrypted' "$T/on5.log" && good "warns about the earlier unencrypted backup" || bad "no warning about earlier unencrypted backups"; }
status_has 'ON (1 public key' && good "status says ON" || bad "status does not say ON"

# ---------------------------------------------------------------- 3. an encrypted backup
echo "Encrypted backup:"
sleep 1
vx backup >"$T/b2.log" 2>&1 || bad "encrypted backup failed: $(tail -3 "$T/b2.log")"
enc="$(ls -1 "$BK" | grep -E '^[0-9]{8}-[0-9]{6}\.tar\.age$' | head -n 1)"
[ -n "$enc" ] && good "wrote $enc" || bad "no .tar.age was written"
[ -f "$BK/$enc.sha256" ] && ( cd "$BK" && { sha256sum -c --quiet "$enc.sha256" 2>/dev/null || shasum -a 256 -c --quiet "$enc.sha256" 2>/dev/null; } ) && good "the .sha256 beside it matches" || bad "missing or wrong .sha256"
[ "$(head -c 21 "$BK/$enc")" = "age-encryption.org/v1" ] && good "starts with the age header" || bad "no age header"
ls -1 "$BK" | grep -qE '\.partial$' && bad "a .partial was left behind" || good "no .partial left"
new_folders="$(ls -1 "$BK" | grep -E '^[0-9]{8}-[0-9]{6}$' | wc -l | tr -d ' ')"
[ "$new_folders" = 1 ] && good "no plain folder was made for the encrypted backup (only the old plain one remains)" || bad "plain folders: $new_folders"
grep -qa "$DUMP_MARKER" "$BK/$enc" && bad "the database content is readable in the encrypted file" || good "the database content is not readable in the file"
[ -z "$PGPASS" ] || { grep -qa "$PGPASS" "$BK/$enc" && bad ".env secret readable in the encrypted file" || good ".env secrets are not readable in the file"; }
grep -q 'encrypted, ' "$T/b2.log" && good "output reports size and sha256" || bad "output does not report size/sha256"
"$AGE_BIN" -d -i "$KEY" "$BK/$enc" | tar -t > "$T/list.txt" 2>/dev/null
for f in database.dump files.tar.gz env compose.yaml manifest.txt caddy-data.tar.gz; do grep -qE "(^|/)$f\$" "$T/list.txt" || bad "decrypted archive lacks $f"; done
good "decrypts with the private key and holds every file"
"$AGE_BIN" -d -i "$WRONG" "$BK/$enc" >/dev/null 2>&1 && bad "a different key opened it" || good "a different key cannot open it"

# ---------------------------------------------------------------- 4. age missing: fail clearly, never plain
echo "age missing while encryption is on:"
rm "$STUB/age"
before="$(ls -1 "$BK" | wc -l | tr -d ' ')"
vx backup >"$T/b3.log" 2>&1 && bad "a backup was made without age" || { grep -q "'age' is not installed" "$T/b3.log" && good "stops with a clear message" || bad "no clear message: $(tail -2 "$T/b3.log")"; }
[ "$(ls -1 "$BK" | wc -l | tr -d ' ')" = "$before" ] && good "nothing was written (no silent unencrypted backup)" || bad "files appeared in backups/"
ln -s "$AGE_BIN" "$STUB/age"

# ---------------------------------------------------------------- 5. rotation
echo "Rotation:"
mkdir -p "$BK/keep-me" "$BK/20200101-000000"
for i in $(seq 1 16); do n="$(printf '2021%02d01-000000' "$i")"; if [ $((i % 2)) = 0 ]; then mkdir "$BK/$n"; else : > "$BK/$n.tar.age"; : > "$BK/$n.tar.age.sha256"; fi; done
for i in 1 2 3 4 5; do n="$(printf 'pre-restore-2021%02d01-000000' "$i")"; : > "$BK/$n.tar.age"; : > "$BK/$n.tar.age.sha256"; done
sleep 1; vx backup >"$T/b4.log" 2>&1 || bad "backup for rotation failed: $(tail -3 "$T/b4.log")"
count="$(ls -1 "$BK" | sed -nE 's/^([0-9]{8}-[0-9]{6})(\.tar\.age)?$/\1/p' | sort -u | wc -l | tr -d ' ')"
[ "$count" = 7 ] && good "7 backups kept by default (folders and encrypted files count together)" || bad "kept $count backups, expected 7"
pcount="$(ls -1 "$BK" | sed -nE 's/^(pre-restore-[0-9]{8}-[0-9]{6})(\.tar\.age)?$/\1/p' | sort -u | wc -l | tr -d ' ')"
[ "$pcount" = 3 ] && good "3 pre-restore backups kept" || bad "kept $pcount pre-restore backups, expected 3"
[ -d "$BK/keep-me" ] && good "an unrelated folder was left alone" || bad "an unrelated folder was removed"
ls "$BK" | grep -q '2021010[1-9]-000000.sha256\|20210101-000000.tar.age.sha256' && bad "an old .sha256 was left behind" || good "old .sha256 files go with their backup"

# ---------------------------------------------------------------- 5b. how many are kept, other folders, disk space
echo "Keep count (voxshift backup-keep), other folders and disk space:"
D3="$T/vx3"; bash "$HERE/install.sh" --generate-only -y --admin-email admin@example.com --dir "$D3" --base-url http://10.0.0.20 >/dev/null 2>&1
vx3() { PATH="$BASEPATH" bash "$D3/voxshift" "$@"; }
B3="$D3/backups"; mkdir -p "$B3"
olds() { for i in $(seq 1 "$1"); do mkdir -p "$2/$(printf '2021%02d01-000000' "$i")"; done; }
kept() { ls -1 "$1" | sed -nE 's/^([0-9]{8}-[0-9]{6})(\.tar\.age)?$/\1/p' | sort -u | wc -l | tr -d ' '; }
grep -qx 'BACKUP_KEEP=7' "$D3/.env" && good "a new install writes BACKUP_KEEP=7 in .env" || bad ".env has no BACKUP_KEEP=7"
vx3 backup-keep >"$T/k1.log" 2>&1 && grep -q 'the newest 7' "$T/k1.log" && good "backup-keep shows the setting" || bad "backup-keep output: $(cat "$T/k1.log")"
for v in 0 366 abc -3 ''; do
  [ -z "$v" ] && continue
  cp "$D3/.env" "$T/env.before"
  vx3 backup-keep "$v" >/dev/null 2>&1 && bad "backup-keep $v was accepted" || { cmp -s "$T/env.before" "$D3/.env" && good "backup-keep $v refused, .env unchanged" || bad "backup-keep $v changed .env"; }
done
vx3 backup-keep 4 >"$T/k2.log" 2>&1 || bad "backup-keep 4 failed: $(cat "$T/k2.log")"
[ "$(grep -c '^BACKUP_KEEP=' "$D3/.env")" = 1 ] && grep -qx 'BACKUP_KEEP=4' "$D3/.env" && good "backup-keep 4 rewrote the one BACKUP_KEEP line" || bad ".env BACKUP_KEEP lines: $(grep BACKUP_KEEP "$D3/.env")"
perm="$(ls -l "$D3/.env" | cut -c1-10)"; [ "$perm" = "-rw-------" ] && good ".env is still mode 600" || bad ".env mode is $perm"
grep -q "^JWT_ACCESS_SECRET=" "$D3/.env" && good "the rest of .env is intact" || bad ".env lost its other lines"
olds 9 "$B3"
vx3 backup-keep >"$T/k3.log" 2>&1; grep -q 'Backups there now: 9' "$T/k3.log" && good "backup-keep counts the backups there" || bad "count: $(cat "$T/k3.log")"
sleep 1; vx3 backup >"$T/k4.log" 2>&1 || bad "backup failed: $(tail -3 "$T/k4.log")"
[ "$(kept "$B3")" = 4 ] && good "4 kept after backup-keep 4" || bad "kept $(kept "$B3"), expected 4"
newest="$(ls -1 "$B3" | grep -E '^20[0-9]{6}-[0-9]{6}$' | sort | tail -n 1)"; [ -f "$B3/$newest/manifest.txt" ] && good "the new backup is one of them" || bad "the new backup is missing"
vx3 backup-keep 2 >"$T/k4b.log" 2>&1 || bad "backup-keep 2 failed"
[ "$(kept "$B3")" = 2 ] && [ -d "$B3/$newest" ] && good "lowering it deletes the oldest at once, newest kept" || bad "after backup-keep 2: $(kept "$B3") left"
grep -q 'Deleted the older ones' "$T/k4b.log" && grep -q '20210[0-9]01-000000' "$T/k4b.log" && good "and says which it deleted" || bad "no list of deleted backups: $(cat "$T/k4b.log")"
vx3 backup-keep 9 >"$T/k4c.log" 2>&1; [ "$(kept "$B3")" = 2 ] && ! grep -q Deleted "$T/k4c.log" && good "raising it deletes nothing" || bad "raising it changed something"
# the line missing (an install made earlier): the default
grep -v '^BACKUP_KEEP=' "$D3/.env" > "$T/env.nokeep"; cat "$T/env.nokeep" > "$D3/.env"
vx3 backup-keep >"$T/k5.log" 2>&1; grep -q 'the newest 7' "$T/k5.log" && good "no BACKUP_KEEP line: 7" || bad "default without the line: $(cat "$T/k5.log")"
vx3 backup-keep 5 >/dev/null 2>&1; grep -qx 'BACKUP_KEEP=5' "$D3/.env" && good "backup-keep adds the line when it is missing" || bad "line not added"
printf "BACKUP_KEEP='lots'\n" >> "$D3/.env"
vx3 backup-keep >"$T/k6.log" 2>&1; grep -q 'not a whole number' "$T/k6.log" && grep -q 'the newest 7' "$T/k6.log" && good "a bad value is reported and 7 are kept" || bad "bad value: $(cat "$T/k6.log")"
vx3 backup-keep 2 >/dev/null 2>&1
# the clock has gone backwards: backups dated later than now must not push out the one just written
mkdir -p "$B3/20990101-000000" "$B3/20990201-000000"
sleep 1; vx3 backup >"$T/k7.log" 2>&1 || bad "backup failed: $(tail -3 "$T/k7.log")"
just="$(sed -n 's|^Backup written to [^ ]*/\([0-9]\{8\}-[0-9]\{6\}\).*|\1|p' "$T/k7.log")"
[ -n "$just" ] && [ -d "$B3/$just" ] && good "the backup just written is kept even when others look newer" || bad "the backup just written was deleted ($just)"
[ "$(kept "$B3")" = 2 ] && good "and the count is still 2" || bad "kept $(kept "$B3"), expected 2"
rm -rf "$B3"/2099*
# a folder named on the command line is never cleaned up
E="$T/elsewhere"; olds 12 "$E"; mkdir -p "$E/keep-me"
sleep 1; vx3 backup "$E" >"$T/k8.log" 2>&1 || bad "backup to another folder failed: $(tail -3 "$T/k8.log")"
[ "$(kept "$E")" = 13 ] && [ -d "$E/keep-me" ] && good "a folder you name is not cleaned up (12 old + the new one)" || bad "the named folder was pruned: $(kept "$E") left"
# not enough disk space: update and the nightly job stop before pulling or backing up
before="$(ls -1 "$B3" | wc -l | tr -d ' ')"; : > "$STUB_LOG"
export STUB_DF_FREE_KB=100   # under 1 MB: not even room for these tiny stub backups
vx3 backup >"$T/s1.log" 2>&1 && bad "a backup was made with too little space" || { grep -q 'Not enough free disk space' "$T/s1.log" && grep -q 'backup-keep' "$T/s1.log" && good "backup: stops with a clear message" || bad "backup message: $(cat "$T/s1.log")"; }
vx3 update >"$T/s2.log" 2>&1 && bad "update went ahead with too little space" || { grep -q 'new images' "$T/s2.log" && good "update: stops, naming the backup and the images" || bad "update message: $(cat "$T/s2.log")"; }
vx3 update --auto >"$T/s3.log" 2>&1 && bad "the nightly job went ahead with too little space" || { grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T.*Not enough free disk space' "$T/s3.log" && good "nightly job: one dated line in the log" || bad "nightly message: $(cat "$T/s3.log")"; }
grep -q 'pull' "$STUB_LOG" && bad "images were pulled with too little space" || good "nothing was pulled"
[ "$(ls -1 "$B3" | wc -l | tr -d ' ')" = "$before" ] && good "nothing was written to backups/" || bad "files appeared in backups/"
export STUB_DF_FREE_KB=$((1000 * 1024))   # room for a (tiny stub) backup, not for a backup and 1.5 GB of images
vx3 backup >/dev/null 2>&1 && good "backup: enough room for a backup alone" || bad "backup refused with room for it"
vx3 update >"$T/s4.log" 2>&1 && bad "update went ahead without room for the images" || good "update: a backup fits but the images do not, so it stops"
unset STUB_DF_FREE_KB
vx3 update >"$T/s5.log" 2>&1 && good "update goes ahead with enough room" || bad "update with enough room failed: $(tail -3 "$T/s5.log")"

# ---------------------------------------------------------------- 6. restore
echo "Restore of an encrypted backup:"
rm -rf "$BK"/2021* "$BK"/pre-restore-* "$BK"/20200101-000000
cp "$D/.env" "$T/env.original"
vx restore "$BK/$enc" --yes >"$T/r1.log" 2>&1 && bad "restored an encrypted backup without --identity" || { grep -q 'ENCRYPTED' "$T/r1.log" && grep -q 'cannot be read' "$T/r1.log" && good "refused without --identity, with a plain message" || bad "unclear message: $(cat "$T/r1.log")"; }
vx restore "$BK/$enc" --identity "$WRONG" --yes >"$T/r2.log" 2>&1 && bad "restored with the wrong key" || { grep -q 'could not be opened' "$T/r2.log" && good "wrong key: refused with a message" || bad "wrong-key message: $(cat "$T/r2.log")"; }
ls -A "$BK" | grep -q '^\.restore-' && bad "a decrypted folder was left after a refusal" || good "no decrypted folder left after the refusals"
vx restore "$BK/$enc" --identity "$T/nonexistent" --yes >/dev/null 2>&1 && bad "restored with a missing key file" || good "missing key file: refused"
: > "$STUB_RESTORED"
sleep 1
vx restore "$BK/$enc" --identity "$KEY" --yes >"$T/r3.log" 2>&1 || bad "restore with the right key failed: $(tail -5 "$T/r3.log")"
cmp -s "$STUB_DUMP" "$STUB_RESTORED" && good "pg_restore was fed exactly the dumped database" || bad "pg_restore got different data"
grep -q 'Checked: every file in the backup matches its checksum' "$T/r3.log" && good "the manifest check ran on the decrypted copy" || bad "manifest check did not run"
ls -A "$BK" | grep -q '^\.restore-' && bad "the decrypted folder is still there after the restore" || good "decrypted folder removed after the restore"
ls -1 "$BK" | grep -qE '^pre-restore-[0-9]{8}-[0-9]{6}\.tar\.age$' && good "the safety backup before the restore is encrypted too" || bad "safety backup is not encrypted"
ls -1 "$BK" | grep -qE '^pre-restore-[0-9]{8}-[0-9]{6}$' && bad "a plain safety backup was made" || good "no plain safety backup"
grep -q -- '--identity <your-private-key-file>' "$T/r3.log" && good "the go-back hint says the key is needed" || bad "go-back hint lacks --identity"
[ -f "$D/.env" ] && good ".env is in place" || bad ".env missing"

echo "Restore stops part-way, and a damaged backup:"
export STUB_FAIL_RESTORE=1
sleep 1
vx restore "$BK/$enc" --identity "$KEY" --yes >"$T/r4.log" 2>&1 && bad "restore reported success when pg_restore failed" || { grep -q 'The restore stopped part-way' "$T/r4.log" && good "failure reported with the way back" || bad "no way-back message: $(tail -3 "$T/r4.log")"; }
unset STUB_FAIL_RESTORE
ls -A "$BK" | grep -q '^\.restore-' && bad "the decrypted folder survived a failed restore" || good "decrypted folder removed after a failed restore"
# a backup that was changed after it was made: unpack, alter, repack with the OLD manifest, encrypt
X="$T/tamper"; mkdir -p "$X"; "$AGE_BIN" -d -i "$KEY" "$BK/$enc" | tar -x -C "$X"; echo "altered" >> "$X/database.dump"
tar -C "$X" -cf - . | "$AGE_BIN" -r "$PUB" > "$BK/20990101-000000.tar.age"
vx restore "$BK/20990101-000000.tar.age" --identity "$KEY" --yes >"$T/r5.log" 2>&1 && bad "restored a changed backup" || { grep -q 'damaged or has been changed' "$T/r5.log" && good "a changed backup is refused" || bad "tamper message: $(tail -3 "$T/r5.log")"; }
ls -A "$BK" | grep -q '^\.restore-' && bad "decrypted folder left after the tamper refusal" || good "decrypted folder removed after the tamper refusal"
# a damaged copy of an encrypted file with its checksum beside it
cp "$BK/$enc" "$BK/20990202-000000.tar.age"; ( cd "$BK" && { sha256sum "$enc" 2>/dev/null || shasum -a 256 "$enc"; } | sed 's/ .*//' | sed 's/$/  20990202-000000.tar.age/' > 20990202-000000.tar.age.sha256 )
printf 'x' >> "$BK/20990202-000000.tar.age"
vx restore "$BK/20990202-000000.tar.age" --identity "$KEY" --yes >"$T/r6.log" 2>&1 && bad "restored a file that fails its checksum" || { grep -q 'damaged' "$T/r6.log" && good "a file that fails its .sha256 is refused" || bad "checksum message: $(tail -3 "$T/r6.log")"; }
rm -f "$BK"/2099*

echo "Restore of a plain backup still works:"
: > "$STUB_RESTORED"; sleep 1
vx restore "$BK/$plain" --yes >"$T/r7.log" 2>&1 || bad "plain restore failed: $(tail -5 "$T/r7.log")"
cmp -s "$STUB_DUMP" "$STUB_RESTORED" && good "plain backup restored" || bad "plain restore did not feed pg_restore"
vx restore >"$T/r8.log" 2>&1 || true
grep -q '\.tar\.age' "$T/r8.log" && good "the listing shows encrypted backups" || bad "the listing misses encrypted backups"

# ---------------------------------------------------------------- 7. the nightly job and uninstall
echo "Automatic update and uninstall:"
rm -rf "$BK"; mkdir -p "$BK"; : > "$STUB_COUNTER"
sleep 1
vx update --auto >"$T/u1.log" 2>&1 || bad "update --auto failed: $(tail -3 "$T/u1.log")"
ls -1 "$BK" | grep -qE '^[0-9]{8}-[0-9]{6}\.tar\.age$' && good "the nightly update's backup is encrypted" || bad "nightly backup is not encrypted: $(cat "$T/u1.log")"
ls -1 "$BK" | grep -qE '^[0-9]{8}-[0-9]{6}$' && bad "nightly update made a plain backup" || good "no plain backup from the nightly update"
OUT="$T/uninstall-backup"
PATH="$BASEPATH" bash "$HERE/uninstall.sh" --dir "$D" --backup-to "$OUT" --yes >"$T/un1.log" 2>&1 || bad "uninstall --backup-to failed: $(tail -4 "$T/un1.log")"
ls -1 "$OUT" 2>/dev/null | grep -qE '\.tar\.age$' && ! ls -1 "$OUT" | grep -qE '^[0-9]{8}-[0-9]{6}$' && good "uninstall --backup-to wrote an encrypted backup" || bad "uninstall backup is not encrypted: $(ls -1 "$OUT" 2>&1)"
[ ! -d "$D" ] && good "uninstall removed the install directory after the backup" || bad "install directory still there"
# with age gone, uninstall must stop BEFORE deleting anything
bash "$HERE/install.sh" --generate-only -y --admin-email admin@example.com --dir "$D" --base-url http://10.0.0.20 >/dev/null 2>&1
vx backup-encryption on "$PUB" >/dev/null 2>&1
rm "$STUB/age"
PATH="$BASEPATH" bash "$HERE/uninstall.sh" --dir "$D" --backup-to "$T/uninstall-backup2" --yes >"$T/un2.log" 2>&1 && bad "uninstall went ahead without being able to encrypt the backup" || good "uninstall stops when the encrypted backup cannot be made"
[ -d "$D" ] && good "... and nothing was removed" || bad "the install directory was removed anyway"
ln -s "$AGE_BIN" "$STUB/age"

# ---------------------------------------------------------------- 8. switching off
echo "Switching encryption off:"
vx backup-encryption off >/dev/null 2>&1; [ ! -e "$D/backup-recipients" ] && good "backup-recipients removed" || bad "still there"
status_has 'OFF' && good "status says OFF" || bad "status after off"

# ---------------------------------------------------------------- 9. installer options
echo "Installer options:"
refuse() { label="$1"; shift; if bash "$HERE/install.sh" --generate-only -y --admin-email admin@example.com --dir "$T/y-$label" --base-url http://10.0.0.20 "$@" >"$T/y-$label.log" 2>&1; then bad "$label: should have been refused"; else good "$label: refused"; fi; }
refuse private-key-file --backup-recipient "$KEY"
refuse private-key-string --backup-recipient "$SECRET_LINE"
refuse not-a-key --backup-recipient hello
grep -q 'PRIVATE' "$T/y-private-key-file.log" && good "the refusal says why" || bad "refusal for a private key file has no explanation"
bash "$HERE/install.sh" --generate-only -y --admin-email admin@example.com --dir "$T/z" --base-url http://10.0.0.20 --backup-recipient "$PUB" --backup-recipient "$PUB2" >"$T/z.log" 2>&1 && good "public keys accepted by the installer" || bad "installer refused public keys: $(tail -2 "$T/z.log")"
bash "$HERE/install.sh" --help | grep -q -- '--backup-recipient' && good "--help describes --backup-recipient" || bad "--help lacks --backup-recipient"

echo "Two keys (either opens the backup):"
D2="$T/vx2"; bash "$HERE/install.sh" --generate-only -y --admin-email admin@example.com --dir "$D2" --base-url http://10.0.0.20 >/dev/null 2>&1
printf '# a comment\n%s\n\n%s\n' "$PUB" "$PUB2" > "$T/recips.txt"
PATH="$BASEPATH" bash "$D2/voxshift" backup-encryption on "$T/recips.txt" >/dev/null 2>&1 || bad "a file of public keys was refused"
[ "$(wc -l < "$D2/backup-recipients" | tr -d ' ')" = 2 ] && good "comments and blank lines are dropped; two keys stored" || bad "recipient file content wrong"
PATH="$BASEPATH" bash "$D2/voxshift" backup >/dev/null 2>&1 || bad "backup with two keys failed"
f2="$(ls -1 "$D2/backups" | grep '\.tar\.age$' | head -n 1)"
"$AGE_BIN" -d -i "$KEY2" "$D2/backups/$f2" | tar -t >/dev/null 2>&1 && good "the second key opens it too" || bad "second key cannot open the backup"

[ "$fail" = 0 ] && echo "backup encryption checks: all passed"
exit "$fail"
