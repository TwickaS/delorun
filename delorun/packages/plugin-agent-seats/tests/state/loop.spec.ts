/**
 * The seat state on the production AgentLoop: records appended while the adapter's stream is open, the view across a
 * turn, a message that follows a reached limit, and Stop through the turn's own cancellation.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { pluginRecordOf, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, onTestFinished } from 'vitest'
import { SeatAdapter, type SeatHost } from '../../src/adapter/adapter.ts'
import { mountSeatState, RESUME_PATH, SEAT_NOTICE_RECORD, SEAT_STATE_RECORD, SEAT_STATUS_RECORD } from '../../src/state/index.ts'
import { ROUTE, ScriptedGate, describeSeat, until } from './support.ts'

const say = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

/** Mount the loop, the seat state and the adapter, and create a seat child. */
async function setup(tail?: () => Promise<{ lastMessageId?: string }>) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  const harness = await mountAgentLoopTestHarness(ctx)
  const dir = await mkdtemp(join(tmpdir(), 'ea2-seat-loop-'))
  const gate = new ScriptedGate()
  let adapter: SeatAdapter | undefined
  let agent: Agent | undefined
  const mount = await mountSeatState(ctx, {
    sessions: ctx.sessions,
    runOf: id => adapter?.runOf(id),
    workspaceOf: () => 'workspace-1',
    dir,
    prompt: (_child, text) => {
      agent?.followup(say(text))
      return Promise.resolve()
    },
    ...tail === undefined ? {} : { tail },
    now: () => 10_000,
    warn: (message) => { throw new Error(message) },
  })
  onTestFinished(async () => {
    await mount.settled()
    await rm(dir, { recursive: true, force: true })
  })
  const host: SeatHost = {
    descriptorProvider: () => 'claude-code',
    creator: () => SessionId('root'),
    cwd: () => '/work',
    workspaceOf: () => 'workspace-1',
    approve: () => Promise.resolve('allow-once'),
  }
  adapter = new SeatAdapter({
    route: ROUTE, provider: 'claude-code', descriptorProvider: 'claude-code', displayName: 'Claude Code', recordPrefix: 'claude_code.', contextWindow: 200_000,
    gate, host, states: mount.store, models: mount.choices, events: mount.events,
  })
  ctx.llm.registerAdapter([ROUTE], adapter)
  agent = await harness.create(SessionId('seat-child'), { provider: ROUTE, model: 'default' })
  describeSeat(agent.session)
  gate.seats.set(agent.id, { child: agent.id, root: SessionId('root'), provider: 'claude-code' })
  const idle = (): Promise<void> => new Promise<void>((resolve) => {
    const dispose = ctx.on('agent/status', (event) => {
      if (event.agent === agent && event.status === 'idle') { dispose(); resolve() }
    })
  })
  return { ctx, agent, adapter, gate, mount, idle }
}

const kinds = (agent: Agent): string[] => agent.session.snapshotEvents().map((event) => {
  const record = pluginRecordOf(event)
  return record === undefined ? event.type : record.type.replace('plugin:delorun/agent-seat/', 'seat:')
})

describe('the seat state on the production loop', () => {
  it('logs its records while the adapter\'s stream is open and shows the turn in the view', async () => {
    const { agent, gate, mount, idle } = await setup()
    const done = idle()
    agent.followup(say('list the files'))
    await until(() => gate.programs.length === 1 && mount.store.viewOf(agent.id)?.state === 'working', 'the working state')
    expect(gate.latest.sent).toEqual([{ text: 'list the files', mode: 'start' }])
    gate.latest.emit({ kind: 'text', text: 'Three files.' }, { kind: 'turn-end', outcome: 'completed' })
    await done

    const log = kinds(agent)
    const at = (type: string): number => log.indexOf(type)
    expect(at('turn/start')).toBeLessThan(at('seat:status'))
    expect(at('seat:status')).toBeLessThan(at('seat:state'))
    expect(at('seat:state')).toBeLessThan(at('assistant/message'))
    expect(log.at(-1)).toBe('turn/end')
    expect(mount.store.viewOf(agent.id)).toMatchObject({ agent: 'claude-code', state: 'idle', lastAnswer: 'Three files.' })
    expect(mount.store.read(agent.id)).toMatchObject({ programSessionId: 'program-1' })
  })

  it('keeps the limit and its reset time after the turn, and a later message starts a new turn', async () => {
    const { agent, gate, mount, idle } = await setup()
    let done = idle()
    agent.followup(say('big task'))
    await until(() => gate.programs.length === 1 && mount.store.viewOf(agent.id)?.state === 'working', 'the working state')
    gate.latest.emit({ kind: 'turn-end', outcome: 'failed', failure: { category: 'limit', resetsAt: 5000 } })
    await done
    expect(mount.store.viewOf(agent.id)).toMatchObject({ state: 'limit', resetAt: 5000 })

    done = idle()
    const resume = mount.routes.find(route => route.path === RESUME_PATH)
    const answer = await resume?.fetch(new Request('http://delorun.test/', { method: 'POST', body: JSON.stringify({ child: agent.id }) }))
    expect(answer?.status).toBe(200)
    await until(() => gate.latest.sent.length === 2, 'the resumed turn')
    expect(gate.latest.sent[1]).toEqual({ text: 'Continue.', mode: 'start' })
    expect(mount.store.viewOf(agent.id)?.state).toBe('working')
    gate.latest.emit({ kind: 'turn-end', outcome: 'completed' })
    await done
    expect(mount.store.viewOf(agent.id)?.state).toBe('idle')
  })

  it('stops the program when the turn is cancelled, and forgets the program message of a stopped turn', async () => {
    const { agent, gate, mount, idle } = await setup(() => Promise.resolve({ lastMessageId: 'program-message-3' }))
    let done = idle()
    agent.followup(say('first'))
    await until(() => gate.programs.length === 1 && mount.store.viewOf(agent.id)?.state === 'working', 'the working state')
    gate.latest.emit({ kind: 'turn-end', outcome: 'completed' })
    await done
    await until(() => mount.store.stateOf(agent.id).logged.programMessageId === 'program-message-3', 'the recorded program message')

    done = idle()
    agent.followup(say('second'))
    await until(() => gate.latest.sent.length === 2, 'the second turn')
    agent.cancel({ kind: 'user' })
    await done
    expect(gate.latest.interrupts).toBe(1)
    await until(() => mount.store.stateOf(agent.id).logged.programMessageId === null, 'the forgotten program message')
    expect(mount.store.viewOf(agent.id)?.state).toBe('idle')
    expect(kinds(agent).filter(kind => kind === 'seat:notice')).toEqual([])
  })

  it('writes the three record types under the names the catalog lists', () => {
    expect([SEAT_STATE_RECORD, SEAT_STATUS_RECORD, SEAT_NOTICE_RECORD]).toEqual([
      'plugin:delorun/agent-seat/state', 'plugin:delorun/agent-seat/status', 'plugin:delorun/agent-seat/notice',
    ])
  })
})
