#!/usr/bin/env bash
set -e

cd "$(dirname "$0")/server"

echo "========================================="
echo "  GrabIt Server v3.0"
echo "  http://127.0.0.1:7272"
echo "========================================="

# Check deps
command -v node >/dev/null 2>&1 || { echo "[ERROR] Node.js not found. Install from https://nodejs.org"; exit 1; }
command -v yt-dlp >/dev/null 2>&1 || echo "[WARNING] yt-dlp not found. Install: pip install yt-dlp"
command -v gallery-dl >/dev/null 2>&1 || echo "[WARNING] gallery-dl not found. Install: pip install gallery-dl"

# Install node deps if needed
[ -d node_modules ] || npm install

node index.js
