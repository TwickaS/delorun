/**
 * Which Chromium-family browser a Playwright launch uses on a computer: the installed Google Chrome, found where
 * Playwright's `chrome` channel looks for it, or Playwright's own downloaded Chromium build. A provider that builds the
 * launch arguments and a setup check that reports a missing download both call {@link launchedBrowser}, so they agree.
 * Node builtins only; nothing is run.
 * @module
 */

import { accessSync } from 'node:fs'
import { win32 } from 'node:path'

/**
 * The browser choices of a Playwright launch: `auto` uses the installed Chrome when one is found and Playwright's
 * Chromium build otherwise; `chrome` and `chromium` always use that one.
 */
export const BROWSER_CHOICES = ['auto', 'chrome', 'chromium'] as const

/** One of {@link BROWSER_CHOICES}. */
export type BrowserChoice = typeof BROWSER_CHOICES[number]

/** The choice a configuration that names none has. */
export const UNSET_BROWSER_CHOICE: BrowserChoice = 'auto'

/** The browser a launch uses: Playwright's `chrome` channel or its own Chromium build. */
export type LaunchedBrowser = 'chrome' | 'chromium'

/** The computer a Chrome lookup reads. */
export interface ChromeChannelHost {
  /** The operating system, as `process.platform`. */
  readonly platform: NodeJS.Platform
  /** The environment variables; only Windows reads them. */
  readonly env: Readonly<Record<string, string | undefined>>
  /**
   * Whether a file exists and is visible to this user; it is not run.
   * @param path - an absolute path.
   * @returns true when it exists.
   */
  exists(path: string): boolean
}

/**
 * The computer this process runs on.
 * @returns its platform and environment, and an existence test that is Playwright's own (`fs.accessSync`).
 */
export function processChromeChannelHost(): ChromeChannelHost {
  return {
    platform: process.platform,
    env: process.env,
    exists(path) {
      try {
        accessSync(path)
        return true
      } catch {
        // Any failed access (absent, unreadable, a missing parent) is the answer "not found", as it is for Playwright.
        return false
      }
    },
  }
}

/** Where Chrome's executable sits under each Windows installation folder. */
const WINDOWS_SUFFIX = '\\Google\\Chrome\\Application\\chrome.exe'

/**
 * Every path Playwright's `chrome` channel tries on a platform, in its order. Linux and macOS have one fixed path.
 * Windows tries Chrome under `LOCALAPPDATA`, `PROGRAMFILES`, `PROGRAMFILES(X86)`, and `Program Files` and
 * `Program Files (x86)` on `HOMEDRIVE`, skipping a variable that is unset or empty. No platform looks on `PATH`.
 * @param host - the platform and environment.
 * @returns the absolute paths; empty on a platform the channel does not support.
 */
export function chromeChannelCandidates(host: Pick<ChromeChannelHost, 'platform' | 'env'>): string[] {
  switch (host.platform) {
    case 'linux': return ['/opt/google/chrome/chrome']
    case 'darwin': return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    case 'win32': {
      const drive = host.env.HOMEDRIVE ?? ''
      const prefixes = [
        host.env.LOCALAPPDATA, host.env.PROGRAMFILES, host.env['PROGRAMFILES(X86)'],
        ...drive === '' ? [] : [`${drive}\\Program Files`, `${drive}\\Program Files (x86)`],
      ]
      return prefixes.flatMap(prefix => prefix === undefined || prefix === '' ? [] : [win32.join(prefix, WINDOWS_SUFFIX)])
    }
    default: return []
  }
}

/**
 * The installed Chrome that Playwright's `chrome` channel launches.
 * @param host - the computer; omission reads this process's.
 * @returns the first candidate that exists, or `undefined` when Chrome is not installed where Playwright looks.
 */
export function chromeChannelExecutable(host: ChromeChannelHost = processChromeChannelHost()): string | undefined {
  return chromeChannelCandidates(host).find(path => host.exists(path))
}

/**
 * The browser a launch with the given choice uses on a computer.
 * @param choice - the configured choice.
 * @param host - the computer; omission reads this process's.
 * @param executable - a browser executable the configuration names for the launch, if it names one.
 * @returns the choice itself for `chrome` and `chromium`; for `auto`, `chromium` when the configuration names its own
 * executable, which runs with Chromium's launch settings, else `chrome` when Chrome is installed where Playwright
 * looks and `chromium` otherwise.
 */
export function launchedBrowser(choice: BrowserChoice, host?: ChromeChannelHost, executable?: string): LaunchedBrowser {
  if (choice !== 'auto') return choice
  if (executable !== undefined) return 'chromium'
  return chromeChannelExecutable(host) === undefined ? 'chromium' : 'chrome'
}

/**
 * Read a browser choice from configuration that this process did not validate, such as another plugin's Loader entry.
 * @param value - the configured value; `undefined` is a configuration that names no choice.
 * @returns the choice, {@link UNSET_BROWSER_CHOICE} for `undefined`.
 * @throws Error when the value is anything else.
 */
export function parseBrowserChoice(value: unknown): BrowserChoice {
  if (value === undefined) return UNSET_BROWSER_CHOICE
  const choice = BROWSER_CHOICES.find(entry => entry === value)
  if (choice === undefined) throw new Error(`browser must be one of ${BROWSER_CHOICES.join(', ')}`)
  return choice
}
