/**
 * Helpers the pictures, the audit and the worst cases share: opening a page in a context that records console errors and
 * failed requests, finding the home page's sections by landmark, and waiting for lazy sections to arrive.
 *
 * @module @delorun/website/review/page-tools
 */
import type { Browser, BrowserContext, Page } from './browser.ts'
import { SECTIONS, type SectionKey } from './naming.ts'
import type { Finding } from './report.ts'

/** Where a section sits on the full page, in CSS pixels. */
export interface Rect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

/** The options for one context. */
export interface ContextOptions {
  readonly width: number
  readonly height?: number
  readonly scheme: 'light' | 'dark'
  readonly reducedMotion?: boolean
  readonly scriptsOff?: boolean
  /** The phone profile: touch, device scale 2. */
  readonly phone?: boolean
}

/** A context with the findings recorded while it is open. */
export interface Session {
  readonly context: BrowserContext
  readonly page: Page
  readonly findings: Finding[]
}

/** The viewport height used for a width: tall enough for one screen of a phone, a laptop and a desktop. */
export function viewportHeight(width: number): number {
  return width <= 480 ? 844 : width >= 1920 ? 1080 : 900
}

/**
 * Opens a page in a fresh context.
 * @param browser - the browser.
 * @param options - the viewport and preferences.
 * @param tag - the label recorded in findings.
 * @param expect404 - true when the page is a 404 on purpose.
 * @returns the context, page and the findings list the page fills.
 */
export async function open(browser: Browser, options: ContextOptions, tag: string, expect404 = false): Promise<Session> {
  const context = await browser.newContext({
    viewport: { width: options.width, height: options.height ?? viewportHeight(options.width) },
    colorScheme: options.scheme,
    reducedMotion: options.reducedMotion === true ? 'reduce' : 'no-preference',
    javaScriptEnabled: options.scriptsOff !== true,
    ...(options.phone === true ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}),
  })
  const page = await context.newPage()
  const findings: Finding[] = []
  const add = (check: string, message: string): void => {
    // The static server has no Worker, so its /api routes answer 404; that is the server, not the page. With scripts off
    // the browser refuses script files on purpose.
    const apiOnStatic = check === 'request' && /\b404 \S*\/api\//.test(message)
    const blockedScript = options.scriptsOff === true && /\.js\b.*\bcsp$/.test(message)
    if (blockedScript) return
    findings.push({ severity: apiOnStatic ? 'info' : 'fail', check, where: tag, message })
  }
  page.on('console', message => { if (message.type() === 'error' && !(expect404 && /status of 404/.test(message.text()))) add('console', message.text()) })
  page.on('pageerror', error => { add('console', `page error: ${error.message}`) })
  page.on('requestfailed', request => { add('request', `${request.url()} ${request.failure()?.errorText ?? 'failed'}`) })
  page.on('response', response => {
    if (response.status() < 400) return
    if (expect404 && response.status() === 404 && response.request().resourceType() === 'document') return
    add('request', `${String(response.status())} ${response.url()}`)
  })
  return { context, page, findings }
}

/**
 * Scrolls down the page in steps so lazy sections near the screen load, then returns to the top.
 * @param page - the page.
 */
export async function wakeLazySections(page: Page): Promise<void> {
  const height = await page.evaluate(() => document.documentElement.scrollHeight)
  const step = await page.evaluate(() => Math.max(300, Math.floor(innerHeight * 0.7)))
  for (let y = 0; y < height; y += step) {
    await page.evaluate(top => { scrollTo(0, top) }, y)
    await page.waitForTimeout(150)
  }
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined)
  await page.evaluate(() => { scrollTo(0, 0) })
  await page.waitForTimeout(500)
}

/**
 * Finds the home page's sections by landmark, never by a fixed selector, so a layout change does not break the pass.
 * @param page - the loaded home page.
 * @returns each key's rect on the full page, or `null` when the page has no such section.
 */
export async function findSections(page: Page): Promise<Record<string, Rect | null>> {
  const rules = SECTIONS.map(section => ({ key: section.key, find: section.find as string }))
  return page.evaluate((list): Record<string, Rect | null> => {
    const box = (element: Element): Rect => {
      const r = element.getBoundingClientRect()
      return { x: 0, y: Math.round(r.top + scrollY), width: Math.round(document.documentElement.clientWidth), height: Math.round(r.height) }
    }
    const candidates = [...document.querySelectorAll('main > section, main > div > section, body > section, main section')]
    const label = (element: Element): string => {
      const heading = element.querySelector('h1, h2, h3')
      return `${element.id} ${element.getAttribute('aria-label') ?? ''} ${heading?.textContent ?? ''}`.toLowerCase()
    }
    const out: Record<string, Rect | null> = {}
    const found = new Map<string, Element>()
    for (const rule of list) {
      const [kind, arg] = rule.find.split(/:(.*)/s)
      if (kind === 'footer') {
        const footer = document.querySelector('footer')
        if (footer) found.set(rule.key, footer)
      } else if (kind === 'heading') {
        const pattern = new RegExp(arg ?? '', 'i')
        const match = candidates.find(element => pattern.test(label(element)) && ![...found.values()].includes(element))
        if (match) found.set(rule.key, match)
      }
    }
    const anchor = found.get('make-it-yours')
    const top = candidates.filter(element => !candidates.some(other => other !== element && other.contains(element)))
    if (anchor) {
      const index = top.indexOf(anchor)
      if (index > 1) found.set('claims', top[index - 1] as Element)
    }
    const first = top[0]
    for (const rule of list) {
      if (rule.key === 'hero') {
        out['hero'] = first ? { x: 0, y: 0, width: document.documentElement.clientWidth, height: Math.round(first.getBoundingClientRect().bottom + scrollY) } : null
      } else {
        const element = found.get(rule.key)
        out[rule.key] = element ? box(element) : null
      }
    }
    return out
  }, rules)
}

/**
 * The keys of the sections a page lacks.
 * @param sections - the result of {@link findSections}.
 * @returns the missing keys in page order.
 */
export function missing(sections: Record<string, Rect | null>): SectionKey[] {
  return SECTIONS.map(section => section.key).filter(key => sections[key] === null || sections[key] === undefined)
}

/**
 * Makes a home URL.
 * @param base - the server's origin.
 * @param path - the page path.
 * @param look - a look id and scheme to carry in the link; none for the default.
 * @returns the URL.
 */
export function url(base: string, path: string, look?: { readonly look: string; readonly scheme: string }): string {
  const link = new URL(path, base)
  if (look !== undefined) { link.searchParams.set('look', look.look); link.searchParams.set('scheme', look.scheme) }
  return link.toString()
}
