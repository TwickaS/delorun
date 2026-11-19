/**
 * Starts headless Chromium for the review pass. The tools package owns the Playwright dependency, as for `shots.ts`.
 *
 * @module @delorun/website/review/browser
 */
import { createRequire } from 'node:module'

type Playwright = typeof import('playwright')

/** The Playwright types the review code uses. */
export type Browser = import('playwright').Browser
export type BrowserContext = import('playwright').BrowserContext
export type Page = import('playwright').Page

/**
 * Launches Chromium.
 * @returns the browser; the caller closes it.
 */
export async function launch(): Promise<Browser> {
  const { chromium } = createRequire(new URL('../../tools/package.json', import.meta.url))('playwright') as Playwright
  return chromium.launch()
}

/** A mid-range phone: 4x slower CPU and slow 4G, like Lighthouse's mobile run. */
export const PHONE = { cpuRate: 4, latencyMs: 150, downloadBytesPerSecond: (1.6 * 1024 * 1024) / 8, uploadBytesPerSecond: (750 * 1024) / 8 } as const

/**
 * Applies the phone profile to a page.
 * @param context - the page's context.
 * @param page - the page.
 */
export async function throttleAsPhone(context: BrowserContext, page: Page): Promise<void> {
  const cdp = await context.newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: PHONE.cpuRate })
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: PHONE.latencyMs, downloadThroughput: PHONE.downloadBytesPerSecond, uploadThroughput: PHONE.uploadBytesPerSecond })
}
