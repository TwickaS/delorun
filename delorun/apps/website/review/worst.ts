/**
 * The worst cases: the longest plugin name and sentence, a release with no headlines, a failed copy, a refused sign-up, an
 * unknown look in the link, and a very narrow and a very wide screen. Each is a picture; the data cases also check for
 * sideways overflow. The cases change the page in the browser only, never in the repository.
 *
 * @module @delorun/website/review/worst
 */
import type { Browser, Page } from './browser.ts'
import type { Shooter } from './capture.ts'
import { DEFAULT_LOOK, type PictureSpec } from './naming.ts'
import { findSections, open, url, wakeLazySections } from './page-tools.ts'
import type { Finding } from './report.ts'

/** A long plugin name with no space to break at, and a long sentence. */
export const LONG_NAME = 'Extraordinarily-Long-Plugin-Name-That-Never-Breaks-At-A-Space-Anywhere-123456789'
export const LONG_SENTENCE = 'This sentence runs on far longer than any real description, with several clauses, a parenthetical aside (kept open on purpose), and a final thought that keeps going until the line has wrapped many times over in even the widest column.'

const spec = (section: string, width: number, scheme: 'light' | 'dark' = 'light'): PictureSpec => ({ page: 'worst', section, width, look: DEFAULT_LOOK, scheme, state: 'default' })

async function sideways(page: Page, where: string): Promise<Finding[]> {
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
  return wide > 1 ? [{ severity: 'fail', check: 'worst-case-overflow', where, message: `${String(wide)} px wider than the window` }] : []
}

/**
 * Takes the worst-case pictures.
 * @param browser - the browser.
 * @param base - the server's origin.
 * @param shooter - the picture writer shared with the rest of the pass.
 * @returns findings, including notes on cases that could not be set up on this page.
 */
export async function worstCases(browser: Browser, base: string, shooter: Shooter): Promise<Finding[]> {
  const findings: Finding[] = []
  const note = (where: string, message: string): void => { findings.push({ severity: 'info', check: 'worst-case', where, message }) }

  for (const width of [390, 1440]) {
    // The longest plugin name and sentence, put into the first row of the plugin browser.
    const long = await open(browser, { width, scheme: 'light', phone: width <= 480 }, `worst plugin ${String(width)}`)
    await long.page.goto(url(base, '/'), { waitUntil: 'load' })
    await wakeLazySections(long.page)
    const sections = await findSections(long.page)
    const rect = sections['plugins']
    if (rect) {
      const changed = await long.page.evaluate(({ top, bottom, name, sentence }) => {
        const row = [...document.querySelectorAll<HTMLElement>('[role="option"], [role="row"], li')].find(element => {
          const y = element.getBoundingClientRect().top + scrollY
          return y >= top && y <= bottom && (element.textContent ?? '').trim().length > 0
        })
        if (!row) return false
        const leaves = [...row.querySelectorAll<HTMLElement>('*')].filter(element => element.children.length === 0 && (element.textContent ?? '').trim().length > 0)
        leaves.forEach((leaf, index) => { leaf.textContent = index === 0 ? name : sentence })
        return leaves.length > 0
      }, { top: rect.y, bottom: rect.y + rect.height, name: LONG_NAME, sentence: LONG_SENTENCE })
      if (changed) {
        const now = (await findSections(long.page))['plugins'] ?? rect
        await shooter.full(long.page, spec('longest-plugin', width), now)
        findings.push(...await sideways(long.page, `longest plugin ${String(width)} px`))
      } else note(`longest plugin ${String(width)} px`, 'no row found in the plugin browser to fill')
    } else note(`longest plugin ${String(width)} px`, 'the page has no plugin browser section')
    findings.push(...long.findings)
    await long.context.close()

    // A release with no headlines: the list in What's new emptied.
    const bare = await open(browser, { width, scheme: 'light', phone: width <= 480 }, `worst no headlines ${String(width)}`)
    await bare.page.goto(url(base, '/'), { waitUntil: 'load' })
    await wakeLazySections(bare.page)
    const whats = (await findSections(bare.page))['whats-new']
    if (whats) {
      await bare.page.evaluate(({ top, bottom }) => {
        for (const element of document.querySelectorAll<HTMLElement>('main li, main article')) {
          const y = element.getBoundingClientRect().top + scrollY
          if (y >= top && y <= bottom) element.remove()
        }
      }, { top: whats.y, bottom: whats.y + whats.height })
      const now = (await findSections(bare.page))['whats-new'] ?? whats
      await shooter.full(bare.page, spec('no-headlines', width), now)
    } else note(`no headlines ${String(width)} px`, "the page has no What's new section")
    findings.push(...bare.findings)
    await bare.context.close()

    // A failed copy: the clipboard refuses.
    const copy = await open(browser, { width, scheme: 'light', phone: width <= 480 }, `worst failed copy ${String(width)}`)
    await copy.context.addInitScript(() => {
      const refuse = (): Promise<never> => Promise.reject(new DOMException('Write permission denied.', 'NotAllowedError'))
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: refuse, readText: refuse }, configurable: true })
      document.execCommand = () => false
    })
    await copy.page.goto(url(base, '/'), { waitUntil: 'load' })
    await copy.page.waitForTimeout(800)
    const button = copy.page.getByRole('button', { name: /copy/i }).first()
    if (await button.count() > 0) {
      await button.click({ timeout: 3000 }).catch(() => undefined)
      await copy.page.waitForTimeout(600)
      await shooter.viewport(copy.page, spec('failed-copy', width))
    } else note(`failed copy ${String(width)} px`, 'no copy button found')
    // The refusal is the case under test, so its console and request noise is not a finding.
    await copy.context.close()

    // A refused sign-up: every write request is refused.
    const refused = await open(browser, { width, scheme: 'light', phone: width <= 480 }, `worst refused sign-up ${String(width)}`)
    await refused.context.route('**/*', route => {
      if (route.request().method() === 'GET' || route.request().method() === 'HEAD') return route.fallback()
      return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"refused"}' })
    })
    await refused.page.goto(url(base, '/'), { waitUntil: 'load' })
    await wakeLazySections(refused.page)
    const email = refused.page.locator('input[type="email"]').first()
    if (await email.count() > 0) {
      await email.fill('someone@example.org').catch(() => undefined)
      for (const box of await refused.page.locator('form input[type="checkbox"]').all()) await box.check({ timeout: 1000 }).catch(() => undefined)
      await refused.page.locator('form button[type="submit"], form button:not([type])').first().click({ timeout: 3000 }).catch(() => undefined)
      await refused.page.waitForTimeout(1200)
      const sign = (await findSections(refused.page))['sign-up']
      if (sign) await shooter.full(refused.page, spec('refused-sign-up', width), sign)
      else await shooter.viewport(refused.page, spec('refused-sign-up', width))
    } else note(`refused sign-up ${String(width)} px`, 'no email field found')
    await refused.context.close()
  }

  // An unknown look in the link: it must fall back to the default and say nothing wrong.
  for (const width of [390, 1440]) {
    const odd = await open(browser, { width, scheme: 'light', phone: width <= 480 }, `worst unknown look ${String(width)}`)
    await odd.page.goto(`${url(base, '/')}?look=not-a-look&scheme=purple&accent=chartreuse&density=huge&contrast=max`, { waitUntil: 'load' })
    await odd.page.waitForTimeout(900)
    const root = await odd.page.evaluate(() => ({ ...document.documentElement.dataset, dark: document.documentElement.classList.contains('dark') }))
    note(`unknown look ${String(width)} px`, `root attributes after load: ${JSON.stringify(root)}`)
    await shooter.viewport(odd.page, spec('unknown-look', width))
    findings.push(...odd.findings)
    await odd.context.close()
  }

  // Very narrow and very wide, light and dark.
  for (const [width, scheme] of [[320, 'light'], [320, 'dark'], [1920, 'light'], [1920, 'dark']] as const) {
    const edge = await open(browser, { width, scheme, phone: width <= 480 }, `worst ${String(width)} px`)
    await edge.page.goto(url(base, '/'), { waitUntil: 'load' })
    await wakeLazySections(edge.page)
    await shooter.full(edge.page, spec(width < 400 ? 'narrowest' : 'widest', width, scheme))
    findings.push(...await sideways(edge.page, `${String(width)} px`), ...edge.findings)
    await edge.context.close()
  }
  return findings
}
