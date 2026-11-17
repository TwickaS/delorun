/** Chrome or Chromium browser tools from the pinned Playwright MCP server. @module */

import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import {
  browserMcpAttachFields, browserMcpLaunchFields, browserServerDirectory, mountSessionMcp, validateBrowserMcpConfig,
  type BrowserMcpAttachConfig, type BrowserMcpLaunchConfig, type BrowserToolCall,
} from '@deepseek-ai/dsh-experimental-browser-use-runtime/mcp'
import { BROWSER_CHOICES, launchedBrowser, UNSET_BROWSER_CHOICE, type BrowserChoice, type LaunchedBrowser } from '@deepseek-ai/dsh-native-command/chrome-channel'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-working-directory'

/** Cordis identity for the Playwright MCP browser provider. */
export const name = 'experimental-browser-use-playwright-mcp'

/** Services required for scoped MCP startup and prompt readiness checks. */
export const inject = ['browserUse', 'agents', 'tools', 'systemPrompt', 'workingDirectory']

/**
 * The tools of the pinned Playwright MCP server that run model-written code in the server process, outside the page
 * and outside the agent's sandbox. They are always turned off; no configuration turns one back on. In @playwright/mcp
 * 0.0.80 that is one tool; every other offered tool acts on the page or on files the folder guard checks.
 */
export const SERVER_CODE_TOOLS: readonly string[] = ['browser_run_code_unsafe']

/** Settings every mode has. */
export interface DeniedToolsConfig {
  /**
   * More of the server's own tool names to turn off, beside {@link SERVER_CODE_TOOLS}, which are always off: a tool
   * that is off is never offered to the model and is refused when called. Defaults to none.
   */
  deniedTools: string[]
}

/** Delorun's additions to the browser tools, which every mode has. */
export interface BrowserAdditionsConfig {
  /**
   * Replace Playwright's report of a browser build that is not installed with one message that tells the model to stop
   * and send the person to Browser setup ({@link MISSING_BROWSER_MESSAGE}, {@link MISSING_CHROME_MESSAGE}), and give
   * {@link OUTPUT_FOLDER} a `.gitignore` of `*`. This is Delorun's C16 switch `browser_additions`, off in the parity
   * composition. The turned-off tools ({@link SERVER_CODE_TOOLS} and `deniedTools`), the folder guard
   * ({@link refuseOutsideFolder}) and the Session's folder as the server's one MCP root do not depend on it: they hold
   * with it off. Defaults to off.
   */
  browserAdditions: boolean
}

/** Launch settings: the shared ones and which browser launches. */
export interface LaunchConfig extends BrowserMcpLaunchConfig, DeniedToolsConfig, BrowserAdditionsConfig {
  /**
   * Which browser launches: `auto` is the installed Google Chrome when Playwright's `chrome` channel finds one and
   * Playwright's own Chromium build otherwise; `chrome` and `chromium` always launch that one. Chrome runs with a
   * profile Playwright creates for the launch, never the person's own.
   */
  browser: BrowserChoice
}

/** Existing-browser attachment settings. */
export interface AttachConfig extends BrowserMcpAttachConfig, DeniedToolsConfig, BrowserAdditionsConfig {}

/** Chrome or Chromium launch, or existing-browser attachment settings. */
export type Config = LaunchConfig | AttachConfig

const deniedTools = Schema.array(Schema.string().pattern(/^[\w-]+$/u)).default([])

/**
 * Every tool that is turned off for a configuration.
 * @param config - the validated configuration.
 * @returns {@link SERVER_CODE_TOOLS} and the configuration's `deniedTools`, each name once.
 */
export function deniedToolsOf(config: DeniedToolsConfig): string[] {
  return [...new Set([...SERVER_CODE_TOOLS, ...config.deniedTools])]
}

/** Validate the launch or attachment configuration before activation. */
export const Config: Schema<
  | (BrowserMcpAttachConfig & Partial<DeniedToolsConfig> & Partial<BrowserAdditionsConfig>)
  | (Omit<LaunchConfig, 'headless' | 'browser' | 'deniedTools' | 'browserAdditions'> & { headless?: boolean; browser?: BrowserChoice }
    & Partial<DeniedToolsConfig> & Partial<BrowserAdditionsConfig>),
  Config
> = Schema.union([
  Schema.object({
    ...browserMcpLaunchFields,
    browser: Schema.union([...BROWSER_CHOICES]).default(UNSET_BROWSER_CHOICE),
    deniedTools,
    browserAdditions: Schema.boolean().default(false),
  }),
  Schema.object({ ...browserMcpAttachFields, deniedTools, browserAdditions: Schema.boolean().default(false) }),
])

/**
 * The `--browser` value of a launch. The answer reads only the configuration and whether Chrome is installed, so the
 * server's arguments, which the MCP add-time consent covers, stay the same on one computer until Chrome is installed
 * or removed.
 * @param config - the launch settings.
 * @returns {@link launchedBrowser}'s answer for the configured browser and `executablePath`.
 */
export function launchBrowser(config: LaunchConfig): LaunchedBrowser {
  return launchedBrowser(config.browser, undefined, config.executablePath)
}

/**
 * The tool failure that replaces Playwright's report that Google Chrome, which the configuration tells it to launch,
 * is not installed. The model cannot install it, so the text tells it to stop and send the person to Browser's setup.
 */
export const MISSING_CHROME_MESSAGE = 'Browser is set to use Google Chrome, which is not installed on this computer, so no browser tool can run until the person finishes Browser setup in Plugins. Stop using browser tools and other ways to browse for this request; tell the person to finish Browser setup in Plugins, then ask again.'

/**
 * The tool failure that replaces Playwright's report of a browser build that is not installed. The model cannot install
 * it, so the text tells it to stop and send the person to Browser's setup.
 */
export const MISSING_BROWSER_MESSAGE = 'Browser needs its Chromium download, so no browser tool can run until the person finishes Browser setup in Plugins. Stop using browser tools and other ways to browse for this request; tell the person to finish Browser setup in Plugins, then ask again.'

/**
 * How a failure from Playwright's MCP server starts: its `### Error` header line, then an optional `Error: `. A failure
 * without the header starts the same way.
 */
const FAILURE_START = '^(?:### Error\\n)?(?:Error: )?'

/**
 * Playwright's report that the `chrome` channel has no installed Chrome, at the start of a failure:
 * `[browserType.launch: ]Chromium distribution 'chrome' is not found`.
 */
const MISSING_CHROME_PATTERN = new RegExp(`${FAILURE_START}(?:browserType\\.\\w+: )?Chromium distribution 'chrome' is not found`, 'u')

/**
 * Playwright's reports of a browser executable that is not installed, at the start of a failure: its launch error,
 * `[browserType.launch: ]Executable doesn't exist at <path>`, and the MCP server's rewording of it, `Browser "<name>" is
 * not installed[; expected executable at <path>]. Run \`npx @playwright/mcp install-browser <name>\` to install`. The
 * same words later in a failure, such as in a page's own text, are not such a report.
 */
const MISSING_BROWSER_PATTERN = new RegExp(`${FAILURE_START}(?:${[
  '(?:browserType\\.\\w+: )?Executable doesn\'t exist at \\S',
  'Browser "[\\w-]+" is not installed(?:; expected executable at [^\\r\\n]+)?\\. Run `npx @playwright/mcp install-browser [\\w-]+` to install',
].join('|')})`, 'u')

/** The folder, in the folder its client names as the MCP root, that Playwright's MCP server saves screenshots, PDFs and snapshots to. */
export const OUTPUT_FOLDER = '.playwright-mcp'

/**
 * Replace Playwright's report of a browser that is not installed.
 * @param message - a failed browser tool call's error message.
 * @returns {@link MISSING_BROWSER_MESSAGE} for a missing browser build, {@link MISSING_CHROME_MESSAGE} for a missing
 * Chrome, otherwise `undefined`.
 */
export function explainMissingBrowser(message: string): string | undefined {
  if (MISSING_BROWSER_PATTERN.test(message)) return MISSING_BROWSER_MESSAGE
  return MISSING_CHROME_PATTERN.test(message) ? MISSING_CHROME_MESSAGE : undefined
}

/**
 * The refusal of a call to a tool that is turned off.
 * @param tool - the server's own tool name.
 * @returns the model-visible text.
 */
export function deniedToolMessage(tool: string): string {
  return `The browser tool "${tool}" is turned off here because it runs code outside the page. Use the other browser tools.`
}

/**
 * The refusal of every browser tool call while the Session's {@link OUTPUT_FOLDER} is a link that leads outside the
 * Session's folder: the server saves default-named files and downloads there without a file argument.
 */
export const LINKED_OUTPUT_FOLDER_MESSAGE = `Browser saves files in "${OUTPUT_FOLDER}" in this chat's folder, and that name is a link that leads outside the folder, so no browser tool can run. Stop using browser tools for this request and tell the person to remove or replace "${OUTPUT_FOLDER}" in the chat's folder.`

/**
 * Whether a real location is the folder or inside it.
 * @param folder - the folder's real path.
 * @param real - a real location, or `undefined` when it cannot be told.
 * @returns true when inside.
 */
function inside(folder: string, real: string | undefined): boolean {
  return real !== undefined && (real === folder || real.startsWith(folder + sep))
}

/**
 * The refusal of a browser tool call whose file argument leads outside the Session's folder.
 * @param name - the argument as the model wrote it.
 * @returns the model-visible text.
 */
export function outsideFolderMessage(name: string): string {
  return `Browser only saves and reads files inside this chat's folder, and "${name}" leads outside it. Use a file name or a path inside the chat's folder.`
}

/**
 * Where a path really is: the real path of its nearest existing ancestor, followed by the part that does not exist yet.
 * @param path - an absolute path.
 * @returns the real location, or `undefined` when it cannot be told: a link whose target is missing, a link loop, or
 * a folder that cannot be read.
 */
async function realLocation(path: string): Promise<string | undefined> {
  const missing: string[] = []
  for (let current = path; ; current = dirname(current)) {
    try {
      return join(await realpath(current), ...missing)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return undefined
    }
    // A link whose target does not exist yet would be created wherever it points.
    if (await lstat(current).then(stats => stats.isSymbolicLink(), () => false)) return undefined
    /* v8 ignore next -- the filesystem root always resolves, so the walk ends above */
    if (dirname(current) === current) return undefined
    missing.unshift(basename(current))
  }
}

/**
 * Refuse a tool call that would save or read a file really outside the Session's folder. Playwright's server compares
 * paths as text, so a link inside the folder would let a call write or read wherever the link points; this compares
 * real paths. Every call is refused while the {@link OUTPUT_FOLDER} really lies outside the folder, because the server
 * saves default-named files and downloads there whatever the call's arguments. A call's `filename` and `paths` are
 * tested where the server resolves them: against the folder and against its {@link OUTPUT_FOLDER}. A path that
 * changes between this test and the server's use, a download that lands between calls included, is not covered.
 * @param call - the tool call and the folder the Session's server was told as its MCP root.
 * @returns {@link LINKED_OUTPUT_FOLDER_MESSAGE}, or {@link outsideFolderMessage} for the first name that leads
 * outside, or `undefined` when nothing does.
 */
export async function refuseOutsideFolder(call: BrowserToolCall): Promise<string | undefined> {
  const folder = await realpath(call.directory)
  if (!inside(folder, await realLocation(join(call.directory, OUTPUT_FOLDER)))) return LINKED_OUTPUT_FOLDER_MESSAGE
  if (typeof call.arguments !== 'object' || call.arguments === null) return undefined
  const { filename, paths } = call.arguments as { filename?: unknown; paths?: unknown }
  const names = [filename, ...Array.isArray(paths) ? paths as unknown[] : []].filter(name => typeof name === 'string')
  for (const name of names) {
    for (const base of [call.directory, join(call.directory, OUTPUT_FOLDER)]) {
      if (!inside(folder, await realLocation(resolve(base, name)))) return outsideFolderMessage(name)
    }
  }
  return undefined
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
  const denied = deniedToolsOf(config)
  mountSessionMcp(ctx, {
    name: 'playwright-mcp',
    exclusive: config.mode === 'attach',
    command: process.execPath,
    args,
    env,
    ...config.browserAdditions ? { outputFolder: OUTPUT_FOLDER, explainFailure: explainMissingBrowser } : {},
    // The denial and the folder guard are security invariants, which C16's `browser_additions` switch never turns off.
    deniedTools: denied,
    // The client never registers a denied tool; this refusal holds even if a call to one is routed here.
    refuseCall: call => denied.includes(call.tool) ? Promise.resolve(deniedToolMessage(call.tool)) : refuseOutsideFolder(call),
    ...config.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: config.toolCallTimeoutMs },
    ...directory === undefined ? {} : { directory },
  })
}
