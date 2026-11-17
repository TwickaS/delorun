/**
 * Registers each seat's hidden route on `ctx.llm` and reads a seat child's facts from the Host's session store.
 * @module @delorun/plugin-agent-seats/adapter/register
 */
import type { Context } from '@deepseek-ai/cordis'
import { foldSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ExternalAgentName, ProgramApprovalAnswer, ProgramApprovalRequest } from '@delorun/external-agents/contract'
import { SeatAdapter, type SeatHost } from './adapter.ts'
import type { SeatAdapterEvents, SeatModelChoices, SeatStateStore } from './state-port.ts'

/** One seat route to register. */
export interface SeatRouteSpec {
  /** The hidden route id. */
  readonly route: string
  /** The agent the route runs. */
  readonly provider: ExternalAgentName
  /** The `ctx.subagents` provider id whose children are this route's seats. */
  readonly descriptorProvider: string
  /** The agent's display name. */
  readonly displayName: string
  /** The program's context window in tokens. */
  readonly contextWindow: number
}

/** What the routes need from the rest of the seat plugin. */
export interface SeatRouteDependencies {
  /** The seat's logged state. */
  readonly states: SeatStateStore
  /** The model a person picked per workspace. */
  readonly models: SeatModelChoices
  /** What the adapter reports to the rest of the plugin. */
  readonly events?: SeatAdapterEvents
  /**
   * The workspace key a child's model pick is kept under.
   * @param child - the seat child.
   * @returns the key, or undefined.
   */
  workspaceOf(child: SessionId): string | undefined
  /**
   * Ask the person about one of the program's tool calls (the relay's).
   * @param child - the seat child.
   * @param request - the program's question.
   * @returns the person's answer.
   */
  approve(child: SessionId, request: ProgramApprovalRequest): Promise<ProgramApprovalAnswer>
}

/** The adapters registered, by route, for the executor and the relay. */
export type SeatRouteRegistration = ReadonlyMap<string, SeatAdapter>

/**
 * Register one adapter per seat route as a registration effect of `ctx`. The routes list no models, so no picker
 * shows them; each adapter refuses any request that is not a seat child's own turn.
 * @param ctx - the plugin context with `llm`, `sessions` and `externalAgents`.
 * @param routes - the seat routes.
 * @param dependencies - the ports the adapters read.
 * @returns the adapters by route.
 */
export function registerSeatRoutes(
  ctx: Context,
  routes: readonly SeatRouteSpec[],
  dependencies: SeatRouteDependencies,
): SeatRouteRegistration {
  const host: SeatHost = {
    descriptorProvider: (child) => {
      const session = ctx.sessions.get(child)
      return session === undefined ? undefined : foldSubagentDescriptor(session.snapshotEvents())?.provider
    },
    creator: child => ctx.sessions.get(child)?.header.parentSession,
    cwd: child => ctx.sessions.get(child)?.header.cwd,
    workspaceOf: dependencies.workspaceOf,
    approve: dependencies.approve,
  }
  const adapters = new Map<string, SeatAdapter>()
  for (const spec of routes) {
    const adapter = new SeatAdapter({
      ...spec,
      gate: { start: request => ctx.externalAgents.start(request), seat: child => ctx.externalAgents.seat(child) },
      host,
      states: dependencies.states,
      models: dependencies.models,
      ...dependencies.events === undefined ? {} : { events: dependencies.events },
    })
    adapters.set(spec.route, adapter)
    ctx.effect(() => ctx.llm.registerAdapter([spec.route], adapter), `delorun-agent-seats: model route ${spec.route}`)
  }
  return adapters
}
