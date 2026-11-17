/**
 * Takes the pass's pictures: every section and the whole page at four widths in Soft light and dark; the other six
 * looks, reduced motion, scripts off, keyboard focus and the replay chapters at 390 and 1440 px; and the 404, privacy and
 * notices pages. A section the page lacks is recorded and skipped.
 *
 * @module @delorun/website/review/capture
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Browser, Page } from './browser.ts'
import { DEFAULT_LOOK, OTHER_LOOKS, PAIR_WIDTHS, pictureName, SCHEMES, SECTIONS, WIDTHS, type PictureSpec, type Scheme } from './naming.ts'
import { findSections, missing, open, url, wakeLazySections, type Rect } from './page-tools.ts'
import type { Finding } from './report.ts'

/** What the pictures pass learned. */
export interface CaptureResult {
  readonly pictures: string[]
  readonly missingSections: Set<string>
  readonly findings: Finding[]
}

/** Writes pictures into a folder and remembers their names. */
export class Shooter {
  readonly pictures: string[] = []
  private readonly folder: string

  constructor(folder: string) {
    this.folder = folder
    mkdirSync(folder, { recursive: true })
  }

  /**
   * Saves a picture of a rectangle of the full page, or of the whole page.
   * @param page - the page.
   * @param spec - what the picture shows.
   * @param clip - the rectangle; omit for the whole page.
   */
  async full(page: Page, spec: PictureSpec, clip?: Rect): Promise<void> {
    const name = pictureName(spec)
    if (clip !== undefined && (clip.height < 2 || clip.width < 2)) return
    await page.screenshot({ path: join(this.folder, name), fullPage: true, ...(clip === undefined ? {} : { clip }) })
    this.pictures.push(name)
  }

  /**
   * Saves a picture of what the window shows now.
   * @param page - the page.
   * @param spec - what the picture shows.
   */
  async viewport(page: Page, spec: PictureSpec): Promise<void> {
    const name = pictureName(spec)
    await page.screenshot({ path: join(this.folder, name) })
    this.pictures.push(name)
  }
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** Opens the home page and waits until it is ready to be photographed. */
async function openHome(browser: Browser, base: string, width: number, scheme: Scheme, look: string, extra: { reducedMotion?: boolean; scriptsOff?: boolean } = {}) {
  const session = await open(browser, { width, scheme, phone: width <= 480, ...extra }, `${String(width)} ${look} ${scheme}${extra.scriptsOff === true ? ' scripts off' : ''}${extra.reducedMotion === true ? ' reduced motion' : ''}`)
  const target = look === DEFAULT_LOOK ? url(base, '/') : url(base, '/', { look, scheme })
  await session.page.goto(target, { waitUntil: 'load' })
  await session.page.waitForTimeout(600)
  if (extra.scriptsOff !== true) await wakeLazySections(session.page)
  return session
}

/**
 * Takes every picture of the pass.
 * @param browser - the browser.
 * @param base - the server's origin.
 * @param folder - the pass folder.
 * @returns the pictures, the sections the page lacked and the findings the pages produced.
 */
export async function capture(browser: Browser, base: string, folder: string): Promise<CaptureResult> {
  const shooter = new Shooter(folder)
  const missingSections = new Set<string>()
  const findings: Finding[] = []
  const spec = (width: number, scheme: Scheme, section: string, look = DEFAULT_LOOK, state: PictureSpec['state'] = 'default'): PictureSpec => ({ page: 'home', section, width, look, scheme, state })

  // The full set: whole page and each section, four widths, Soft light and dark.
  for (const width of WIDTHS) {
    for (const scheme of SCHEMES) {
      const { context, page, findings: seen } = await openHome(browser, base, width, scheme, DEFAULT_LOOK)
      const sections = await findSections(page)
      for (const key of missing(sections)) missingSections.add(key)
      await shooter.full(page, spec(width, scheme, 'page'))
      for (const { key } of SECTIONS) {
        const rect = sections[key]
        if (rect) await shooter.full(page, spec(width, scheme, key), rect)
      }
      findings.push(...seen)
      await context.close()
    }
  }

  // The other six looks, light and dark: the hero and the setup strip.
  for (const width of PAIR_WIDTHS) {
    for (const look of OTHER_LOOKS) {
      for (const scheme of SCHEMES) {
        const { context, page, findings: seen } = await openHome(browser, base, width, scheme, look)
        const sections = await findSections(page)
        for (const key of ['hero', 'make-it-yours'] as const) {
          const rect = sections[key]
          if (rect) await shooter.full(page, spec(width, scheme, key, look), rect)
        }
        findings.push(...seen)
        await context.close()
      }
    }
  }

  // Reduced motion and scripts off: the whole page and the hero.
  for (const width of PAIR_WIDTHS) {
    for (const [state, extra] of [['reduced-motion', { reducedMotion: true }], ['scripts-off', { scriptsOff: true }]] as const) {
      const { context, page, findings: seen } = await openHome(browser, base, width, 'light', DEFAULT_LOOK, extra)
      const sections = await findSections(page)
      await shooter.full(page, spec(width, 'light', 'page', DEFAULT_LOOK, state))
      if (sections['hero']) await shooter.full(page, spec(width, 'light', 'hero', DEFAULT_LOOK, state), sections['hero'])
      findings.push(...seen)
      await context.close()
    }
  }

  // Keyboard focus: one picture of the window for each stop.
  for (const width of PAIR_WIDTHS) {
    const { context, page, findings: seen } = await openHome(browser, base, width, 'light', DEFAULT_LOOK)
    for (let stop = 1; stop <= MAX_STOPS; stop++) {
      await page.keyboard.press('Tab')
      await page.waitForTimeout(150)
      const left = await page.evaluate(() => document.activeElement === null || document.activeElement === document.body)
      if (left) break
      await shooter.viewport(page, spec(width, 'light', 'page', DEFAULT_LOOK, `k-${pad(stop)}`))
    }
    findings.push(...seen)
    await context.close()
  }

  // The replays at up to three chapters of each session.
  for (const width of PAIR_WIDTHS) {
    const { context, page, findings: seen } = await openHome(browser, base, width, 'light', DEFAULT_LOOK)
    const sections = await findSections(page)
    const rect = sections['replays']
    if (rect) {
      const count = await page.evaluate(({ top, bottom }) => {
        const inside = [...document.querySelectorAll<HTMLElement>('[data-chapter], [role="tab"]')].filter(element => element.getBoundingClientRect().top + scrollY >= top && element.getBoundingClientRect().top + scrollY <= bottom)
        inside.forEach((element, index) => { element.setAttribute('data-qa-chapter', String(index)) })
        return inside.length
      }, { top: rect.y, bottom: rect.y + rect.height })
      for (let index = 0; index < Math.min(count, CHAPTERS_PER_SESSION * MAX_SESSIONS); index++) {
        await page.locator(`[data-qa-chapter="${String(index)}"]`).first().click({ timeout: 3000 }).catch(() => undefined)
        await page.waitForTimeout(700)
        const now = (await findSections(page))['replays']
        if (now) await shooter.full(page, spec(width, 'light', 'replays', DEFAULT_LOOK, `chapter-${pad(index + 1)}`), now)
      }
    }
    findings.push(...seen)
    await context.close()
  }

  // The other pages.
  for (const [name, path] of [['404', '/__qa-missing'], ['privacy', '/privacy'], ['notices', '/notices']] as const) {
    for (const width of PAIR_WIDTHS) {
      for (const scheme of SCHEMES) {
        const session = await open(browser, { width, scheme, phone: width <= 480 }, `${name} ${String(width)}`, name === '404')
        await session.page.goto(url(base, path), { waitUntil: 'load' })
        await session.page.waitForTimeout(500)
        await shooter.full(session.page, { page: name, section: 'page', width, look: DEFAULT_LOOK, scheme, state: 'default' })
        findings.push(...session.findings)
        await session.context.close()
      }
    }
  }

  return { pictures: shooter.pictures, missingSections, findings }
}

/** The most focus stops pictured at one width. */
export const MAX_STOPS = 40
/** Chapters pictured per session. */
export const CHAPTERS_PER_SESSION = 3
/** Sessions the replays hold. */
export const MAX_SESSIONS = 5
