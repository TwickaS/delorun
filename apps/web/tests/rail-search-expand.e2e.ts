// Web e2e scenarios on the collapsed rail in the assembled application.
//
// The search control, in the real event order: the rail click flips the
// sidebar wide and mounts WorkspaceBrowser's outside-click dismissal listener
// during its own React dispatch; the same click then keeps bubbling to
// document with the unmounted rail button as its target — outside searchRoot.
// The package-level jsdom test cannot replay that continuation (fireEvent does
// not re-bubble through listeners mounted mid-dispatch), so the guard that
// keeps the gesture alive
// (.agents/notes/archived/bug-fix/2026-08-18-rail-search-outside-click-self-dismissal.md)
// is pinned here, in the assembled application under a real browser click.
//
// The hover peek: the expanded shell laid over the page at the rail's left
// edge. jsdom has no layout, so only the browser proves that the overlay is
// fixed, takes the open column's width, and leaves the frame's track and the
// page content where they were.
//
// Zero model calls: these are pure client layout gestures; the scenarios need
// no session content at all.
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

/** WorkspaceBrowser's rail-search focus delay (EXPAND_SLIDE_MS) plus flush headroom. */
const FOCUS_SETTLE_MS = 600

describe('web e2e: collapsed rail gestures in the assembled application', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('expands the search and lands focus in the input from one rail click', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-rail-search-expand'))
    await page.getByRole('button', { name: 'Collapse sidebar' }).click()
    const railSearch = page.getByRole('button', { name: 'Search sessions' })
    // The wide chrome stays mounted through the 150ms collapse crossfade; the
    // rail control (no aria-expanded) replaces it at settle.
    await expect.poll(async () => railSearch.getAttribute('aria-expanded'), { timeout: 10_000 }).toBeNull()

    // The one real click under test: it must expand the sidebar AND leave the
    // search expanded after its own bubble reaches document.
    await railSearch.click()

    const wideSearch = page.getByRole('button', { name: 'Search sessions' })
    await expect.poll(async () => wideSearch.getAttribute('aria-expanded'), { timeout: 10_000 }).toBe('true')
    const input = page.getByPlaceholder('Search session names')
    await expect.poll(
      async () => input.evaluate(el => document.activeElement === el),
      { timeout: FOCUS_SETTLE_MS + 10_000 },
    ).toBe(true)

    // The guard ends with the gesture: a genuine outside click on an empty
    // query dismisses the expanded search as before.
    await page.getByRole('button', { name: 'New session' }).first().click()
    await expect.poll(async () => wideSearch.getAttribute('aria-expanded'), { timeout: 10_000 }).toBe('false')
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('lifts the collapsed rail into the expanded shell over the page at the left edge', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-sidebar-hover-peek'))
    const collapse = page.getByRole('button', { name: 'Collapse sidebar', exact: true })
    if (await collapse.count() > 0) await collapse.click()
    const frame = page.locator('[class*="frame"]').first()
    await expect.poll(() => frame.getAttribute('data-sidebar-collapsed'), { timeout: 10_000 }).toBe('true')
    const sidebar = page.locator('[data-slot="sidebar"]')
    // Wait for the settle, then read the phase and geometry off the shell root.
    await expect.poll(async () => sidebar.getByRole('button', { name: 'New session', exact: true }).count()).toBe(1)
    const peekPhase = () => sidebar.evaluate(element => element.firstElementChild?.getAttribute('data-sidebar-peek') ?? null)
    const peekBox = () => sidebar.evaluate((element) => {
      const root = element.firstElementChild as HTMLElement
      const rect = root.getBoundingClientRect()
      return {
        position: getComputedStyle(root).position,
        left: Math.round(rect.left),
        width: Math.round(rect.width),
        ariaHidden: root.getAttribute('aria-hidden'),
      }
    })
    const main = page.locator('[data-slot="main"]').locator('..')
    const column = sidebar.locator('..')
    // The frame animates its grid tracks to the rail's width after the collapse settles; measure only once it has.
    await expect.poll(async () => (await column.boundingBox())?.width, { timeout: 10_000 }).toBe(56)
    const mainBefore = await main.boundingBox()
    const columnBefore = await column.boundingBox()
    expect(columnBefore?.width).toBe(56)
    // Nothing of the wide shell is in the page while the rail is at rest.
    expect(await sidebar.getByText('New session', { exact: true }).count()).toBe(0)
    // Dwell on the rail's own surface: x 2 is its left padding, clear of every
    // rail control, so the peek's dwell is not cancelled.
    await page.mouse.move(2, 300)
    await expect.poll(peekPhase, { timeout: 5_000 }).toBe('open')
    expect(await peekBox()).toEqual({ position: 'fixed', left: 0, width: 280, ariaHidden: null })
    // Opened over the rail and the page: the frame's track and the page did not move.
    expect((await column.boundingBox())?.width).toBe(56)
    expect(await main.boundingBox()).toEqual(mainBefore)
    expect(await page.getByRole('button', { name: 'New session', exact: true }).count()).toBe(2)
    // Leaving the panel for the page closes it again.
    await page.mouse.move(700, 400)
    await expect.poll(peekPhase, { timeout: 5_000 }).toBeNull()
    expect(await main.boundingBox()).toEqual(mainBefore)
    // Reopen, then Escape: the rail is still the collapsed state.
    await page.mouse.move(2, 300)
    await expect.poll(peekPhase, { timeout: 5_000 }).toBe('open')
    await page.keyboard.press('Escape')
    await expect.poll(peekPhase, { timeout: 5_000 }).toBeNull()
    expect(await frame.getAttribute('data-sidebar-collapsed')).toBe('true')
    expect(await sidebar.getByRole('button', { name: 'New session', exact: true }).count()).toBe(1)
    // The rail's own expand control still works after a peek.
    await page.getByRole('button', { name: 'Open sidebar', exact: true }).click()
    await expect.poll(() => frame.getAttribute('data-sidebar-collapsed'), { timeout: 10_000 }).toBeNull()
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)
})
