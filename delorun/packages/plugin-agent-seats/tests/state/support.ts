/**
 * Test support for the seat state specs: a real Session store and projection registry, the seat adapter over a
 * scripted gate and program, and the mounted seat state wired to it as the plugin entry wires it.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type GenerateOptions, type Message, type RequestMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
// Type-only: the `subagent/descriptor` event merge.
import type {} from '@deepseek-ai/dsh-subagent'
import { onTestFinished } from 'vitest'
import { SeatAdapter, type SeatHost } from '../../src/adapter/adapter.ts'
import { mountSeatState, type SeatStateMount, type SeatStateOptions } from '../../src/state/index.ts'
import { ScriptedGate, ROUTE } from '../adapter/support.ts'

export { ROUTE, ScriptedGate, ScriptedProgram } from '../adapter/support.ts'

/** A mounted seat state over one seat child. */
export interface StateWorld {
  readonly ctx: Context
  readonly session: Session
  readonly child: SessionId
  readonly adapter: SeatAdapter
  readonly gate: ScriptedGate
  readonly mount: SeatStateMount
  /** The messages the Resume button sent. */
  readonly prompts: Array<{ readonly child: SessionId, readonly text: string }>
  /** What the mount could not report to the person. */
  readonly warnings: string[]
  /** The folder the model picks are kept in. */
  readonly dir: string
  /** Log a message of the person in the child's log and return it as the request carries it. */
  say(text: string): Message
  /** A request of the child's route over `messages`. */
  request(messages: RequestMessage[], extra?: Partial<GenerateOptions>): GenerateOptions
}

/**
 * A Context with the Session store and the projection registry.
 * @returns the context, disposed when the test finishes.
 */
export async function sessionContext(): Promise<Context> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  return ctx
}

/**
 * Append the descriptor that makes a Session a seat child of an agent.
 * @param session - the Session.
 * @param provider - the subagent provider name.
 */
export function describeSeat(session: Session, provider = 'claude-code-seat'): void {
  session.append('subagent/descriptor', { version: 3, mode: 'continuable', provider, label: 'task' })
}

/**
 * Mount the seat state on a seat child with a scripted program behind its adapter.
 * @param options - ports to change.
 * @returns the world.
 */
export async function stateWorld(options: Partial<SeatStateOptions> = {}): Promise<StateWorld> {
  const ctx = await sessionContext()
  const session = ctx.sessions.create()
  describeSeat(session)
  const child = session.header.id
  const dir = await mkdtemp(join(tmpdir(), 'ea2-seat-state-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  const gate = new ScriptedGate()
  gate.seats.set(child, { child, root: SessionId('root'), provider: 'claude-code' })
  const prompts: Array<{ child: SessionId, text: string }> = []
  const warnings: string[] = []
  let adapter: SeatAdapter | undefined
  const mount = await mountSeatState(ctx, {
    sessions: ctx.sessions,
    runOf: id => adapter?.runOf(id),
    workspaceOf: () => 'workspace-1',
    dir,
    prompt: (id, text) => { prompts.push({ child: id, text }); return Promise.resolve() },
    warn: message => { warnings.push(message) },
    ...options,
  })
  const host: SeatHost = {
    descriptorProvider: () => 'claude-code',
    creator: () => SessionId('root'),
    cwd: () => '/work',
    workspaceOf: () => 'workspace-1',
    approve: () => Promise.resolve('allow-once'),
  }
  adapter = new SeatAdapter({
    route: ROUTE, provider: 'claude-code', descriptorProvider: 'claude-code', displayName: 'Claude Code', contextWindow: 200_000,
    gate, host, states: mount.store, models: mount.choices, events: mount.events,
  })
  return {
    ctx, session, child, adapter, gate, mount, prompts, warnings, dir,
    say: (text) => {
      const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
      session.append('user/message', message, { surfaceOp: 'append' })
      return message
    },
    request: (messages, extra = {}) => ({ provider: ROUTE, model: 'default', messages, sessionId: child, ...extra }),
  }
}

/**
 * Wait for a condition on the event loop.
 * @param check - the condition.
 * @param label - what is waited for, for the failure message.
 */
export async function until(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error(`timed out waiting for ${label}`)
}
