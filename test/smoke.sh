#!/usr/bin/env bash
# Smoke test against a running deployment (creates and deletes a test artifact).
#   ADMIN_TOKEN=... test/smoke.sh https://artifacts.example.com
# Note: the final check triggers the brute-force throttle; your IP is locked out for one minute.
set -u
B=${1:-http://localhost:3000}
TOK=${ADMIN_TOKEN:?set ADMIN_TOKEN}
T="Authorization: Bearer $TOK"; J="Content-Type: application/json"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
pass=0; failn=0
check() { # name expected actual
  if [ "$2" = "$3" ]; then pass=$((pass+1)); printf '  ok    %-48s %s\n' "$1" "$3"
  else failn=$((failn+1)); printf '  FAIL  %-48s expected %s, got %s\n' "$1" "$2" "$3"; fi
}
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

printf '\x89PNG\r\n\x1a\nfakepng' > "$TMP/x.png"
FID=$(curl -s -H "$T" --data-binary @"$TMP/x.png" "$B/api/files?name=x.png" | jq -r .id)
AID=$(curl -s -H "$T" -H "$J" -d "{\"title\":\"T\",\"content\":\"<img src=/f/$FID/x.png>\",\"files\":[\"$FID\"],\"published\":false}" "$B/api/artifacts" | jq -r .id)
PP=$(curl -s -H "$T" "$B/api/files?artifact=$AID" | jq -r '.[0].preview_path')

echo "Visibility"
check "list without auth"                        401 "$(code "$B/api/artifacts")"
check "unpublished artifact /a"                  404 "$(code "$B/a/$AID")"
check "unpublished artifact /raw"                404 "$(code "$B/raw/$AID")"
check "unpublished file, anonymous"              404 "$(code "$B/f/$FID/x.png")"
check "unpublished file, preview token"          200 "$(code "$B$PP")"
check "unpublished file, forged token"           404 "$(code "$B/f/$FID/x.png?pt=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")"
curl -s -H "$T" -H "$J" -X PUT -d '{"published":true}' "$B/api/artifacts/$AID" >/dev/null
check "published file, anonymous"                200 "$(code "$B/f/$FID/x.png")"
check "/static/index.html not served"            404 "$(code "$B/static/index.html")"
check "path traversal /static"                   404 "$(code --path-as-is "$B/static/../src/server.js")"

echo "Login"
check "login: 9 MB body rejected"                413 "$(head -c 9000000 /dev/zero | code -H "$J" -H "Origin: $B" --data-binary @- "$B/api/login")"
check "login: text/plain rejected"               415 "$(code -H "Origin: $B" -H 'Content-Type: text/plain' -d "{\"token\":\"$TOK\"}" "$B/api/login")"
check "login: missing Origin rejected"           403 "$(code -H "$J" -d "{\"token\":\"$TOK\"}" "$B/api/login")"
check "login: ok"                                200 "$(code -c "$TMP/cj" -H "$J" -H "Origin: $B" -d "{\"token\":\"$TOK\"}" "$B/api/login")"
SID=$(awk '/as_session/{print $6 "=" $7}' "$TMP/cj")   # name differs: __Host-as_session over https

echo "Session / CSRF"
check "cookie: read"                             200 "$(code -b "$TMP/cj" "$B/api/artifacts")"
check "cookie+Basic auth+foreign Origin"         401 "$(code -b "$TMP/cj" -H 'Authorization: Basic Zm9vOmJhcg==' -H 'Origin: https://evil.test' -H "$J" -d '{"content":"x"}' "$B/api/artifacts")"
check "cookie: foreign Origin"                   403 "$(code -b "$TMP/cj" -H 'Origin: https://evil.test' -H "$J" -d '{"content":"x"}' "$B/api/artifacts")"
check "cookie: Sec-Fetch-Site same-site"         403 "$(code -b "$TMP/cj" -H "Origin: $B" -H 'Sec-Fetch-Site: same-site' -H "$J" -d '{"content":"x"}' "$B/api/artifacts")"
check "cookie: text/plain write"                 415 "$(code -b "$TMP/cj" -H "Origin: $B" -H 'Content-Type: text/plain' -d '{"content":"x"}' "$B/api/artifacts")"
XID=$(curl -s -b "$TMP/cj" -H "Origin: $B" -H 'Sec-Fetch-Site: same-origin' -H "$J" -d '{"title":"smoke","content":"x"}' "$B/api/artifacts" | jq -r '.id // empty')
check "cookie: same-origin write"                1   "$([ -n "$XID" ] && echo 1 || echo 0)"
check "malformed cookie does not 500"            200 "$(code -H 'Cookie: x=%E0; as_session=%E0' "$B/api/me")"
check "session cookie works before logout"           200 "$(code -H "Cookie: $SID" "$B/api/artifacts")"
curl -s -o /dev/null -b "$TMP/cj" -H "Origin: $B" -X POST "$B/api/logout"
check "old session id after logout"             401 "$(code -H "Cookie: $SID" "$B/api/artifacts")"

echo "Injection"
check "Host header not reflected into script"    0   "$(curl -s -H 'Host: x"><script>alert(1)</script>' "$B/a/$AID" | grep -c '<script>alert')"

echo "Headers"
check "raw: CSP sandbox"                         1   "$(curl -sI "$B/raw/$AID" | grep -ci 'content-security-policy:.*sandbox allow-scripts')"
check "raw: no allow-same-origin"                0   "$(curl -sI "$B/raw/$AID" | grep -ci 'allow-same-origin')"
check "admin: frame-ancestors none"              1   "$(curl -s -D - -o /dev/null "$B/" | grep -ci "frame-ancestors 'none'")"
check "file: CSP sandbox"                        1   "$(curl -sI "$B/f/$FID/x.png" | grep -ci 'content-security-policy:.*sandbox')"

# Clean up before the brute-force check: afterwards this client is throttled for a minute.
curl -s -o /dev/null -H "$T" -X DELETE "$B/api/artifacts/$AID"
[ -n "${XID:-}" ] && curl -s -o /dev/null -H "$T" -X DELETE "$B/api/artifacts/$XID"
check "test artifacts cleaned up"                 404 "$(code "$B/a/$AID")"

echo "Brute force"
for _ in $(seq 1 11); do c=$(code -H 'Authorization: Bearer wrong' "$B/api/artifacts"); done
check "bearer guessing throttled"                429 "$c"

echo; echo "$pass passed, $failn failed"
[ "$failn" -eq 0 ]
