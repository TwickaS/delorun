/** Chrome or Chromium browser tools from the pinned Playwright MCP server. @module */

import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import {
  browserMcpAttachFields, browserMcpLaunchFields, browserServerDirectory, mountSessionMcp, validateBrowserMcpConfig,
  type BrowserMcpAttachConfig, type BrowserMcpLaunchConfig, type SessionMcpAdmission,
} from '@deepseek-ai/dsh-experimental-browser-use-runtime/mcp'
import { BROWSER_CHOICES, UNSET_BROWSER_CHOICE, type BrowserChoice } from '@deepseek-ai/dsh-native-command/chrome-channel'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-working-directory'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { providedAdmission } from './admission.ts'
import { deniedToolMessage, deniedToolsOf } from './denied-tools.ts'
import { launchBrowser } from './launch.ts'
import { explainMissingBrowser } from './missing-browser.ts'
import { copyReadArguments, outputRoot, refuseOutsideFolder, refuseWrittenOutside } from './output-folder.ts'

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

/** Settings every mode has. */
export interface DeniedToolsConfig {
  /**
   * More of the server's own tool names to turn off, beside `SERVER_CODE_TOOLS`, which are always off: a tool
   * that is off is never offered to the model and is refused when called. Defaults to none.
   */
  deniedTools: string[]
}

/** Delorun's additions to the browser tools, which every mode has. */
export interface BrowserAdditionsConfig {
  /**
   * Replace Playwright's report of a browser build that is not installed with one message that tells the model to stop
   * and send the person to Browser setup (`MISSING_BROWSER_MESSAGE`, `MISSING_CHROME_MESSAGE`).
   * This is Delorun's C16 switch `browser_additions`, off in the parity composition. The turned-off tools
   * (`SERVER_CODE_TOOLS` and `deniedTools`), the folder guard ({@link refuseOutsideFolder}) and the Session's folder as
   * the server's one MCP root do not depend on it: they hold with it off. Defaults to off.
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
    prepareCall: copyReadArguments,
    checkResult: (call, startedAt) => refuseWrittenOutside(call, startedAt, (line) => { ctx.logger.warn(`${name}: ${line}`) }),
    ...config.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: config.toolCallTimeoutMs },
    ...directory === undefined ? {} : { directory },
  })
}
