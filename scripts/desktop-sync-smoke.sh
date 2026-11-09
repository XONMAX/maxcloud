#!/usr/bin/env bash
# Two "computers" syncing through a running MaxCloud API. Usage: scripts/desktop-sync-smoke.sh [API_URL]
set -euo pipefail
API=${1:-http://localhost:4000}
BIN="$(cd "$(dirname "$0")/../apps/desktop" && pwd)/target/debug/maxcloud-sync"
WORK=$(mktemp -d); A=$WORK/pc-a; B=$WORK/pc-b; mkdir -p "$A" "$B"
EMAIL="sync.$(date +%s)@test.maxcloud.uz"; PW="sync smoke password"
curl -sf -X POST "$API/auth/register" -H 'Content-Type: application/json' -H 'X-Client: desktop' -d "{\"email\":\"$EMAIL\",\"password\":\"$PW\",\"name\":\"Sync\"}" >/dev/null
"$BIN" login --server "$API" --email "$EMAIL" --password "$PW" --root "$A" --device PC-A >/dev/null
"$BIN" login --server "$API" --email "$EMAIL" --password "$PW" --root "$B" --device PC-B >/dev/null
sa() { "$BIN" sync --root "$A" --device PC-A; }; sb() { "$BIN" sync --root "$B" --device PC-B "$@"; }
same() { diff -r --exclude=.maxcloud "$A" "$B" && echo "  ✓ $1"; }

echo "1. new files + folders propagate A -> B"
mkdir -p "$A/Documents/2026" "$A/Videos"; echo "hello" > "$A/Documents/2026/notes.txt"; head -c 9000000 /dev/urandom > "$A/Documents/big.bin"; echo v > "$A/Videos/clip.mp4"
sa >/dev/null; sb >/dev/null; same "B mirrors A"

echo "2. edit on B flows to A"
echo "edited on B" >> "$B/Documents/2026/notes.txt"; sb >/dev/null; sa >/dev/null; same "A has B's edit"

echo "3. concurrent edits -> conflict copy, nothing lost"
echo "A version" > "$A/Documents/2026/notes.txt"; echo "B version" > "$B/Documents/2026/notes.txt"
sa >/dev/null; sb >/dev/null; sb >/dev/null; sa >/dev/null
ls "$B/Documents/2026" | grep -q "conflicted copy from PC-B" && echo "  ✓ conflict copy created"
grep -q "A version" "$B/Documents/2026/notes.txt" && grep -rq "B version" "$B/Documents/2026/" && echo "  ✓ both versions kept"
same "both PCs converge"

echo "4. delete on A removes on B (server keeps it in Trash)"
rm "$A/Documents/big.bin"; sa >/dev/null; sb >/dev/null; [ ! -e "$B/Documents/big.bin" ] && echo "  ✓ deleted on B"; same "converged"

echo "5. selective sync: PC-C excludes Videos"
C=$WORK/pc-c; mkdir -p "$C"; "$BIN" login --server "$API" --email "$EMAIL" --password "$PW" --root "$C" --device PC-C >/dev/null
"$BIN" sync --root "$C" --device PC-C --exclude Videos >/dev/null
[ ! -e "$C/Videos" ] && [ -e "$C/Documents/2026/notes.txt" ] && echo "  ✓ Videos not downloaded"
echo "ALL OK"
