#!/usr/bin/env bash
# Starts a freshly built image just far enough to prove it is usable BEFORE it is pushed: it runs as the unprivileged user, its
# production-only node_modules resolve, and (worker) PowerShell can load the Teams modules. Usage: smoke-image.sh <api|worker|web> <image>
set -euo pipefail
name="$1"; image="$2"
fail() { echo "SMOKE TEST FAILED ($name): $*" >&2; exit 1; }

case "$name" in
  api)
    [ "$(docker run --rm "$image" id -un)" = "node" ] || fail "the process does not run as the node user"
    docker run --rm "$image" node -e "require('@nestjs/core'); require('@tvmf/db'); require('@tvmf/shared'); require('argon2'); require('pg'); require('express'); require('multer'); require('bullmq'); console.log('modules resolve')" \
      || fail "a production dependency is missing"
    docker run --rm "$image" node -e "const p=require('path'),pk=require('./apps/api/package.json');const miss=Object.keys(pk.dependencies).filter(m=>{try{require.resolve(m,{paths:[p.resolve('apps/api')]});return false}catch{return true}});if(miss.length){console.error('missing: '+miss.join(', '));process.exit(1)}console.log('all '+Object.keys(pk.dependencies).length+' declared dependencies resolve')" \
      || fail "a declared dependency of the api is not in the image"
    # An older, root-owned files volume is handed to the app user on start-up and is writable afterwards.
    docker volume create smoke-files >/dev/null
    docker run --rm -v smoke-files:/data/files --entrypoint sh "$image" -c 'chown -R 0:0 /data/files && touch /data/files/legacy'
    docker run --rm -v smoke-files:/data/files "$image" sh -c 'touch /data/files/new && echo "files volume writable as $(id -un)"' \
      || fail "the files volume is not writable"
    docker volume rm smoke-files >/dev/null
    ;;
  worker)
    [ "$(docker run --rm --entrypoint id "$image" -un)" = "voxshift" ] || fail "the process does not run as the voxshift user"
    docker run --rm --entrypoint node "$image" -e "require('@tvmf/db'); require('@tvmf/shared'); require('bullmq'); require('ioredis'); require('nodemailer'); require('ws'); console.log('modules resolve')" \
      || fail "a production dependency is missing"
    docker run --rm --entrypoint node "$image" -e "const p=require('path'),pk=require('./apps/worker/package.json');const miss=Object.keys(pk.dependencies).filter(m=>{try{require.resolve(m,{paths:[p.resolve('apps/worker')]});return false}catch{return true}});if(miss.length){console.error('missing: '+miss.join(', '));process.exit(1)}console.log('all '+Object.keys(pk.dependencies).length+' declared dependencies resolve')" \
      || fail "a declared dependency of the worker is not in the image"
    docker run --rm --entrypoint pwsh "$image" -NoLogo -NoProfile -NonInteractive -Command \
      "Import-Module MicrosoftTeams; Import-Module Microsoft.Graph.Authentication; 'powershell modules load as ' + [Environment]::UserName" \
      || fail "PowerShell cannot load the Teams modules as the unprivileged user"
    ;;
  web)
    docker run --rm --add-host api:127.0.0.1 --entrypoint sh "$image" -c 'nginx -t && test -s /usr/share/nginx/html/index.html && cat /usr/share/nginx/html/version.json' \
      || fail "nginx rejects its config or the app is missing"
    # Start it for real and check what a browser would be sent.
    cid=$(docker run -d --add-host api:127.0.0.1 -p 8081:80 "$image")
    trap 'docker rm -f "$cid" >/dev/null 2>&1 || true' EXIT
    for i in $(seq 1 20); do curl -fsS -o /dev/null http://127.0.0.1:8081/version.json && break; sleep 1; done
    asset=$(curl -fsS http://127.0.0.1:8081/ | grep -oE '/assets/[^"]+\.js' | head -1)
    for path in / "$asset" /version.json; do
      headers=$(curl -fsSI "http://127.0.0.1:8081$path") || fail "GET $path failed"
      for h in "x-content-type-options: nosniff" "x-frame-options: DENY" "referrer-policy:" "permissions-policy:" "content-security-policy: default-src"; do
        echo "$headers" | grep -qi "$h" || fail "GET $path is missing the $h header"
      done
    done
    curl -fsSI http://127.0.0.1:8081/ | grep -i '^server:' | grep -q '[0-9]\.[0-9]' && fail "nginx announces its version"
    echo "security headers present on the app shell, assets and /version.json"
    ;;
  *) fail "unknown image name" ;;
esac
echo "smoke test passed ($name)"
