/** Chrome or Chromium browser tools from the pinned Playwright MCP server. @module */

import { lstat, readdir, realpath, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import {
  browserMcpAttachFields, browserMcpLaunchFields, browserServerDirectory, mountSessionMcp, validateBrowserMcpConfig,
  type BrowserMcpAttachConfig, type BrowserMcpLaunchConfig, type BrowserToolCall, type SessionMcpAdmission,
} from '@deepseek-ai/dsh-experimental-browser-use-runtime/mcp'
import { BROWSER_CHOICES, launchedBrowser, UNSET_BROWSER_CHOICE, type BrowserChoice, type LaunchedBrowser } from '@deepseek-ai/dsh-native-command/chrome-channel'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-working-directory'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** Cordis identity for the Playwright MCP browser provider. */
export const name = 'experimental-browser-use-playwright-mcp'

/** Services required for scoped MCP startup and prompt readiness checks. */
export const inject = ['browserUse', 'agents', 'tools', 'systemPrompt', 'workingDirectory']

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * An optional rule for which Sessions the browser serves, such as one that keeps the browser from chats in a folder
     * whose owner chose none. Absent, every Session is served.
     */
    browserUseAdmission: Pick<SessionMcpAdmission, 'admitted'>
  }

  interface Events {
    /**
     * A Session's answer from `browserUseAdmission` may have changed; the browser server starts or stops to match.
     * @mode parallel
     * @param session - the Session.
     * @returns settles once the Session's server has started or stopped to match.
     */
    'browser-use/admission-changed'(session: Agent['session']): Promise<void>
  }
}

/**
 * The admission the mount gets: the `browserUseAdmission` service's answer at each ask, or every Session while no
 * service is provided, and the `browser-use/admission-changed` event as its change reports, so a service provided
 * after the mount is heard too.
 * @param ctx - the provider context.
 * @returns the admission.
 */
export function providedAdmission(ctx: Context): SessionMcpAdmission {
  return {
    admitted: agent => ctx.get('browserUseAdmission')?.admitted(agent) ?? true,
    changed: listener => ctx.on('browser-use/admission-changed', listener),
  }
}

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
   * and send the person to Browser setup ({@link MISSING_BROWSER_MESSAGE}, {@link MISSING_CHROME_MESSAGE}). This is
   * Delorun's C16 switch `browser_additions`, off in the parity composition. The turned-off tools
   * ({@link SERVER_CODE_TOOLS} and `deniedTools`), the folder guard ({@link refuseOutsideFolder}) and the
   * Session's folder as the server's one MCP root do not depend on it: they hold with it off. Defaults to off.
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

/**
 * The folder, in the folder its client names as the MCP root, where Playwright's MCP server saves screenshots, PDFs and
 * snapshots when no output folder is set. The provider always sets one ({@link outputRoot}), so a new chat's folder
 * has none; a chat that already has one keeps it and nothing writes there.
 */
export const OUTPUT_FOLDER = '.playwright-mcp'

/** The folder, in the per-user cache folder, that holds one output folder for each Session. */
export const OUTPUT_ROOT_NAME = 'delorun-browser-output'

/**
 * Where the server's output folders live: a folder in the per-user cache folder, which the sandbox dialects mount
 * read-only for a confined command (or do not grant) and which lies outside the protected Delorun home, so a
 * sandboxed command can read a saved file but cannot write, remove, rename or replace the folder.
 * @param platform - the Host platform.
 * @param env - the Host environment.
 * @param home - the Host user's home folder.
 * @returns an absolute folder: `%LOCALAPPDATA%` on Windows, `~/Library/Caches` on macOS, otherwise an absolute
 * `$XDG_CACHE_HOME` or `~/.cache`, then {@link OUTPUT_ROOT_NAME}.
 */
export function outputRoot(platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>>, home: string): string {
  const absolute = (value: string | undefined): value is string => value !== undefined && isAbsolute(value)
  switch (platform) {
    case 'win32': return join(absolute(env.LOCALAPPDATA) ? env.LOCALAPPDATA : join(home, 'AppData', 'Local'), OUTPUT_ROOT_NAME)
    case 'darwin': return join(home, 'Library', 'Caches', OUTPUT_ROOT_NAME)
    default: return join(absolute(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME : join(home, '.cache'), OUTPUT_ROOT_NAME)
  }
}

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
 * real paths. A call's `filename` and `paths` are tested where the server resolves them: against the folder and against
 * the Session's output folder, which the Host owns outside the folder ({@link outputRoot}) and which the test treats as
 * inside. A call with no output folder (a caller that set none) is refused while {@link OUTPUT_FOLDER} really lies
 * outside the folder, because the server then saves default-named files and downloads there. A path that changes
 * between this test and the server's use is not covered; {@link refuseWrittenOutside} checks after the call.
 * @param call - the tool call and the folder the Session's server was told as its MCP root.
 * @returns {@link LINKED_OUTPUT_FOLDER_MESSAGE}, or {@link outsideFolderMessage} for the first name that leads
 * outside, or `undefined` when nothing does.
 */
export async function refuseOutsideFolder(call: BrowserToolCall): Promise<string | undefined> {
  const folder = await realpath(call.directory)
  const roots = [folder]
  const bases = [call.directory]
  if (call.outputDirectory === undefined) {
    if (!inside(folder, await realLocation(join(call.directory, OUTPUT_FOLDER)))) return LINKED_OUTPUT_FOLDER_MESSAGE
    bases.push(join(call.directory, OUTPUT_FOLDER))
  } else {
    roots.push(await realpath(call.outputDirectory))
    bases.push(call.outputDirectory)
  }
  if (typeof call.arguments !== 'object' || call.arguments === null) return undefined
  const { filename, paths } = call.arguments as { filename?: unknown; paths?: unknown }
  const names = [filename, ...Array.isArray(paths) ? paths as unknown[] : []].filter(name => typeof name === 'string')
  for (const name of names) {
    for (const base of bases) {
      const real = await realLocation(resolve(base, name))
      if (!roots.some(root => inside(root, real))) return outsideFolderMessage(name)
    }
  }
  return undefined
}

/** The deepest folder level of the output folder's tree that {@link refuseWrittenOutside} looks through. */
const OUTPUT_TREE_DEPTH = 6

/**
 * The refusal of a browser tool call whose file landed outside the Session's folder.
 * @param removed - whether the file was removed.
 * @returns the model-visible text.
 */
export function writtenOutsideMessage(removed: boolean): string {
  return `Browser saved a file outside this chat's folder, through a link, so the result is refused${removed ? ' and the file was removed' : ', and the file could not be removed'}. Stop using browser tools for this request and tell the person to remove the link from the chat's folder.`
}

/**
 * Remove a file the call wrote, when it is a plain file the call just created.
 * @param real - the file's real location.
 * @param startedAt - when the call was sent, in milliseconds since the epoch.
 * @returns true when the file was removed; false when it was left, because it is not a plain file, is older than the
 * call, or could not be removed. The final name is never followed.
 */
async function removeWritten(real: string, startedAt: number): Promise<boolean> {
  try {
    const stats = await lstat(real)
    if (!stats.isFile() || stats.mtimeMs < startedAt - 1000 || stats.birthtimeMs < startedAt - 1000) return false
    await unlink(real)
    return true
  } catch {
    // The file is gone or cannot be changed; the refusal says it was not removed.
    return false
  }
}

/**
 * The links inside the output folder's tree that lead outside the Session's folder. The walk lists folders and
 * reads link names; it never follows one.
 * @param roots - the real folders a link may lead to: the Session's folder and its output folder.
 * @param directory - the folder to look through.
 * @param depth - how many more levels to look through.
 * @returns the real locations the links lead to.
 */
async function outsideLinks(roots: readonly string[], directory: string, depth: number): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const found: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      const real = await realLocation(path)
      if (!roots.some(root => inside(root, real))) found.push(real ?? path)
    } else if (entry.isDirectory() && depth > 0) {
      found.push(...await outsideLinks(roots, path, depth - 1))
    }
  }
  return found
}

/**
 * Check, after a browser tool call, that nothing it wrote landed outside the Session's folder: the call's `filename`
 * where the server resolved it, and every folder a link inside the output folder leads to outside the folder (where
 * downloads and default-named files land). A plain file there that the call created is removed without following the
 * final name; one that cannot be removed is left and reported. This is what covers the replacement of a folder or link
 * after {@link refuseOutsideFolder}'s test, which that test cannot stop.
 * @param call - the finished call.
 * @param startedAt - when the call was sent, in milliseconds since the epoch.
 * @param log - receives one line for each refusal.
 * @returns {@link writtenOutsideMessage}, or `undefined` when nothing landed outside.
 */
export async function refuseWrittenOutside(
  call: BrowserToolCall, startedAt: number, log: (line: string) => void,
): Promise<string | undefined> {
  const folder = await realpath(call.directory)
  const output = call.outputDirectory ?? join(call.directory, OUTPUT_FOLDER)
  const roots = call.outputDirectory === undefined ? [folder] : [folder, await realpath(call.outputDirectory)]
  const landed: string[] = []
  const { filename } = (typeof call.arguments === 'object' && call.arguments !== null ? call.arguments : {}) as { filename?: unknown }
  if (typeof filename === 'string') {
    for (const base of [call.directory, output]) {
      const real = await realLocation(resolve(base, filename))
      if (real !== undefined && !roots.some(root => inside(root, real))) landed.push(real)
    }
  }
  for (const target of await outsideLinks(roots, output, OUTPUT_TREE_DEPTH)) {
    const names = await readdir(target).catch(() => [])
    landed.push(target, ...names.map(name => join(target, name)))
  }
  let found = false
  let kept = false
  for (const real of new Set(landed)) {
    const stats = await lstat(real).catch(() => undefined)
    if (stats === undefined || !stats.isFile() || stats.mtimeMs < startedAt - 1000) continue
    found = true
    if (!await removeWritten(real, startedAt)) kept = true
  }
  if (!found) return undefined
  log(`${name}: ${call.tool} saved a file outside the chat's folder through a link; the result was refused${kept ? '' : ' and the file removed'}`)
  return writtenOutsideMessage(!kept)
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
    // The server saves to a Host-owned folder outside every folder a sandboxed command can write, so the chat's own
    // folder gets no `.playwright-mcp`.
    outputRoot: outputRoot(process.platform, process.env, homedir()),
    ...config.browserAdditions ? { explainFailure: explainMissingBrowser } : {},
    // The denial and the folder guard are security invariants, which C16's `browser_additions` switch never turns off.
    deniedTools: denied,
    admission: providedAdmission(ctx),
    // The client never registers a denied tool; this refusal holds even if a call to one is routed here.
    refuseCall: call => denied.includes(call.tool) ? Promise.resolve(deniedToolMessage(call.tool)) : refuseOutsideFolder(call),
    checkResult: (call, startedAt) => refuseWrittenOutside(call, startedAt, (line) => { ctx.logger.warn(line) }),
    ...config.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: config.toolCallTimeoutMs },
    ...directory === undefined ? {} : { directory },
  })
}
