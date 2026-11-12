#!/usr/bin/env bash
# Rebuild the two bundled libraries in web/editor/vendor (the site itself has no build step).
#   anthropic-sdk.js   the official Claude SDK, for the assistant
#   basic-pitch.js     Spotify's Basic Pitch note model code with TensorFlow.js, plus its model files
set -euo pipefail
out="$(cd "$(dirname "$0")/.." && pwd)/web/editor/vendor"
work="$(mktemp -d)"; cd "$work"
echo '{"name":"vendor-build","private":true,"type":"module"}' > package.json
npm install --silent --no-audit --no-fund @anthropic-ai/sdk@1.8.0 @spotify/basic-pitch@1.0.1 esbuild
echo 'export { default } from "@anthropic-ai/sdk";' > anthropic.entry.js
echo 'export { BasicPitch, outputToNotesPoly, addPitchBendsToNoteEvents, noteFramesToTime } from "@spotify/basic-pitch";' > pitch.entry.js
mkdir -p "$out/basic-pitch-model"
npx esbuild anthropic.entry.js --bundle --format=esm --platform=browser --minify --legal-comments=none --outfile="$out/anthropic-sdk.js"
npx esbuild pitch.entry.js --bundle --format=esm --platform=browser --minify --legal-comments=none --define:global=globalThis --outfile="$out/basic-pitch.js"
cp node_modules/@spotify/basic-pitch/model/* "$out/basic-pitch-model/"
