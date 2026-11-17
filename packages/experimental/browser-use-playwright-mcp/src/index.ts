/** Chromium browser tools from the pinned Playwright MCP server. @module */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { BrowserMcpConfig, browserServerDirectory, mountSessionMcp, validateBrowserMcpConfig } from '@deepseek-ai/dsh-experimental-browser-use-runtime/mcp'
import type {} from '@deepseek-ai/dsh-working-directory'

/** Cordis identity for the Playwright MCP browser provider. */
export const name = 'experimental-browser-use-playwright-mcp'

/** Services required for scoped MCP startup and prompt readiness checks. */
export const inject = ['browserUse', 'agents', 'tools', 'systemPrompt', 'workingDirectory']

/** Fixed Chromium launch or existing-browser attachment settings. */
export type Config = BrowserMcpConfig

/** Validate the launch or attachment configuration before activation. */
export const Config: typeof BrowserMcpConfig = BrowserMcpConfig

/**
 * The tool failure that replaces Playwright's report of a browser build that is not installed. The model cannot install
 * it, so the text tells it to stop and send the person to Browser's setup.
 */
export const MISSING_BROWSER_MESSAGE = 'Browser needs its Chromium download, so no browser tool can run until the person finishes Browser setup in Plugins. Stop using browser tools and other ways to browse for this request; tell the person to finish Browser setup in Plugins, then ask again.'

/** Playwright's reports of a browser executable that is not installed: its launch error and the MCP server's rewording of it. */
const MISSING_BROWSER_PATTERN = new RegExp([
  'Executable doesn\'t exist', 'is not installed; expected executable at', 'is not installed\\. Run `npx @playwright/mcp install-browser',
].join('|'), 'u')

/**
 * Replace Playwright's report of a browser executable that is not installed.
 * @param message - a failed browser tool call's error message.
 * @returns {@link MISSING_BROWSER_MESSAGE} for a missing browser build, otherwise `undefined`.
 */
export function explainMissingBrowser(message: string): string | undefined {
  return MISSING_BROWSER_PATTERN.test(message) ? MISSING_BROWSER_MESSAGE : undefined
}

/**
 * Expose Playwright's upstream tools in each live Session's scope.
 * The pinned npm server runs under the current Node executable; browser state is not persisted by DSH.
 * @param ctx - provider context supplying browser use, Agents, and tools.
 * @param config - validated browser choice and optional tool timeout.
 */
export function apply(ctx: Context, config: Config): void {
  validateBrowserMcpConfig(config)
  const cli = join(dirname(fileURLToPath(import.meta.resolve('@playwright/mcp/package.json'))), 'cli.js')
  // Upstream environment options can otherwise replace the configured browser
  // mode or import an unrelated profile. Empty values mean absent to its parser.
  const env = Object.fromEntries(Object.keys(process.env)
    .filter(key => key.toUpperCase().startsWith('PLAYWRIGHT_MCP_'))
    .map(key => [key, '']))
  const args = [cli, '--browser', 'chromium']
  if (config.mode === 'attach') {
    args.push('--cdp-endpoint', config.endpoint)
  } else {
    args.push('--isolated')
    if (config.headless) args.push('--headless')
    if (config.executablePath !== undefined) args.push('--executable-path', config.executablePath)
  }
  const directory = browserServerDirectory(config, 'playwright-mcp')
  mountSessionMcp(ctx, {
    name: 'playwright-mcp',
    exclusive: config.mode === 'attach',
    command: process.execPath,
    args,
    env,
    explainFailure: explainMissingBrowser,
    ...config.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: config.toolCallTimeoutMs },
    ...directory === undefined ? {} : { directory },
  })
}
