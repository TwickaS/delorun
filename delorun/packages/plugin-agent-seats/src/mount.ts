/**
 * Mounts live agents while the preview flag is on: the seat state, the model routes, the hand-off tools, the seat
 * presets and the two Host routes the chat's buttons call. The question relay is the one part supplied from outside.
 * @module @delorun/plugin-agent-seats/mount
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.profileContext merge.
import type {} from '@deepseek-ai/dsh-app-boot'
import { brandString } from '@deepseek-ai/dsh-brand'
// Type-only: the ctx.connection merge.
import type {} from '@deepseek-ai/dsh-client-connection'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentPromptRequestId } from '@deepseek-ai/dsh-subagent'
// Type-only: the ctx.workspaceRegistry merge.
import type {} from '@deepseek-ai/dsh-workspace'
import { agentTitle } from '@delorun/external-agents/copy'
import type { ProgramApprovalAnswer, ProgramApprovalRequest } from '@delorun/external-agents/contract'
import { gateByUnlock, requireComputerOrDevice, routedPathname } from '@delorun/home-auth'
import { registerSeatRoutes, type SeatRouteRegistration, type SeatRouteSpec } from './adapter/index.ts'
import type { Config } from './config.ts'
import { followLeaseEnds } from './lease.ts'
import { isExternalAgentName, registerSeatProviders, seatProviderName } from './provider/index.ts'
import { seatPreset } from './executor/index.ts'
import { mountSeatState, type SeatStateMount } from './state/index.ts'

/** What a relay is built from: the mounted seat state and the exact provider names that identify a seat child. */
export interface SeatRelayWiring {
  /** The plugin context. */
  readonly ctx: Context
  /** The mounted seat state; the relay reads its call-record ledger and reports pending questions to it. */
  readonly state: SeatStateMount
  /** The `subagent/descriptor` provider names of the configured seats, such as `claude-code-seat`. */
  readonly seatProviders: ReadonlySet<string>
}

/**
 * Builds the answer path for a program's permission questions.
 * @param wiring - the mounted seat state and the seat provider names.
 * @returns the decision for one question; it answers `reject` for a child it does not serve.
 */
export type SeatRelayHook = (wiring: SeatRelayWiring) => (child: SessionId, request: ProgramApprovalRequest) => Promise<ProgramApprovalAnswer>

/** What the entry passes to {@link mountSeats}. */
export interface SeatMountOptions {
  /** The question relay; without one every question of a program is rejected. */
  readonly relay?: SeatRelayHook
}

const RESUME_LABEL = 'Resuming or choosing a model for a live agent'

/**
 * Mount live agents on a context whose preview flag is on.
 * @param ctx - the plugin context with the services of the `inject` list.
 * @param config - the validated row configuration.
 * @param options - the relay.
 * @returns the mounted seat state.
 * @throws when a seat names an agent the gate does not run, two seats share a name, or the profile has no folder.
 */
export async function mountSeats(ctx: Context, config: Config, options: SeatMountOptions = {}): Promise<SeatStateMount> {
  const dir = ctx.get('profileContext')?.dir
  if (dir === undefined) throw new Error('delorun-agent-seats: live agents keep the chosen models in the profile folder, and this profile has none')
  // Fails before anything registers when the seat list is unusable.
  registerSeatProviders(ctx, config, () => true)
  const logger = ctx.logger('agent-seats')
  let adapters: SeatRouteRegistration = new Map()
  // The registry's workspace of the child when it lists one, otherwise the child's run folder.
  const workspaceOf = (child: SessionId): string | undefined => ctx.get('workspaceRegistry')?.list().find(workspace => workspace.sessionIds.includes(child))?.id
    ?? ctx.sessions.get(child)?.header.cwd
  const state = await mountSeatState(ctx, {
    sessions: ctx.sessions,
    runOf: (child) => {
      for (const adapter of adapters.values()) {
        const run = adapter.runOf(child)
        if (run !== undefined) return run
      }
      return undefined
    },
    workspaceOf,
    dir,
    prompt: async (child, text, signal) => {
      await ctx.subagents.prompt({
        requestId: brandString<SubagentPromptRequestId>(randomUUID()),
        childSessionId: child,
        delivery: 'queue',
        content: [{ type: 'text', text }],
      }, signal)
    },
    warn: (message) => { logger.warn(message) },
  })
  const seatProviders = new Set(config.seats.map(seat => seatProviderName(seat.provider)))
  const decide = options.relay?.({ ctx, state, seatProviders })
  const routes: SeatRouteSpec[] = []
  for (const seat of config.seats) {
    if (!isExternalAgentName(seat.provider)) continue
    routes.push({
      route: seat.route,
      provider: seat.provider,
      descriptorProvider: seatProviderName(seat.provider),
      displayName: agentTitle(seat.provider),
      contextWindow: seat.contextWindow,
    })
  }
  adapters = registerSeatRoutes(ctx, routes, {
    states: state.store,
    models: state.choices,
    events: state.events,
    workspaceOf,
    approve: (child, request) => decide === undefined ? Promise.resolve('reject') : decide(child, request),
  })
  for (const seat of config.seats) {
    const dispose = await ctx.agentPresets.register(seatPreset(seat))
    ctx.effect(() => dispose, `delorun-agent-seats: preset ${seat.preset}`)
  }
  followLeaseEnds(ctx, (child, text) => {
    for (const adapter of adapters.values()) {
      adapter.release(child).catch((error: unknown) => { logger.warn(`the program of ${child} did not close: ${String(error)}`) })
    }
    // An archived chat's Session may not be loaded, and then there is no live chat to tell.
    if (ctx.sessions.get(child) !== undefined && state.store.viewOf(child) !== null) state.end(child, text)
  })
  const paths = new Set(state.routes.map(route => route.path))
  // Before the body is read: only the computer or a reach device reaches these routes, and a device needs an unlock.
  ctx.on('connection/request', async (request, response, next) => {
    if (paths.has(routedPathname(request.url)) && !requireComputerOrDevice(request, response, ctx.get('homeAuth'), RESUME_LABEL)) return
    await next()
  })
  for (const route of state.routes) {
    ctx.effect(() => ctx.connection.fetch.register({
      path: route.path,
      methods: route.methods,
      requestBody: 'buffered',
      ...gateByUnlock(() => ctx.get('homeAuth'), route.fetch, { renews: true }),
    }), `delorun-agent-seats: route ${route.path}`)
  }
  return state
}
