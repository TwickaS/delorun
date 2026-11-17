/**
 * The measurements of the pass: overflow, tap targets, hidden text under reduced motion, accessibility violations with
 * contrast ratios, keyboard order and focus visibility, paint and layout shift on the phone profile, the build's weight
 * table and scroll smoothness. Each check records findings; it never edits the page.
 *
 * @module @delorun/website/review/audit
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import type { Browser, Page } from './browser.ts'
import { throttleAsPhone } from './browser.ts'
import { WIDTHS } from './naming.ts'
import { headTags } from './head-tags.ts'
import { open, url, wakeLazySections } from './page-tools.ts'
import { readResources } from './resources.ts'
import type { Finding } from './report.ts'
import { failures, LIMITS, measure } from '../scripts/weight.ts'

/** The widths the overflow and tap-target checks run at: the picture widths and the narrowest supported screen. */
export const AUDIT_WIDTHS = [320, ...WIDTHS] as const

/** How many times the phone-profile paint and scroll are measured; the median is judged. */
export const PHONE_RUNS = 3

/**
 * The median of a list.
 * @param numbers - the values.
 * @returns the middle value, or the mean of the two middle values.
 */
export function median(numbers: readonly number[]): number {
  const sorted = [...numbers].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

/** The largest-paint limit on the phone profile, in milliseconds (plan, "Weight limits"). */
export const LCP_LIMIT_MS = 2500

/** Shift on load above which the page fails. */
export const CLS_LIMIT = 0.1

/** The least tap target side, in CSS pixels (WCAG 2.2 AA, 2.5.8). */
export const TAP_MIN = 24

const fail = (check: string, where: string, message: string): Finding => ({ severity: 'fail', check, where, message })
const warn = (check: string, where: string, message: string): Finding => ({ severity: 'warn', check, where, message })
const info = (check: string, where: string, message: string): Finding => ({ severity: 'info', check, where, message })

/** What the audit found and measured. */
export interface AuditResult {
  readonly findings: Finding[]
  readonly measurements: Record<string, unknown>
}

/**
 * Runs the audit.
 * @param browser - the browser.
 * @param base - the server's origin.
 * @param out - the built `out/` directory, for the weight table.
 * @returns the findings and measurements.
 */
export async function audit(browser: Browser, base: string, out: string): Promise<AuditResult> {
  const findings: Finding[] = []
  const measurements: Record<string, unknown> = {}

  for (const width of AUDIT_WIDTHS) {
    const session = await open(browser, { width, scheme: 'light', phone: width <= 480 }, `${String(width)} px`)
    await session.page.goto(url(base, '/'), { waitUntil: 'load' })
    await session.page.waitForTimeout(500)
    await wakeLazySections(session.page)
    findings.push(...await overflow(session.page, width), ...await tapTargets(session.page, width), ...session.findings)
    await session.context.close()
  }

  const reduced = await open(browser, { width: 1440, scheme: 'light', reducedMotion: true }, 'reduced motion')
  await reduced.page.goto(url(base, '/'), { waitUntil: 'load' })
  await wakeLazySections(reduced.page)
  findings.push(...await hiddenText(reduced.page), ...reduced.findings)
  await reduced.context.close()

  findings.push(...await axeChecks(browser, base))

  for (const width of [1440, 390]) {
    const session = await open(browser, { width, scheme: 'light', phone: width <= 480 }, `keyboard ${String(width)} px`)
    await session.page.goto(url(base, '/'), { waitUntil: 'load' })
    await session.page.waitForTimeout(800)
    const result = await keyboard(session.page, width)
    findings.push(...result.findings)
    measurements[`tabOrder${String(width)}`] = result.stops
    await session.context.close()
  }

  const vitalRuns = []
  const rates: Array<{ fps: number; worstFrameMs: number }> = []
  for (let run = 0; run < PHONE_RUNS; run++) {
    vitalRuns.push(await phoneVitals(browser, base))
    const session = await open(browser, { width: 390, scheme: 'light', phone: true }, 'phone scroll')
    await throttleAsPhone(session.context, session.page)
    await session.page.goto(url(base, '/'), { waitUntil: 'load', timeout: 60000 })
    await session.page.waitForTimeout(1500)
    rates.push(await frameRate(session.page))
    await session.context.close()
  }
  const paints = vitalRuns.map(run => Number((run.measurements as { largestPaintMs: number | null }).largestPaintMs ?? 0))
  const middle = vitalRuns[paints.indexOf(median(paints))] ?? vitalRuns[0]
  const fps = rates.map(rate => rate.fps)
  if (middle !== undefined) {
    findings.push(...middle.findings)
    measurements['phone'] = { ...middle.measurements, runs: { largestPaintMs: paints, medianLargestPaintMs: median(paints), scrollFps: fps, medianScrollFps: median(fps), worstFrameMs: rates.map(rate => rate.worstFrameMs), freeMemoryGbAfter: Math.round(readResources().memoryGb * 10) / 10 } }
  }

  const desktop = await open(browser, { width: 1440, scheme: 'light' }, 'scroll 1440 px')
  await desktop.page.goto(url(base, '/'), { waitUntil: 'load' })
  await desktop.page.waitForTimeout(1500)
  const desktopRate = await frameRate(desktop.page)
  await desktop.context.close()
  if (median(fps) < 30) findings.push(warn('scroll', '390 px phone profile', `median ${String(median(fps))} frames per second over ${String(PHONE_RUNS)} runs (worst frames ${rates.map(rate => String(rate.worstFrameMs)).join(', ')} ms)`))
  if (desktopRate.fps < 30) findings.push(warn('scroll', '1440 px', `${String(desktopRate.fps)} frames per second while scrolling (worst frame ${String(desktopRate.worstFrameMs)} ms)`))
  measurements['scrollSmoothness'] = { w1440: desktopRate, 'w390-phone-profile': { medianFps: median(fps), runs: rates }, note: 'headless Chromium on a software renderer: a floor, not a measure of real hardware' }

  measurements['serverEncoding'] = await encodings(base, out)
  const head = await headTags(base)
  measurements['headTags'] = head.tags
  findings.push(...head.findings)

  const weights = measure(out)
  measurements['weight'] = { ...weights, limits: LIMITS }
  for (const message of failures(weights)) findings.push(fail('weight', 'build', message))
  return { findings, measurements }
}

async function overflow(page: Page, width: number): Promise<Finding[]> {
  const result = await page.evaluate(() => {
    const wide = document.documentElement.scrollWidth - innerWidth
    const offenders = wide > 1
      ? [...document.querySelectorAll('body *')].filter(element => element.getBoundingClientRect().right > innerWidth + 1).slice(0, 5).map(element => `${element.tagName.toLowerCase()}${typeof element.className === 'string' && element.className !== '' ? `.${element.className.trim().split(/\s+/)[0] ?? ''}` : ''}`)
      : []
    return { wide, offenders }
  })
  return result.wide > 1 ? [fail('overflow', `${String(width)} px`, `the page is ${String(result.wide)} px wider than the window; first offenders: ${result.offenders.join(', ')}`)] : []
}

async function tapTargets(page: Page, width: number): Promise<Finding[]> {
  const small = await page.evaluate((min): string[] => [...document.querySelectorAll<HTMLElement>('a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=tab], [tabindex]:not([tabindex="-1"])')]
    .filter(element => {
      const r = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && (r.width < min || r.height < min)
    })
    .slice(0, 12)
    .map(element => `${(element.innerText || element.getAttribute('aria-label') || element.tagName).trim().replace(/\s+/g, ' ').slice(0, 28)} ${String(Math.round(element.getBoundingClientRect().width))}x${String(Math.round(element.getBoundingClientRect().height))}`), TAP_MIN)
  // Links inside running text are exempt under WCAG 2.5.8; they are listed as warnings for a person to judge.
  return small.map(entry => warn('tap-target', `${String(width)} px`, `under ${String(TAP_MIN)} px: ${entry}`))
}

async function hiddenText(page: Page): Promise<Finding[]> {
  const hidden = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('h1, h2, h3, h4, p, li, a, button, label, span')]
    .filter(element => {
      if (!(element.innerText ?? '').trim()) return false
      const r = element.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) return false
      let opacity = 1
      for (let node: HTMLElement | null = element; node !== null; node = node.parentElement) opacity *= Number.parseFloat(getComputedStyle(node).opacity)
      return opacity < 0.05 || getComputedStyle(element).visibility === 'hidden'
    })
    .slice(0, 10)
    .map(element => (element.innerText ?? '').trim().slice(0, 40)))
  return hidden.map(text => fail('reduced-motion-hidden-text', '1440 px', `text still hidden with reduced motion: "${text}"`))
}

declare global {
  interface Window {
    __qa?: { element: Element; snapshot: () => string }
    __v?: { lcpMs: number | null; element: string | null; cls: number }
    axe?: { run: (context: Document, options: object) => Promise<{ violations: AxeViolation[] }> }
  }
}

interface AxeNode { readonly target: string[]; readonly any: ReadonlyArray<{ readonly data?: { readonly contrastRatio?: number; readonly fgColor?: string; readonly bgColor?: string; readonly expectedContrastRatio?: string } }> }
interface AxeViolation { readonly id: string; readonly impact: string | null; readonly help: string; readonly nodes: AxeNode[] }

async function axeChecks(browser: Browser, base: string): Promise<Finding[]> {
  const findings: Finding[] = []
  let source: string
  try {
    source = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8')
  } catch (error) {
    return [warn('axe', 'build', `axe-core is not installed in the website's dev dependencies, so no accessibility run was made (${error instanceof Error ? error.message : String(error)})`)]
  }
  const cases = [['/', 1440, 'light'], ['/', 1440, 'dark'], ['/', 390, 'light'], ['/', 390, 'dark'], ['/privacy', 1440, 'light'], ['/notices', 1440, 'light'], ['/__qa-missing', 1440, 'light']] as const
  for (const [path, width, scheme] of cases) {
    const where = `${path} ${String(width)} px ${scheme}`
    const session = await open(browser, { width, scheme, reducedMotion: true, phone: width <= 480 }, where, path === '/__qa-missing')
    await session.page.goto(url(base, path), { waitUntil: 'load' })
    await wakeLazySections(session.page)
    await session.page.evaluate(source)
    const violations = await session.page.evaluate(async (): Promise<AxeViolation[]> => {
      const axe = window.axe
      if (axe === undefined) return []
      return (await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } })).violations
    })
    for (const violation of violations) {
      const severe = violation.impact === 'serious' || violation.impact === 'critical'
      const detail = violation.nodes.slice(0, 4).map(node => {
        const data = node.any.find(check => check.data?.contrastRatio !== undefined)?.data
        return data === undefined ? node.target.join(' ') : `${node.target.join(' ')} (${data.fgColor ?? ''} on ${data.bgColor ?? ''}, ${String(data.contrastRatio)}:1, needs ${data.expectedContrastRatio ?? ''})`
      }).join('; ')
      findings.push({ severity: severe ? 'fail' : 'warn', check: 'axe', where, message: `${violation.id} (${violation.impact ?? 'unrated'}, ${String(violation.nodes.length)} nodes): ${violation.help}; ${detail}` })
    }
    findings.push(...session.findings)
    await session.context.close()
  }
  return findings
}

async function keyboard(page: Page, width: number): Promise<{ findings: Finding[]; stops: string[] }> {
  const where = `${String(width)} px`
  const findings: Finding[] = []
  const stops: string[] = []
  let repeats = 0
  let lastIndex = -1
  for (let index = 1; index <= 60; index++) {
    await page.keyboard.press('Tab')
    await page.waitForTimeout(120)
    const stop = await page.evaluate(() => {
      const element = document.activeElement
      if (element === null || element === document.body) return null
      const style = (target: Element, pseudo?: string): string => {
        const cs = getComputedStyle(target, pseudo)
        return [cs.outlineStyle, cs.outlineWidth, cs.outlineColor, cs.boxShadow, cs.backgroundColor, cs.color, cs.textDecorationLine, cs.borderColor, cs.opacity, cs.transform, cs.outlineOffset].join('|')
      }
      const near: Element[] = []
      for (let node: Element | null = element.parentElement; node !== null && near.length < 3; node = node.parentElement) near.push(node)
      const snapshot = (): string => [style(element), style(element, '::before'), style(element, '::after'), ...[...element.children].slice(0, 3).map(child => style(child)), ...near.map(node => style(node)), ...near.map(node => style(node, '::after'))].join('#')
      ;window.__qa = { element, snapshot }
      let alpha = 1
      for (let node: Element | null = element; node !== null; node = node.parentElement) alpha *= Number.parseFloat(getComputedStyle(node).opacity)
      const r = element.getBoundingClientRect()
      const name = ((element as HTMLElement).innerText || element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.getAttribute('name') || element.getAttribute('href') || element.tagName).trim().replace(/\s+/g, ' ').slice(0, 40)
      const index = [...document.querySelectorAll('*')].indexOf(element)
      return { label: `${element.tagName.toLowerCase()} "${name}"`, index, href: element.getAttribute('href'), visible: alpha > 0.1 && r.width > 1 && r.height > 1 && r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight + 2000, snapshot: snapshot() }
    })
    if (stop === null) break
    const blurred = await page.evaluate(async () => {
      const state = window.__qa
      if (state === undefined) return ''
      const target = state.element as HTMLElement
      target.blur()
      await new Promise(done => setTimeout(done, 200))
      const value = state.snapshot()
      target.focus({ preventScroll: true })
      return value
    })
    if (stop.index === lastIndex) repeats += 1
    lastIndex = stop.index
    stops.push(stop.label)
    if (!stop.visible) findings.push(fail('focus-invisible', where, `focus lands on something not visible: ${stop.label}`))
    else if (blurred === stop.snapshot) findings.push(warn('focus-style', where, `no change found in the control, its children or three ancestors; check picture k-${String(index).padStart(2, '0')} (${stop.label})`))
    if (repeats >= 2) { findings.push(fail('focus-trap', where, `focus sticks on ${stop.label}`)); break }
  }
  if (stops.length === 0) findings.push(fail('tab-order', where, 'Tab never reached anything'))
  else if (!/skip|main|content/i.test(stops[0] ?? '')) findings.push(fail('skip-link', where, `the first tab stop is ${stops[0] ?? ''}, not a skip link`))
  return { findings, stops }
}

export async function phoneVitals(browser: Browser, base: string): Promise<{ findings: Finding[]; measurements: Record<string, unknown> }> {
  const session = await open(browser, { width: 390, scheme: 'light', phone: true }, 'phone profile')
  await session.context.addInitScript(() => {
    const store: NonNullable<Window['__v']> = { lcpMs: null, element: null, cls: 0 }
    ;window.__v = store
    const describe = (element: Element | null | undefined): string | null => {
      if (!element) return null
      const chain: string[] = []
      for (let node: Element | null = element; node !== null && chain.length < 6; node = node.parentElement) chain.push(`${node.tagName.toLowerCase()}${node.id !== '' ? `#${node.id}` : ''}${typeof node.className === 'string' && node.className !== '' ? `.${node.className.trim().split(/\s+/)[0] ?? ''}` : ''}`)
      return chain.join(' < ')
    }
    new PerformanceObserver(list => { for (const entry of list.getEntries() as Array<PerformanceEntry & { element?: Element }>) { store.lcpMs = Math.round(entry.startTime); store.element = describe(entry.element) } }).observe({ type: 'largest-contentful-paint', buffered: true })
    new PerformanceObserver(list => { for (const entry of list.getEntries() as Array<PerformanceEntry & { hadRecentInput: boolean; value: number }>) if (!entry.hadRecentInput) store.cls += entry.value }).observe({ type: 'layout-shift', buffered: true })
  })
  await throttleAsPhone(session.context, session.page)
  await session.page.goto(url(base, '/'), { waitUntil: 'load', timeout: 90000 })
  await session.page.waitForTimeout(2500)
  const first = (await session.page.evaluate(() => window.__v)) ?? { lcpMs: null, element: null, cls: 0 }
  await wakeLazySections(session.page)
  const after = await session.page.evaluate(() => window.__v?.cls ?? 0)
  const findings = [...session.findings]
  const measurements = { largestPaintMs: first.lcpMs, largestPaintElement: first.element, layoutShiftOnLoad: Math.round(first.cls * 1000) / 1000, layoutShiftAfterScroll: Math.round(after * 1000) / 1000, profile: 'phone, 4x CPU slowdown, 1.6 Mbit/s, 150 ms' }
  if (first.lcpMs === null) findings.push(warn('largest-paint', 'phone profile', 'no largest paint was recorded'))
  else if (first.lcpMs > LCP_LIMIT_MS) findings.push(fail('largest-paint', 'phone profile', `${String(first.lcpMs)} ms, over ${String(LCP_LIMIT_MS)} ms (${first.element ?? 'unknown element'})`))
  if (first.element !== null && /replica/i.test(first.element)) findings.push(fail('largest-paint', 'phone profile', `the largest paint is inside the replica: ${first.element}`))
  if (after > CLS_LIMIT) findings.push(fail('layout-shift', 'phone profile', `layout shift ${String(Math.round(after * 1000) / 1000)} after scrolling the page, over ${String(CLS_LIMIT)}`))
  else if (first.cls > CLS_LIMIT) findings.push(fail('layout-shift', 'phone profile', `layout shift ${String(Math.round(first.cls * 1000) / 1000)} on load, over ${String(CLS_LIMIT)}`))
  findings.push(info('largest-paint', 'phone profile', `${String(first.lcpMs)} ms, ${first.element ?? 'unknown element'}`))
  await session.context.close()
  return { findings, measurements }
}

export async function frameRate(page: Page): Promise<{ fps: number; worstFrameMs: number }> {
  return page.evaluate(() => new Promise<{ fps: number; worstFrameMs: number }>(done => {
    let frames = 0
    const start = performance.now()
    let last = start
    let worst = 0
    const step = (time: number): void => {
      frames += 1
      worst = Math.max(worst, time - last)
      last = time
      scrollBy(0, 12)
      if (time - start < 2500) requestAnimationFrame(step)
      else done({ fps: Math.round((frames * 1000) / (time - start)), worstFrameMs: Math.round(worst) })
    }
    requestAnimationFrame(step)
  }))
}

/**
 * The encoding the review server sends for the home page and one stylesheet, script and data file, to a browser that
 * accepts brotli.
 * @param base - the server's origin.
 * @param out - the built directory, to find an asset of each kind.
 * @returns the `Content-Encoding` and `Vary` headers by path.
 */
async function encodings(base: string, out: string): Promise<Record<string, { encoding: string | null; vary: string | null }>> {
  const assets = readdirSync(join(out, 'assets'))
  const paths = ['/', ...['.css', '.js', '.json'].map(extension => assets.find(file => file.endsWith(extension))).filter((file): file is string => file !== undefined).map(file => `/assets/${file}`)]
  const result: Record<string, { encoding: string | null; vary: string | null }> = {}
  for (const path of paths) {
    const response = await fetch(new URL(path, base), { headers: { 'accept-encoding': 'br, gzip' } })
    result[path] = { encoding: response.headers.get('content-encoding'), vary: response.headers.get('vary') }
  }
  return result
}
