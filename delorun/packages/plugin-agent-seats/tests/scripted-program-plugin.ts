/**
 * A Cordis plugin that registers a scripted driver for Claude Code or Codex with the start gate, for the keyless
 * recorded-session snapshots of live agents. No process starts: each turn plays the steps its row lists, so a snapshot
 * runs the real hand-off tool, seat provider, adapter, executor and relay against a program that does only what the
 * scenario says.
 *
 * A row names the agent and one list of steps per program turn. A step is `event` (a program event to emit), `steer`
 * (wait for the person's message at the next tool boundary; `{{steer}}` in later text stands for it), `interrupt`
 * (wait for Stop and end the turn as interrupted) or `ask` (raise a permission question about a call and wait for the
 * answer; `{{answer}}` stands for it).
 * @module @delorun/plugin-agent-seats/tests/scripted-program-plugin
 */
import type { Context } from '@deepseek-ai/cordis'
import { ProgramOpenError } from '@delorun/external-agents/contract'
import type {
  AccountObservation, ExternalAgentDriver, ExternalAgentName, ProgramApprovalAnswer, ProgramEvent, ProgramInterruptOutcome,
  ProgramOpenRequest, ProgramSession,
} from '@delorun/external-agents/contract'

// Type-only: the ctx.externalAgents merge.
import type {} from '@delorun/external-agents'

/** One step of a scripted program turn. */
export type ScriptStep =
  | { readonly event: ProgramEvent }
  | { readonly steer: true }
  | { readonly interrupt: true }
  | { readonly ask: { readonly callId: string; readonly toolName: string; readonly reason: string; readonly runRule?: boolean } }

/** The row's configuration. */
export interface ScriptedProgramConfig {
  /** The agent the driver runs. */
  readonly provider: ExternalAgentName
  /** The steps of each program turn, in order. */
  readonly turns: readonly (readonly ScriptStep[])[]
  /** What the scripted program reports for its own sandbox; absent means off. */
  readonly sandbox?: 'on' | 'off' | 'own'
  /** What `probe` reports; absent means signed in with no limits. */
  readonly account?: Omit<AccountObservation, 'provider' | 'source'>
  /** Makes `open` fail with this limit, so a start ends as a reached plan limit. */
  readonly openFailsAtLimit?: { readonly resetsAt: number }
  /** Makes `open` fail because the configured model is not on the plan, so a start ends at the model picker. */
  readonly openFailsModelNotOffered?: { readonly configured: string; readonly offered: readonly { readonly id: string; readonly displayName: string; readonly isDefault: boolean }[] }
}

/** The Loader row name. */
export const name = 'scripted-program'

/** The services the plugin needs. */
export const inject = ['externalAgents']

/** A program session that plays its row's turns. */
class ScriptedSession implements ProgramSession {
  readonly programSessionId: string
  turnRunning = false
  sandbox: 'on' | 'off' | 'own' = 'off'
  private readonly request: ProgramOpenRequest
  private readonly turns: readonly (readonly ScriptStep[])[]
  private turn = 0
  private readonly queue: ProgramEvent[] = []
  private waiter: PromiseWithResolvers<ProgramEvent> | undefined
  private steers: string[] = []
  private steerWaiter: PromiseWithResolvers<string> | undefined
  private interruptWaiter: PromiseWithResolvers<void> | undefined
  private interrupted = false
  private lastAnswer: ProgramApprovalAnswer | undefined

  constructor(request: ProgramOpenRequest, turns: readonly (readonly ScriptStep[])[], programSessionId: string) {
    this.request = request
    this.turns = turns
    this.programSessionId = programSessionId
  }

  send(text: string, mode: 'start' | 'steer'): Promise<void> {
    if (mode === 'steer') {
      const waiter = this.steerWaiter
      this.steerWaiter = undefined
      if (waiter === undefined) this.steers.push(text)
      else waiter.resolve(text)
      return Promise.resolve()
    }
    this.turnRunning = true
    this.interrupted = false
    const steps = this.turns[this.turn++]
    if (steps === undefined) throw new Error(`scripted program: the script has no turn ${this.turn}`)
    void this.play(steps)
    return Promise.resolve()
  }

  interrupt(): Promise<ProgramInterruptOutcome> {
    this.interrupted = true
    const waiter = this.interruptWaiter
    this.interruptWaiter = undefined
    if (waiter === undefined) this.emit({ kind: 'turn-end', outcome: 'interrupted' })
    else waiter.resolve()
    return Promise.resolve('interrupted')
  }

  next(signal: AbortSignal): Promise<ProgramEvent> {
    const ready = this.queue.shift()
    if (ready !== undefined) return Promise.resolve(ready)
    const waiter = Promise.withResolvers<ProgramEvent>()
    this.waiter = waiter
    signal.addEventListener('abort', () => {
      if (this.waiter === waiter) this.waiter = undefined
      waiter.reject(signal.reason)
    }, { once: true })
    return waiter.promise
  }

  close(): Promise<void> {
    return Promise.resolve()
  }

  private emit(event: ProgramEvent): void {
    if (event.kind === 'turn-end') this.turnRunning = false
    const waiter = this.waiter
    this.waiter = undefined
    if (waiter === undefined) this.queue.push(event)
    else waiter.resolve(event)
  }

  private async play(steps: readonly ScriptStep[]): Promise<void> {
    let steered = ''
    const fill = (text: string): string => text.replaceAll('{{steer}}', steered).replaceAll('{{answer}}', this.lastAnswer ?? '')
    for (const step of steps) {
      if (this.interrupted) return
      if ('event' in step) {
        const { event } = step
        this.emit(event.kind === 'text' || event.kind === 'reasoning' ? { ...event, text: fill(event.text) } : event)
      } else if ('steer' in step) {
        const queued = this.steers.shift()
        if (queued !== undefined) steered = queued
        else {
          this.steerWaiter = Promise.withResolvers<string>()
          steered = await this.steerWaiter.promise
        }
      } else if ('interrupt' in step) {
        this.interruptWaiter = Promise.withResolvers<void>()
        await this.interruptWaiter.promise
        this.emit({ kind: 'turn-end', outcome: 'interrupted' })
        return
      } else {
        const { ask } = step
        this.lastAnswer = await this.request.onApproval({
          callId: ask.callId,
          toolName: ask.toolName,
          reason: ask.reason,
          ...ask.runRule === true ? { runRule: { provider: 'claude-code', summary: ask.reason, data: { rule: ask.toolName } } } : {},
          signal: this.request.signal,
        })
      }
    }
  }
}

/**
 * Register the scripted driver while the row runs.
 * @param ctx - the plugin context with the gate.
 * @param config - the row's configuration.
 */
export function apply(ctx: Context, config: ScriptedProgramConfig): void {
  let opened = 0
  const driver: ExternalAgentDriver = {
    provider: config.provider,
    open: (request) => {
      if (config.openFailsAtLimit !== undefined) {
        return Promise.reject(new ProgramOpenError({ category: 'limit', resetsAt: config.openFailsAtLimit.resetsAt }))
      }
      if (config.openFailsModelNotOffered !== undefined) {
        return Promise.reject(new ProgramOpenError({ category: 'model-not-offered', ...config.openFailsModelNotOffered }))
      }
      opened++
      const session = new ScriptedSession(request, config.turns, request.resume ?? `program-${config.provider}-${opened}`)
      session.sandbox = config.sandbox ?? 'off'
      return Promise.resolve(session)
    },
    probe: () => Promise.resolve({ provider: config.provider, signedIn: 'yes', windows: [], source: 'probe', ...config.account }),
  }
  ctx.effect(() => ctx.externalAgents.registerDriver(driver), `scripted-program: driver ${config.provider}`)
}
