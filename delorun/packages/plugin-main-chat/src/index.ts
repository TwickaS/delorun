/**
 * @delorun/plugin-main-chat — the main chat: one continuing chat outside every
 * workspace, from which the person asks about and steers their other chats
 * and starts work in a workspace. Its Session has the fixed id
 * {@link MAIN_CHAT_SESSION_ID} and runs in the directory that holds every
 * workspace. The plugin creates it when the studio first opens it
 * ({@link MAIN_CHAT_PATHS}), on the configured preset, and selects that
 * preset again whenever another is selected for it before its first turn.
 * It is not created at start, since upstream's studio makes a first
 * workspace only while there is no chat at all.
 *
 * The tools in {@link MAIN_CHAT_TOOLS} list, search, read, follow up and
 * stop the person's other chats, list the workspaces, delegate a brief to a
 * new chat in one ({@link mainChatTools}), and, while a `delorunWorkspaces`
 * provider is mounted, change the workspaces behind approvals
 * ({@link accountTools}). A delegated chat reports back
 * ({@link mainChatReports}). Every other chat, the main chat's subagents
 * included, has the tools removed when its agent is created.
 *
 * Everything the plugin registers sits behind the C16 switch `main_chat`
 * ({@link Config.enabled}), off by default: the main chat is an experimental
 * plugin that no Delorun profile mounts until a person adds it.
 *
 * The studio half (`./client`) adds the Main chat row to the top of the
 * sidebar, which opens the main chat through {@link MAIN_CHAT_PATHS}.
 * @module @delorun/plugin-main-chat
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-client-connection'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'
import schema from '@deepseek-ai/schemastery'
import type { AccountLimits } from './account-tools.ts'
import { guardOtherTools } from './guard.ts'
import { mainChatReports, type ReportLimits } from './reports.ts'
import { MAIN_CHAT_TOOLS, mainChatAccountTools, mainChatTools, type ToolLimits } from './tools.ts'
import { MAIN_CHAT_PATHS, MAIN_CHAT_SESSION_ID, REPORT_WAIT_MS, type MainChatReportCount } from './wire.ts'

export { chatLines, newestWithin } from './chat-text.ts'
export { folders, OUTSIDE } from './folders.ts'
export type { Folders } from './folders.ts'
export { accountTools, ALWAYS_ASK, READ_RECORD, readThisTurn } from './account-tools.ts'
export type { AccountLimits, AccountToolDeps } from './account-tools.ts'
export { newOwnerNoteId, OWNER_NOTES_END, OWNER_NOTES_START, OwnerNotesError, ownerNoteText, parseOwnerNotes, renderOwnerNotes } from './owner-notes.ts'
export type { NotedFile, OwnerNote } from './owner-notes.ts'
export { GUARD_AFTER_READ, GUARD_FREE, guardFree, guardOtherTools } from './guard.ts'
export { mainChatReports } from './reports.ts'
export type { ReportLimits, Reports, ReportsWaiting } from './reports.ts'
export { MAIN_CHAT_TOOLS, mainChatAccountTools, MainChatToolError, mainChatTools } from './tools.ts'
export type { MainChatToolErrorCode, ToolLimits } from './tools.ts'
export { MAIN_CHAT_PATHS, MAIN_CHAT_SESSION_ID } from './wire.ts'
export type { MainChatReportCount } from './wire.ts'
export { CreateRequest, folderName, ImportRequest, MAX_URL_LENGTH, repositoryUrl, WorkspaceRefusedError } from '@delorun/plugin-workspaces/service'
export type { DelorunWorkspaces, ImportRow, InstructionsRequest, InstructionsResponse, TrashEntry, WorkspaceRefusalCode, WorkspacesListing } from '@delorun/plugin-workspaces/service'

/** Stable Cordis plugin name. */
export const name = 'delorun-main-chat'

/** Required services: the tool registry, the live agents and their presets, the session controller and query service, the workspace registry, and the Connection for the routes. The account tools also need `delorunWorkspaces`, and register while it is present. */
export const inject = ['tools', 'agents', 'agentPresets', 'sessionController', 'sessionQuery', 'workspaceRegistry', 'connection']

/** The main chat's deployment settings. */
export interface Config extends ToolLimits, ReportLimits, AccountLimits {
  /**
   * C16 switch `main_chat`: whether the plugin registers the main chat's tools, its guard, its reports and its routes.
   * Off, the parity value and the default, it registers nothing; a row that mounts the plugin turns it on.
   */
  readonly enabled: boolean
  /** The absolute directory that holds every workspace, which the main chat runs in. */
  readonly root: string
  /** The agent preset the main chat runs, and the only one it may select. */
  readonly preset: string
}

/** Validated configuration. */
export const Config: schema<Config> = schema.object({
  enabled: schema.boolean().description('C16 switch main_chat: register the main chat\'s tools, guard, reports and routes.').default(false),
  root: schema.string().pattern(/^\/\S*[^/]$/).required().description('The absolute directory that holds every workspace, which the main chat runs in.'),
  preset: schema.string().min(1).required().description('The agent preset the main chat runs, and the only one it may select.'),
  listLimit: schema.natural().min(1).default(30).description('How many chats chat_list answers at most.'),
  readBytes: schema.natural().min(256).default(12_000).description('The largest chat_read answer in UTF-8 bytes; older messages are left out first.'),
  noteChars: schema.natural().min(1).max(10_000).default(2_000).description('The longest owner note, in characters.'),
  reportBytes: schema.natural().min(256).default(2_000).description('The largest report to the main chat in UTF-8 bytes; the reporting chat\'s older messages are left out first.'),
})

const MAIN = SessionId(MAIN_CHAT_SESSION_ID)

/**
 * With the `main_chat` switch on: register the tools, the account tools while a `delorunWorkspaces` provider is
 * mounted, remove them from every other chat, keep the main chat on its preset, and register the routes that create
 * it when it is missing and count its reports.
 * @param ctx - the plugin context with the injected services.
 * @param config - the main chat's settings.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  const reports = mainChatReports(ctx, config.root, config)
  for (const tool of mainChatTools(ctx, config.root, config, reports)) ctx.tools.register(tool)
  ctx.inject(['delorunWorkspaces'], (child) => {
    for (const tool of mainChatAccountTools(child, config.root, config)) child.tools.register(tool)
  })
  guardOtherTools(ctx)

  ctx.on('agent/created', ({ agent }) => {
    if (agent.session.id !== MAIN) agent.ctx.tools.restrict({ deny: [...MAIN_CHAT_TOOLS] })
    return undefined
  })

  // Upstream selects a preset only before a chat's first turn, so selecting the main chat's own again is enough to keep it.
  ctx.on('agent-preset/selected', (sessionId, agentPreset) => {
    if (sessionId !== MAIN || agentPreset === config.preset) return
    const agent = ctx.agents.get(MAIN)
    if (agent === undefined) return
    ctx.agentPresets.select(agent, config.preset).catch((error: unknown) => {
      ctx.logger.warn(`${name}: the main chat could not be moved back to the ${config.preset} preset after ${agentPreset} was selected: ${String(error)}`)
    })
  })

  // Creating the chat a second time would mint a new one once it has a turn, so concurrent opens share one check, and a found chat is not checked again.
  let found = false
  let opening: Promise<void> | undefined
  const open = (signal: AbortSignal): Promise<void> => {
    if (found) return Promise.resolve()
    opening ??= (async () => {
      const { items } = await ctx.sessionController.list({}, signal)
      if (!items.some(item => item.sessionId === MAIN)) await ctx.sessionController.create({ cwd: config.root, sessionId: MAIN, agentPreset: config.preset })
      found = true
    })().finally(() => { opening = undefined })
    return opening
  }
  const lifetime = new AbortController()
  ctx.effect(() => () => { lifetime.abort(new Error(`${name}: the plugin is disposed`)) }, `${name}: the reports' waits`)
  ctx.connection.fetch.register({
    path: MAIN_CHAT_PATHS.reports, methods: ['GET'], requestBody: 'buffered',
    fetch: async (request) => {
      const after = new URL(request.url).searchParams.get('after')
      const count = after === null || !/^\d{1,15}$/.test(after)
        ? reports.waiting()
        : await reports.waitingAfter(Number(after), AbortSignal.any([request.signal, lifetime.signal, AbortSignal.timeout(REPORT_WAIT_MS)]))
      return Response.json(count satisfies MainChatReportCount, { headers: { 'cache-control': 'no-store' } })
    },
  })
  ctx.connection.fetch.register({
    path: MAIN_CHAT_PATHS.open, methods: ['POST'], requestBody: 'buffered',
    fetch: async (request) => {
      try {
        await open(request.signal)
      } catch (error) {
        ctx.logger.warn(`${name}: the main chat could not be created, so the studio did not open it: ${String(error)}`)
        return new Response(null, { status: 502, headers: { 'cache-control': 'no-store' } })
      }
      return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
    },
  })
}
