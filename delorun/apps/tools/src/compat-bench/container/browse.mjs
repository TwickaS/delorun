// Runs inside a bench container: drives the studio in headless Chromium and prints one JSON line.
// `node /opt/bench/browse.mjs <task> --link <sign-in link> [--out /out/shots] [--name x] [--widths 1440,390] ...`
// Tasks: chat, screens, regions, exercise, toggle. Only the studio's own origin may load (every other request is refused).
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'

const [task, ...rest] = process.argv.slice(2)
const flags = {}
for (let i = 0; i < rest.length; i++) if (rest[i].startsWith('--')) flags[rest[i].slice(2)] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : 'true'

const OUT = flags.out ?? '/out/shots'
const WORKSPACE = '/home/bench/workspace'
const STEP_MS = 60_000
mkdirSync(OUT, { recursive: true })

const consoleErrors = []
const shots = []

function print(value) { process.stdout.write(`${JSON.stringify(value)}\n`) }

async function session(width = 1440, height = 900) {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: 'light' })
  const origin = new URL(flags.link).origin
  await context.route('**/*', route => {
    const url = route.request().url()
    return new URL(url).origin === origin || url.startsWith('data:') || url.startsWith('blob:') ? route.continue() : route.abort()
  })
  context.setDefaultTimeout(STEP_MS)
  const page = await context.newPage()
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(`console error: ${message.text().slice(0, 300)}`) })
  page.on('pageerror', error => { consoleErrors.push(`pageerror: ${String(error.message).slice(0, 300)}`) })
  return { browser, context, page, origin }
}

/** Sign in, dismiss first-use dialogs, make sure a workspace exists. */
async function openStudio(page, origin) {
  await page.goto(flags.link)
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined)
  await dismissDialogs(page)
  await ensureWorkspace(page, origin)
}

async function dismissDialogs(page) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const dialog = page.getByRole('dialog').first()
    if (!await dialog.isVisible().catch(() => false)) return
    const name = (await dialog.getAttribute('aria-label').catch(() => null)) ?? ''
    const button = dialog.getByRole('button', { name: /^(Continue|OK|Got it|Close|Finish later|Dismiss|Skip)$/i }).first()
    if (await button.isVisible().catch(() => false)) { await button.click(); await page.waitForTimeout(400) } else if (/settings/i.test(name)) return
    else { await page.keyboard.press('Escape'); await page.waitForTimeout(300) }
  }
}

/** Create the bench workspace through the studio's own API, with the browser's session, then reload. */
async function ensureWorkspace(page, origin) {
  const answer = await page.evaluate(async (path) => {
    const response = await fetch('/api/workspace/create', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'workspace/create', payload: { args: { request: { path } } } }),
    })
    return { status: response.status, text: (await response.text()).slice(0, 300) }
  }, WORKSPACE)
  if (answer.status >= 400) consoleErrors.push(`bench: workspace/create answered ${answer.status}: ${answer.text}`)
  await page.goto(origin + '/')
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined)
  await dismissDialogs(page)
}

async function shot(page, name) {
  await page.waitForTimeout(800)
  const file = join(OUT, `${name}.png`)
  await page.screenshot({ path: file })
  shots.push(`shots/${name}.png`)
}

async function openSettings(page) {
  const opener = page.getByRole('button', { name: /^Open sidebar$/ }).first()
  if (!await page.getByRole('button', { name: 'Account menu', exact: true }).first().isVisible().catch(() => false) && await opener.isVisible().catch(() => false)) await opener.click()
  const direct = page.getByRole('button', { name: 'Settings', exact: true }).first()
  if (await direct.isVisible().catch(() => false)) await direct.click()
  else {
    await page.getByRole('button', { name: 'Account menu', exact: true }).first().click()
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).first().click()
  }
  await page.getByRole('dialog').first().waitFor()
}

async function closeSettings(page) {
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
}

const tasks = {
  async chat() {
    const { browser, page, origin } = await session()
    try {
      await openStudio(page, origin)
      const newSession = page.getByRole('button', { name: 'New session', exact: true }).first()
      if (await newSession.isVisible().catch(() => false)) await newSession.click()
      const composer = page.locator('[data-composer-input][contenteditable="true"]').first()
      await composer.waitFor({ timeout: STEP_MS })
      const text = `Hello bench${flags.marker ? ` ${flags.marker}` : ''}`
      await composer.click()
      await composer.fill(text)
      await page.keyboard.press('Enter')
      await page.getByText('Bench mock reply: hello from the mock model.').first().waitFor({ timeout: 90_000 })
      await shot(page, 'chat')
      print({ ok: true, reply: 'Bench mock reply: hello from the mock model.', consoleErrors, shots })
    } catch (error) {
      await shot(page, 'chat-failed').catch(() => undefined)
      print({ ok: false, error: String(error.message).slice(0, 600), consoleErrors, shots })
    } finally { await browser.close() }
  },

  async screens() {
    const widths = (flags.widths ?? '1440,390').split(',').map(Number)
    const name = flags.name ?? 'screens'
    const { browser, page, origin } = await session(widths[0], widths[0] < 600 ? 844 : 900)
    try {
      await openStudio(page, origin)
      const warnings = []
      for (const width of widths) {
        await page.setViewportSize({ width, height: width < 600 ? 844 : 900 })
        await page.goto(origin + '/')
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined)
        await dismissDialogs(page)
        await shot(page, `${name}-home-${width}`)
        try {
          await openSettings(page)
          await shot(page, `${name}-settings-${width}`)
          if (flags.label) {
            const entry = page.getByRole('button', { name: flags.label, exact: true }).first()
            if (await entry.isVisible().catch(() => false)) { await entry.click(); await shot(page, `${name}-plugin-${width}`) } else warnings.push(`the Settings entry "${flags.label}" was not visible at ${width}`)
          }
          await closeSettings(page)
        } catch (error) { warnings.push(`Settings did not open at ${width}: ${String(error.message).slice(0, 200)}`) }
      }
      print({ ok: true, shots, consoleErrors, warnings })
    } catch (error) {
      print({ ok: false, error: String(error.message).slice(0, 600), consoleErrors, shots })
    } finally { await browser.close() }
  },

  async regions() {
    const { browser, page, origin } = await session()
    try {
      await openStudio(page, origin)
      const sidebar = await page.evaluate(() => [...document.querySelectorAll('nav[aria-label="Global panels"] button, nav[aria-label="Global panels"] a')].map(el => (el.getAttribute('aria-label') ?? el.textContent ?? '').trim()).filter(label => label !== '' && !/^(Un)?pin /i.test(label)))
      const theme = await page.evaluate(() => {
        const names = new Set()
        for (const sheet of document.styleSheets) {
          let rules
          try { rules = sheet.cssRules } catch { continue }
          for (const rule of rules) {
            if (!rule.style || !/^(:root|html|body)\b/.test(rule.selectorText ?? '')) continue
            for (const prop of rule.style) if (prop.startsWith('--')) names.add(prop)
          }
        }
        const style = getComputedStyle(document.body)
        return Object.fromEntries([...names].sort().map(name => [name, style.getPropertyValue(name).trim()]))
      })
      await openSettings(page)
      const settings = await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] [role="group"][aria-label]')].map(group => ({ group: group.getAttribute('aria-label'), items: [...group.querySelectorAll('button')].map(button => (button.textContent ?? '').trim()).filter(Boolean) })))
      print({ ok: true, regions: { sidebar, theme, settings }, consoleErrors })
    } catch (error) {
      print({ ok: false, error: String(error.message).slice(0, 600), consoleErrors })
    } finally { await browser.close() }
  },

  async exercise() {
    const { browser, page, origin } = await session()
    try {
      await openStudio(page, origin)
      const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor
      const run = new AsyncFunction('page', readFileSync(flags.file, 'utf8'))
      const returned = await run(page)
      await shot(page, 'exercise')
      print({ ok: true, returned: returned === undefined ? '' : JSON.stringify(returned), consoleErrors, shots })
    } catch (error) {
      await shot(page, 'exercise-failed').catch(() => undefined)
      print({ ok: false, error: String(error.message).slice(0, 800), consoleErrors, shots })
    } finally { await browser.close() }
  },

  async toggle() {
    const { browser, page, origin } = await session()
    try {
      await openStudio(page, origin)
      await page.getByRole('button', { name: 'Plugins', exact: true }).first().click()
      const row = page.locator(`[data-plugin-package="${flags.package}"]`).first()
      await row.waitFor({ timeout: 30_000 }).catch(() => { throw new Error(`the Plugins panel does not list ${flags.package}`) })
      const toggle = row.locator('[role="switch"]').first()
      const before = await toggle.getAttribute('aria-checked')
      await toggle.click()
      await page.waitForFunction(([selector, was]) => document.querySelector(selector)?.getAttribute('aria-checked') !== was, [`[data-plugin-package="${flags.package}"] [role="switch"]`, before], { timeout: 30_000 })
      await toggle.click()
      await page.waitForFunction(([selector, was]) => document.querySelector(selector)?.getAttribute('aria-checked') === was, [`[data-plugin-package="${flags.package}"] [role="switch"]`, before], { timeout: 30_000 })
      print({ ok: true, consoleErrors })
    } catch (error) {
      await shot(page, 'toggle-failed').catch(() => undefined)
      print({ ok: false, error: String(error.message).slice(0, 600), consoleErrors, shots })
    } finally { await browser.close() }
  },
}

if (!tasks[task]) { print({ ok: false, error: `unknown task ${task}` }); process.exit(2) }
await tasks[task]()
