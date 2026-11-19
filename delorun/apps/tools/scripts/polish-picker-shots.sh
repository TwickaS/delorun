#!/bin/bash
# Pictures of the composer model picker on the polish preview: closed chip, model list, focused search field.
# Usage: polish-picker-shots.sh <width>x<height> <light|dark> <out-prefix>   e.g. 1440x900 light ~/shots/picker-1440-light
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
source ~/.nvm/nvm.sh >/dev/null
cd "$ROOT" && nvm use >/dev/null
export DELORUN_HOME="${POLISH_HOME:-/tmp/polish-home}"
URL=$(node_modules/.bin/tsx delorun/apps/cli/src/bin.ts open --print 2>&1 | grep -o "http://[^ ]*" | head -1)
SCRIPT="$(mktemp)"
cat >"$SCRIPT" <<JS
await page.waitForTimeout(2500)
if (await page.locator('text=Complete setup later').count() > 0) {
  await page.click('text=Complete setup later')
  await page.waitForTimeout(800)
}
const chip = page.locator('button[aria-haspopup=menu]', { hasText: 'DeepSeek' }).first()
await chip.click({ force: true })
await page.waitForTimeout(600)
await page.screenshot({ path: '$3-1-root.png' })
await page.locator('[role=menuitem]').first().click()
await page.waitForTimeout(600)
await page.screenshot({ path: '$3-2-models.png' })
await page.locator('[role=searchbox]').click()
await page.waitForTimeout(400)
await page.screenshot({ path: '$3-3-search.png' })
JS
nice -n 19 node_modules/.bin/tsx delorun/apps/tools/src/studio-browser.ts run --url "$URL" --viewport "$1" --scheme "$2" --file "$SCRIPT"
rm -f "$SCRIPT"
