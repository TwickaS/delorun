/** A person's Stop and an archive end the external runs their chat started, and no others. */

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionActivity } from '@deepseek-ai/dsh-workspace'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '../src/index.ts'
import { TestSessionQuery } from './test-session-query.ts'
import type { SubagentCapabilities, SubagentResult, SubagentRun } from '../src/types.ts'
import { externalTestParent } from './external-activation-helpers.ts'
import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'

const capabilities: SubagentCapabilities = {
  agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false,
}

/** Whether a process id still names a live process. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** A stand-in program that runs until it is killed, as the Claude Code and Codex children do. */
function standIn(): { run: SubagentRun; pid: number } {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  const exited = once(child, 'exit')
  onTestFinished(() => { child.kill('SIGKILL') })
  const result = exited.then((): SubagentResult => ({ output: [], stopReason: 'aborted' }))
  const run: SubagentRun = {
    id: SessionId(randomUUID()),
    result,
    dispose: async () => {
      child.kill('SIGKILL')
      await exited
    },
  }
  return { run, pid: child.pid as number }
}

function activityOf(ctx: Context, sessionId: SessionId): Promise<readonly SessionActivity[]> {
  return ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
}

async function setup() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionProjectionRegistry)
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(TestSessionQuery)
  const pids: number[] = []
  ctx.subagents.registerProvider({
    name: 'external',
    capabilities,
    inheritsParentContext: false,
    start: () => {
      const started = standIn()
      pids.push(started.pid)
      return Promise.resolve(started.run)
    },
  })
  const startRun = async (parent: Agent): Promise<number> => {
    await ctx.subagents.startActivation({
      provider: 'external', label: 'External work', signal: new AbortController().signal, delivery: 'caller',
      parent, prompt: [{ type: 'text', text: 'Work independently' }],
    })
    return pids.at(-1) as number
  }
  const openTurn = (parent: Agent, turn: number): void => { parent.session.append('turn/start', { turn }) }
  const endTurn = (parent: Agent, turn: number, cause: 'completed' | 'user' | 'hook' | 'parent' | 'disposed'): void => {
    parent.session.append('turn/end', {
      turn,
      reason: cause === 'completed' ? { kind: 'completed' } : { kind: 'aborted', reason: cause === 'hook' ? { kind: 'hook', reason: 'x' } : { kind: cause } },
    })
  }
  const gone = async (pid: number): Promise<void> => { await expect.poll(() => alive(pid)).toBe(false) }
  return { ctx, startRun, openTurn, endTurn, gone }
}

describe('stopping external runs', () => {
  it('archiving a chat lists and ends its external runs, and leaves another chat\'s run', async () => {
    const { ctx, startRun, gone } = await setup()
    const chat = await externalTestParent(ctx)
    const other = await externalTestParent(ctx)
    const pid = await startRun(chat)
    const otherPid = await startRun(other)

    const activity = await activityOf(ctx, chat.id)
    expect(activity.map(item => item.kind)).toEqual(['subagent'])
    await ctx.parallel('workspace/session-stop', { sessionId: chat.id })

    await gone(pid)
    expect(alive(otherPid)).toBe(true)
  })

  it.each(['user', 'hook', 'parent'] as const)('a %s cancel of the turn ends the runs that turn started', async (cause) => {
    const { ctx, startRun, openTurn, endTurn, gone } = await setup()
    const chat = await externalTestParent(ctx)
    const other = await externalTestParent(ctx)
    openTurn(chat, 1)
    openTurn(other, 1)
    const pid = await startRun(chat)
    const otherPid = await startRun(other)

    endTurn(chat, 1, cause)

    await gone(pid)
    expect(alive(otherPid)).toBe(true)
  })

  it('keeps a run from an earlier turn when a later turn is stopped', async () => {
    const { ctx, startRun, openTurn, endTurn, gone } = await setup()
    const chat = await externalTestParent(ctx)
    openTurn(chat, 1)
    const earlier = await startRun(chat)
    endTurn(chat, 1, 'completed')
    openTurn(chat, 2)
    const current = await startRun(chat)

    endTurn(chat, 2, 'user')

    await gone(current)
    expect(alive(earlier)).toBe(true)
  })

  it('records no turn for a run accepted after its chat\'s turn ended', async () => {
    const { ctx, startRun, openTurn, endTurn } = await setup()
    const chat = await externalTestParent(ctx)
    openTurn(chat, 1)
    endTurn(chat, 1, 'completed')
    const outside = await startRun(chat)

    endTurn(chat, 1, 'user')

    // A stop is asynchronous, so give a wrongly attributed one time to land.
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(alive(outside)).toBe(true)
  })

  it('leaves the runs alone when the turn ends normally or by disposal', async () => {
    const { ctx, startRun, openTurn, endTurn } = await setup()
    const chat = await externalTestParent(ctx)
    openTurn(chat, 1)
    const first = await startRun(chat)
    endTurn(chat, 1, 'completed')
    openTurn(chat, 2)
    const second = await startRun(chat)
    endTurn(chat, 2, 'disposed')

    expect(alive(first)).toBe(true)
    expect(alive(second)).toBe(true)
  })
})

describe('a cancel arriving while an external run starts', () => {
  async function startingProvider(honoursSignal: boolean) {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SessionProjectionRegistry)
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(TestSessionQuery)
    const spawned = Promise.withResolvers<{ run: SubagentRun; pid: number; signal: AbortSignal }>()
    const finish = Promise.withResolvers<undefined>()
    ctx.subagents.registerProvider({
      name: 'external',
      capabilities,
      inheritsParentContext: false,
      start: async ({ signal }) => {
        const started = standIn()
        spawned.resolve({ ...started, signal })
        if (honoursSignal) {
          signal.addEventListener('abort', () => { finish.resolve(undefined) }, { once: true })
          await finish.promise
          await started.run.dispose()
          signal.throwIfAborted()
        } else {
          await finish.promise
        }
        return started.run
      },
    })
    const chat = await externalTestParent(ctx)
    const toolCall = new AbortController()
    const starting = ctx.subagents.startActivation({
      provider: 'external', label: 'External work', signal: toolCall.signal, delivery: 'caller',
      parent: chat, prompt: [{ type: 'text', text: 'Work independently' }],
    })
    return { ctx, chat, toolCall, starting, finish, started: await spawned.promise }
  }

  it('hands the start the tool call\'s own cancellation and leaves no process when the start stops', async () => {
    const { ctx, chat, toolCall, starting, started } = await startingProvider(true)
    const rejected = expect(starting).rejects.toThrow('cancelled mid-start')
    toolCall.abort(new Error('cancelled mid-start'))

    expect(started.signal.aborted).toBe(true)
    await rejected
    await expect.poll(() => alive(started.pid)).toBe(false)
    expect(await activityOf(ctx, chat.id)).toEqual([])
  })

  it('rolls the run back when the start finishes after the cancel without noticing it', async () => {
    const { ctx, chat, toolCall, starting, finish, started } = await startingProvider(false)
    const rejected = expect(starting).rejects.toThrow('cancelled mid-start')
    toolCall.abort(new Error('cancelled mid-start'))
    finish.resolve(undefined)

    await rejected
    await expect.poll(() => alive(started.pid)).toBe(false)
    expect(await activityOf(ctx, chat.id)).toEqual([])
  })
})
