// The feature check for dsh-context: after one reply from the mock model, the `/context` command opens the plugin's
// "Context" view. The body of an async function that receives Playwright's `page`, signed in to the studio with its
// bench workspace; it returns what it saw. Written from the plugin's README and its client code (selectors checked
// against 0.87.0); the plugin's version and cost cells need a real model and the network, so they are not checked.
const newSession = page.getByRole('button', { name: 'New session', exact: true }).first()
if (await newSession.isVisible().catch(() => false)) await newSession.click()
const composer = page.locator('[data-composer-input][contenteditable="true"]').first()
await composer.waitFor({ timeout: 60000 })
await composer.click()
await composer.fill('Hello from the dsh-context exercise')
await page.keyboard.press('Enter')
await page.getByText('Bench mock reply: hello from the mock model.').first().waitFor({ timeout: 90000 })
const jump = page.locator('button.lc-jump[aria-label="View this turn in the Context view"]')
const jumpButtons = await jump.count()
await composer.click()
await composer.fill('/context')
await page.getByText('Context', { exact: true }).first().waitFor({ timeout: 15000 })
await page.keyboard.press('Enter')
const title = page.locator('.lc-modal-title').first()
await title.waitFor({ timeout: 30000 })
return { modalTitle: (await title.textContent()).trim(), jumpButtons }
