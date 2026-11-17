/** Chrome or Chromium browser tools from the pinned Playwright MCP server. @module */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import {
  browserMcpAttachFields, browserMcpLaunchFields, browserServerDirectory, mountSessionMcp, validateBrowserMcpConfig,
  type BrowserMcpAttachConfig, type BrowserMcpLaunchConfig,
} from '@deepseek-ai/dsh-experimental-browser-use-runtime/mcp'
import { BROWSER_CHOICES, launchedBrowser, UNSET_BROWSER_CHOICE, type BrowserChoice, type LaunchedBrowser } from '@deepseek-ai/dsh-native-command/chrome-channel'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-working-directory'

/** Cordis identity for the Playwright MCP browser provider. */
export const name = 'experimental-browser-use-playwright-mcp'

/** Services required for scoped MCP startup and prompt readiness checks. */
export const inject = ['browserUse', 'agents', 'tools', 'systemPrompt', 'workingDirectory']

/** Launch settings: the shared ones and which browser launches. */
export interface LaunchConfig extends BrowserMcpLaunchConfig {
  /**
   * Which browser launches: `auto` is the installed Google Chrome when Playwright's `chrome` channel finds one and
   * Playwright's own Chromium build otherwise; `chrome` and `chromium` always launch that one. Chrome runs with a
   * profile Playwright creates for the launch, never the person's own.
   */
  browser: BrowserChoice
}

/** Chrome or Chromium launch, or existing-browser attachment settings. */
export type Config = LaunchConfig | BrowserMcpAttachConfig

/** Validate the launch or attachment configuration before activation. */
export const Config: Schema<
  BrowserMcpAttachConfig | (Omit<LaunchConfig, 'headless' | 'browser'> & { headless?: boolean; browser?: BrowserChoice }), Config
> = Schema.union([
  Schema.object({ ...browserMcpLaunchFields, browser: Schema.union([...BROWSER_CHOICES]).default(UNSET_BROWSER_CHOICE) }),
  Schema.object(browserMcpAttachFields),
])

/**
 * The `--browser` value of a launch. The answer reads only the configuration and whether Chrome is installed, so the
 * server's arguments, which the MCP add-time consent covers, stay the same on one computer until Chrome is installed
 * or removed.
 * @param config - the launch settings.
 * @returns the configured browser; under `auto`, Chrome when {@link launchedBrowser} finds it, except that a
 * configured `executablePath` keeps `chromium`, whose launch settings that executable has always run with.
 */
export function launchBrowser(config: LaunchConfig): LaunchedBrowser {
  if (config.browser === 'auto' && config.executablePath !== undefined) return 'chromium'
  return launchedBrowser(config.browser)
}

/**
 * The tool failure that replaces Playwright's report of a browser build that is not installed. The model cannot install
 * it, so the text tells it to stop and send the person to Browser's setup.
 */
export const MISSING_BROWSER_MESSAGE = 'Browser needs its Chromium download, so no browser tool can run until the person finishes Browser setup in Plugins. Stop using browser tools and other ways to browse for this request; tell the person to finish Browser setup in Plugins, then ask again.'

/** Playwright's reports of a browser executable that is not installed: its launch error and the MCP server's rewording of it. */
const MISSING_BROWSER_PATTERN = new RegExp([
  'Executable doesn\'t exist', 'is not installed; expected executable at', 'is not installed\\. Run `npx @playwright/mcp install-browser',
].join('|'), 'u')

/** The folder, in the folder its client names as the MCP root, that Playwright's MCP server saves screenshots, PDFs and snapshots to. */
export const OUTPUT_FOLDER = '.playwright-mcp'

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
  const args = [cli]
  if (config.mode === 'attach') {
    args.push('--browser', 'chromium', '--cdp-endpoint', config.endpoint)
  } else {
    args.push('--browser', launchBrowser(config), '--isolated')
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
    outputFolder: OUTPUT_FOLDER,
    explainFailure: explainMissingBrowser,
    ...config.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: config.toolCallTimeoutMs },
    ...directory === undefined ? {} : { directory },
  })
}
