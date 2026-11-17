import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { win32 } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { mountSessionMcp } from '@deepseek-ai/dsh-experimental-browser-use-runtime/mcp'
import { chromeChannelCandidates, launchedBrowser } from '@deepseek-ai/dsh-native-command/chrome-channel'
import * as Provider from '../src/index.ts'

const CHROME = '/opt/google/chrome/chrome'
const computer = vi.hoisted(() => ({ chromeInstalled: false }))

// The real choice logic, reading a Linux computer whose Chrome the spec installs or removes.
vi.mock('@deepseek-ai/dsh-native-command/chrome-channel', async (importOriginal) => {
  const original = await importOriginal<typeof import('@deepseek-ai/dsh-native-command/chrome-channel')>()
  return {
    ...original,
    launchedBrowser: vi.fn((choice: Parameters<typeof original.launchedBrowser>[0]) =>
      original.launchedBrowser(choice, { platform: 'linux', env: {}, exists: path => computer.chromeInstalled && path === CHROME })),
  }
})

vi.mock('@deepseek-ai/dsh-experimental-browser-use-runtime/mcp', async importOriginal => ({
  ...await importOriginal<typeof import('@deepseek-ai/dsh-experimental-browser-use-runtime/mcp')>(),
  mountSessionMcp: vi.fn(),
}))
afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})

/** The server arguments, after the CLI path, that a configuration starts on a computer with or without Chrome installed. */
function launchArgs(config: Parameters<typeof Provider.Config>[0], chromeInstalled: boolean): string[] {
  computer.chromeInstalled = chromeInstalled
  Provider.apply(new Context(), Provider.Config(config))
  return vi.mocked(mountSessionMcp).mock.calls.at(-1)![1].args.slice(1)
}

it('uses the pinned Playwright executable with isolated Chromium launch settings', () => {
  vi.stubEnv('PLAYWRIGHT_MCP_CDP_ENDPOINT', 'http://invalid.example:1')
  Provider.apply(new Context(), Provider.Config({ mode: 'launch', executablePath: '/custom/chromium', toolCallTimeoutMs: 123 }))
  const options = vi.mocked(mountSessionMcp).mock.calls[0]![1]
  expect(existsSync(options.args[0]!)).toBe(true)
  expect(options).toMatchObject({ name: 'playwright-mcp', exclusive: false, command: process.execPath, toolCallTimeoutMs: 123, outputFolder: '.playwright-mcp' })
  expect(options.env?.PLAYWRIGHT_MCP_CDP_ENDPOINT).toBe('')
  expect(options.args.slice(1)).toEqual(['--browser', 'chromium', '--isolated', '--headless', '--executable-path', '/custom/chromium'])
  expect(options.args).toHaveLength(7)
  expect('default' in Provider).toBe(false)
})

it('supports headed launch and attaches without launching a browser or creating a profile', () => {
  expect(launchArgs({ mode: 'launch', headless: false }, false)).toEqual(['--browser', 'chromium', '--isolated'])
  expect(launchArgs({ mode: 'attach', endpoint: 'http://127.0.0.1:9222' }, true)).toEqual(['--browser', 'chromium', '--cdp-endpoint', 'http://127.0.0.1:9222'])
  expect(vi.mocked(mountSessionMcp).mock.calls[1]![1].exclusive).toBe(true)
})

it('defaults browser to auto, which launches the installed Chrome in an isolated profile and Chromium when there is none', () => {
  expect(Provider.Config({ mode: 'launch' })).toMatchObject({ browser: 'auto' })
  expect(launchArgs({ mode: 'launch' }, true)).toEqual(['--browser', 'chrome', '--isolated', '--headless'])
  expect(launchArgs({ mode: 'launch', browser: 'auto' }, false)).toEqual(['--browser', 'chromium', '--isolated', '--headless'])
})

it('launches the forced browser whether or not Chrome is installed, and rejects any other browser', () => {
  for (const installed of [true, false]) {
    expect(launchArgs({ mode: 'launch', browser: 'chrome' }, installed)).toEqual(['--browser', 'chrome', '--isolated', '--headless'])
    expect(launchArgs({ mode: 'launch', browser: 'chromium' }, installed)).toEqual(['--browser', 'chromium', '--isolated', '--headless'])
  }
  expect(vi.mocked(launchedBrowser).mock.calls.map(([choice]) => choice)).toEqual(['chrome', 'chromium', 'chrome', 'chromium'])
  expect(() => Provider.Config({ mode: 'launch', browser: 'firefox' } as never)).toThrow()
})

it('keeps Chromium launch settings for a configured executable under auto, and the same arguments on every start', () => {
  expect(launchArgs({ mode: 'launch', executablePath: '/custom/chromium' }, true))
    .toEqual(['--browser', 'chromium', '--isolated', '--headless', '--executable-path', '/custom/chromium'])
  expect(launchArgs({ mode: 'launch', browser: 'chrome', executablePath: '/custom/chrome' }, false))
    .toEqual(['--browser', 'chrome', '--isolated', '--headless', '--executable-path', '/custom/chrome'])
  expect(launchArgs({ mode: 'launch' }, true)).toEqual(launchArgs({ mode: 'launch' }, true))
})

it('lists the Chrome paths that the pinned Playwright\'s own chrome channel tries on each platform', () => {
  const require = createRequire(import.meta.url)
  const mcp = createRequire(require.resolve('@playwright/mcp/package.json'))
  const { registry } = mcp('playwright-core/lib/coreBundle') as {
    registry: { registry: { findExecutable(name: string): { executablePath(): string | undefined } } }
  }
  const fs = require('node:fs') as typeof import('node:fs')
  const hosts: { platform: NodeJS.Platform; env: Record<string, string> }[] = [
    { platform: 'linux', env: {} },
    { platform: 'darwin', env: {} },
    { platform: 'win32', env: {
      LOCALAPPDATA: 'C:\\Users\\p\\AppData\\Local', PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)', HOMEDRIVE: 'C:',
    } },
    { platform: 'win32', env: { LOCALAPPDATA: '', PROGRAMFILES: 'D:\\Programs', 'PROGRAMFILES(X86)': '', HOMEDRIVE: 'D:' } },
  ]
  for (const host of hosts) {
    for (const name of ['LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'HOMEDRIVE']) vi.stubEnv(name, host.env[name] ?? '')
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue(host.platform)
    const tried: string[] = []
    const access = vi.spyOn(fs, 'accessSync').mockImplementation((path) => {
      tried.push(String(path))
      throw new Error('absent')
    })
    try {
      expect(registry.registry.findExecutable('chrome').executablePath()).toBeUndefined()
    } finally {
      access.mockRestore()
      platform.mockRestore()
    }
    // Playwright joins with this computer's separator; on Windows that is the win32 join the candidates use.
    const normal = (path: string): string => host.platform === 'win32' ? win32.normalize(path) : path
    expect(tried.map(normal)).toEqual(chromeChannelCandidates(host))
    expect(tried.length).toBeGreaterThan(0)
  }
})

it('rejects malformed endpoints before mounting any browser resources', () => {
  expect(() => { Provider.apply(new Context(), Provider.Config({ mode: 'attach', endpoint: 'http://localhost:bad/path' })) }).toThrow('browser endpoint')
  expect(mountSessionMcp).not.toHaveBeenCalled()
})

it('replaces only Playwright\'s missing-browser failure with the final setup message', () => {
  Provider.apply(new Context(), Provider.Config({ mode: 'launch' }))
  const explain = vi.mocked(mountSessionMcp).mock.calls[0]![1].explainFailure!
  for (const message of [
    'Browser "chromium" is not installed; expected executable at /home/user/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome. Run `npx @playwright/mcp install-browser chromium` to install',
    'browserType.launch: Executable doesn\'t exist at /home/user/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
  ]) {
    expect(explain(message)).toBe(Provider.MISSING_BROWSER_MESSAGE)
  }
  expect(explain('page.goto: net::ERR_NAME_NOT_RESOLVED at https://example.invalid/')).toBeUndefined()
  expect(Provider.MISSING_BROWSER_MESSAGE).toContain('finish Browser setup in Plugins')
})

it('runs the server in one folder of the Harness home for every Session when serverDirectory is home', () => {
  vi.stubEnv('DSH_HOME', '/home/person/.delorun')
  Provider.apply(new Context(), Provider.Config({ mode: 'launch', serverDirectory: 'home' }))
  Provider.apply(new Context(), Provider.Config({ mode: 'launch', serverDirectory: 'session' }))
  Provider.apply(new Context(), Provider.Config({ mode: 'launch' }))
  const directories = vi.mocked(mountSessionMcp).mock.calls.map(([, options]) => options.directory)
  expect(directories).toEqual(['/home/person/.delorun/browser-use/playwright-mcp', undefined, undefined])
  expect(() => Provider.Config({ mode: 'launch', serverDirectory: 'workspace' } as never)).toThrow()
})
