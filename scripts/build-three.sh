#!/bin/bash
# Gera public/vendor/three-vn.min.js — o Three.js enxuto que as cenas 3D usam.
# Só precisa rodar de novo se uma cena passar a usar uma peça nova do Three
# (acrescente em scripts/three-entry.js). O arquivo gerado vai no git.
set -e
cd "$(dirname "$0")/.."
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
VER=${THREE_VERSION:-0.186.1}
( cd "$TMP" && npm init -y >/dev/null && npm install --no-save "three@$VER" esbuild@0.25 >/dev/null )
cp scripts/three-entry.js "$TMP/entry.js"
"$TMP/node_modules/.bin/esbuild" "$TMP/entry.js" --bundle --format=esm --minify \
  --legal-comments=inline --target=es2020 --outfile=public/vendor/three-vn.min.js
echo "ok: public/vendor/three-vn.min.js (three $VER)"
ls -la public/vendor/three-vn.min.js
