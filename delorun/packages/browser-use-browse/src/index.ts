/**
 * @delorun/browser-use-browse: the person's own browser, with their sign-ins, as a second browser beside the default
 * isolated one, through browse (`browse mcp`, MIT). The agent asks with `use_my_browser`; the person allows it once per
 * chat on the approval card ([tool](./tool.ts)), which records a `real-browser/granted` event ([grant](./grant.ts)).
 * Only a chat whose grant runs starts browse and sees its tools, and each browse call runs only in a turn the person
 * started or, with the "also when I'm away" permission, a scheduled or background one. The studio reads and ends the
 * grant through [routes](./routes.ts). The pinned binary and its environment come from [config](./config.ts).
 * @module @delorun/browser-use-browse
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { mountSessionMcp } from '@deepseek-ai/dsh-experimental-browser-use-runtime/mcp'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import { childEnv, Config as ConfigSchema, resolveCommand, validateConfig, type Config as BrowseConfig } from './config.ts'
import { BROWSE_SERVER, USE_MY_BROWSER_TOOL } from './copy.ts'
import { registerGrants, type RealBrowserGrants } from './grant.ts'
import { registerRealBrowserRoutes } from './routes.ts'
import { guardBrowseCalls, useMyBrowserTool } from './tool.ts'

export { RealBrowserGrants, type GrantState, type GrantView, type UseVerdict } from './grant.ts'
export { REAL_BROWSER_ROUTES, type RealBrowserState } from './wire.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * The chats' real-browser grants, provided while the driver row runs; a plugin that only makes sense beside the
     * driver, such as its skill, injects it.
     */
    realBrowser: RealBrowserGrants
  }
}

/** Cordis identity of the provider. */
export const name = 'browser-use-browse'

/**
 * The services the provider needs: the MCP mount's and the projection registry. The studio's routes mount while a
 * connection is there, which a headless run has none of.
 */
export const inject = ['agents', 'tools', 'systemPrompt', 'workingDirectory', 'sessionProjections']

/** The row's configuration ([`Config`](./config.ts)). */
export type Config = BrowseConfig

/** The schema of {@link Config}. */
export const Config: typeof ConfigSchema = ConfigSchema

/** Milliseconds in one day. */
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Mount the provider: the grants, the tool, the call guard, the routes and, for each chat whose grant runs, browse.
 * @param ctx - the provider context.
 * @param config - the validated row configuration.
 * @returns when the projection is registered and everything is mounted.
 * @throws Error before anything is mounted, for a row that would start something other than the pinned browse, or
 *   when this computer has no browse build or its package is missing.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  validateConfig(config)
  const command = resolveCommand(config)
  const now = (): number => Date.now()
  const grants = await registerGrants(ctx, now)
  ctx.provide('realBrowser', grants)
  ctx.effect(() => ctx.tools.register(useMyBrowserTool(ctx, grants)), USE_MY_BROWSER_TOOL)
  guardBrowseCalls(ctx, grants)
  ctx.inject(['connection'], (scope) => { registerRealBrowserRoutes(scope, grants, { awayMs: () => config.awayDays * DAY_MS, now }) })
  mountSessionMcp(ctx, {
    name: BROWSE_SERVER,
    registration: 'none',
    admission: { admitted: agent => grants.admitted(agent), changed: listener => grants.onChange(({ session }) => listener(session)) },
    exclusive: false,
    command: command.command,
    args: [...command.args],
    env: childEnv(config),
    directory: dshHomePath('browser-use', BROWSE_SERVER),
    ...config.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: config.toolCallTimeoutMs },
  })
}
