#!/usr/bin/env bash
# Builds (and smoke-tests) the Linux AppImage + .deb inside a Docker container,
# so a Windows or macOS machine can produce the Linux installers. Run from the
# project folder:
#
#   docker run --rm -v "$PWD:/src:ro" -v "$PWD/dist:/out" node:22-bookworm bash /src/build/linux-in-docker.sh
#
# The sources are copied inside the container, so the host's node_modules
# (built for the host OS) are never touched.
set -euo pipefail

echo "== system libraries Electron needs, and a virtual display for the smoke test"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 xdg-utils libatspi2.0-0 libsecret-1-0 \
  libgbm1 libasound2 xvfb xauth curl file >/dev/null

echo "== copy sources"
mkdir -p /work
tar -C /src --exclude=./node_modules --exclude=./dist --exclude=./recordings --exclude=./uploads \
    --exclude=./sample/.cache --exclude=./sample/clip.wav --exclude=./.env -cf - . | tar -xf - -C /work
# Only the published example run is bundled.
find /work/results -mindepth 1 -maxdepth 1 ! -name '2026-09-28T18-08-58Z' -exec rm -rf {} +

echo "== install (Linux ffmpeg + ngrok binaries) and build"
cd /work
npm ci --no-fund --no-audit --loglevel=error
npx electron-builder --linux --x64 --publish never 2>&1 | grep -v "duplicate dependency"

echo "== smoke test the unpacked app"
BIN=/work/dist/linux-unpacked/transcriber-benchmark
UD=/tmp/tpb-test
xvfb-run -a "$BIN" --no-sandbox --user-data-dir="$UD" > /tmp/app.log 2>&1 &
PORT=""
for _ in $(seq 1 40); do
  PORT=$(grep -o '127.0.0.1:[0-9]*' /tmp/app.log | head -1 | cut -d: -f2 || true)
  [ -n "$PORT" ] && break; sleep 1
done
if [ -z "$PORT" ]; then echo "app did not start:"; tail -30 /tmp/app.log; exit 1; fi
echo "status: $(curl -s http://127.0.0.1:$PORT/api/status)"
echo "runs:   $(curl -s http://127.0.0.1:$PORT/api/runs | head -c 140)…"
echo "page:   HTTP $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/)"
echo "sample: $(curl -s -X POST --max-time 240 http://127.0.0.1:$PORT/api/sample)"
echo "clip:   $(sha256sum $UD/sample/clip.wav | cut -c1-64)"
pkill -f "$BIN" || true

echo "== hand the installers back"
cp -v /work/dist/*.AppImage /work/dist/*.deb /out/
