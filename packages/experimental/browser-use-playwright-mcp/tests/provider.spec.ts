import { existsSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { mountSessionMcp } from '@deepseek-ai/dsh-experimental-browser-use-runtime/mcp'
import * as Provider from '../src/index.ts'

vi.mock('@deepseek-ai/dsh-experimental-browser-use-runtime/mcp', async importOriginal => ({
  ...await importOriginal<typeof import('@deepseek-ai/dsh-experimental-browser-use-runtime/mcp')>(),
  mountSessionMcp: vi.fn(),
}))
afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})

it('uses the pinned Playwright executable with isolated Chromium launch settings', () => {
  vi.stubEnv('PLAYWRIGHT_MCP_CDP_ENDPOINT', 'http://invalid.example:1')
  Provider.apply(new Context(), Provider.Config({ mode: 'launch', executablePath: '/custom/chromium', toolCallTimeoutMs: 123 }))
  const options = vi.mocked(mountSessionMcp).mock.calls[0]![1]
  expect(existsSync(options.args[0]!)).toBe(true)
  expect(options).toMatchObject({ name: 'playwright-mcp', exclusive: false, command: process.execPath, toolCallTimeoutMs: 123 })
  expect(options.env?.PLAYWRIGHT_MCP_CDP_ENDPOINT).toBe('')
  expect(options.args.slice(1)).toEqual(['--browser', 'chromium', '--isolated', '--headless', '--executable-path', '/custom/chromium'])
  expect('default' in Provider).toBe(false)
})

it('supports headed launch and attaches without launching a browser or creating a profile', () => {
  Provider.apply(new Context(), Provider.Config({ mode: 'launch', headless: false }))
  expect(vi.mocked(mountSessionMcp).mock.calls[0]![1].args.slice(1)).toEqual(['--browser', 'chromium', '--isolated'])
  Provider.apply(new Context(), Provider.Config({ mode: 'attach', endpoint: 'http://127.0.0.1:9222' }))
  const options = vi.mocked(mountSessionMcp).mock.calls[1]![1]
  expect(options.exclusive).toBe(true)
  expect(options.args.slice(1)).toEqual(['--browser', 'chromium', '--cdp-endpoint', 'http://127.0.0.1:9222'])
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
