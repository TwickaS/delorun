#!/bin/sh
# Usage: run.sh <steps.js> <outdir>. Signs in with a fresh one-time link, runs the steps (which may use shot(name)), decodes the shots.
# Needs DELORUN_HOME and STUDIO_URL; run from the repository root.
set -e
link=$(node delorun/apps/cli/src/bin.ts open --print 2>&1 | grep '^http')
{
  cat <<EOF
const out = {}
const shot = async (name, quality = 30) => {
  const buf = await page.screenshot({ type: 'jpeg', quality })
  out[name] = buf.toString('base64').match(/.{1,3000}/g)
}
await page.goto('$STUDIO_URL/')
await page.evaluate((l) => { location.href = l }, '$link')
await page.waitForTimeout(2500)
EOF
  cat "$1"
  echo 'return out'
} > /tmp/rc7tidy-run.js
node_modules/.bin/tsx delorun/apps/tools/src/studio-browser.ts run --url "$STUDIO_URL/" --file /tmp/rc7tidy-run.js --timeout-ms 90000 2>&1 > /tmp/rc7tidy-raw.txt; python3 -I delorun/apps/tools/walk/decode.py "$2" < /tmp/rc7tidy-raw.txt
