#!/bin/bash
# Pictures of the onboarding PIN step on the polish preview: cards, entry, entry with typed digits.
# Usage: polish-pin-shots.sh <width>x<height> <light|dark> <out-prefix>   e.g. 1440x900 light ~/shots/pin-1440-light
# The reach status is answered as "ready" inside the browser only, so the PIN step shows; nothing on the machine changes.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
source ~/.nvm/nvm.sh >/dev/null
cd "$ROOT" && nvm use >/dev/null
export DELORUN_HOME="${POLISH_HOME:-/tmp/polish-home}"
URL=$(node_modules/.bin/tsx delorun/apps/cli/src/bin.ts open --print 2>&1 | grep -o "http://[^ ]*" | head -1)
SCRIPT="$(mktemp)"
cat >"$SCRIPT" <<JS
await page.route('**/delorun/reach/status', route => route.fulfill({ json: { options: [{ state: 'ready' }] } }))
await page.reload()
await page.waitForTimeout(1500)
if (await page.getByRole('dialog').count() === 0) await page.click('text=Finish setup')
for (let i = 0; i < 12; i++) {
  if (await page.locator('[role=radiogroup] >> text=Set a PIN').count() > 0) break
  await page.click("button:has-text('Continue')")
  await page.waitForTimeout(700)
}
await page.waitForTimeout(500)
await page.screenshot({ path: '$3-1-cards.png' })
await page.click("button:has-text('Continue')")
await page.waitForTimeout(500)
await page.screenshot({ path: '$3-2-entry.png' })
await page.getByRole('textbox', { name: 'PIN', exact: true }).fill('824619')
await page.getByRole('textbox', { name: 'Type it again' }).fill('824619')
await page.waitForTimeout(300)
await page.screenshot({ path: '$3-3-typed.png' })
JS
nice -n 19 node_modules/.bin/tsx delorun/apps/tools/src/studio-browser.ts run --url "$URL" --viewport "$1" --scheme "$2" --file "$SCRIPT"
rm -f "$SCRIPT"
