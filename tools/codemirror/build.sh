#!/bin/bash
# Rebuilds web/vendor/codemirror/codemirror.js from the pinned versions in package.json.
set -eu
cd "$(dirname "$0")"
npm install --no-save --silent
npx esbuild entry.js --bundle --format=esm --minify --legal-comments=eof --outfile=../../web/vendor/codemirror/codemirror.js
rm -rf node_modules
