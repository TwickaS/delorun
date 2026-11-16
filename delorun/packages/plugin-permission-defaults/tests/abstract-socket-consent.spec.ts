/**
 * Specs of the first-refusal consent for the abstract-socket risk: one ask per workspace before a confined command that
 * the runners would refuse, an allow that records what the Network section records, a decline that does not ask again,
 * no ask without an answerer, and no way for the model's call to answer.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { AbstractSocketConsent, abstractSocketAsk } from '../src/abstract-socket-consent.ts'
import { CommandNetwork } from '../src/command-network.ts'

const roots: string[] = []
const contexts: Context[] = []
const originalHome = process.env['DELORUN_HOME']

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  if (originalHome === undefined) delete process.env['DELORUN_HOME']
  else process.env['DELORUN_HOME'] = originalHome
})

interface Mounted {
  readonly ctx: Context
  readonly network: CommandNetwork
  readonly work: string
  readonly asked: { reason?: string, grants?: string, toolName: string }[]
  readonly mode: { value: string }
}

/** Mount the service under a fresh home, with a fake approval service answering `answer` and a sandbox policy in `mode`. */
async function mounted(answer: ApprovalOutcome | 'throws' | 'absent' = 'allowed-once'): Promise<Mounted> {
  const root = mkdtempSync(join(tmpdir(), 'dac-'))
  roots.push(root)
  const home = join(root, 'home')
  const work = join(root, 'work')
  for (const directory of [home, work]) mkdirSync(directory, { recursive: true, mode: 0o700 })
  process.env['DELORUN_HOME'] = home
  const ctx = new Context()
  contexts.push(ctx)
  const asked: Mounted['asked'] = []
  const mode = { value: 'workspace-write' }
  ctx.provide('connection', { fetch: { register: () => () => {} } } as never)
  ctx.provide('workspaceRegistry', { list: () => [] } as never)
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: mode.value }) } as never)
  if (answer !== 'absent') {
    ctx.provide('approval', {
      request: (request: { reason?: string, grants?: string, toolName: string }) => {
        asked.push(request)
        return answer === 'throws' ? Promise.reject(new Error('no channel')) : Promise.resolve(answer)
      },
    } as never)
  }
  await ctx.plugin(CommandNetwork, { defaultNetwork: { access: 'open', hosts: [] }, proxyConnectTimeoutMs: 1_000, proxyMaxConnections: 8, proxyIdleTimeoutMs: 60_000 })
  return { ctx, network: ctx.delorunCommandNetwork, work, asked, mode }
}

function bash(cwd: string | undefined, args: object = { command: 'docker ps' }, name = 'bash'): ToolExecution {
  const id = SessionId('s-consent')
  const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false, ...cwd === undefined ? {} : { cwd } })
  return { name, arguments: args, callId: 'c1', agent: { session } } as never
}

const listening = { kind: 'names', names: ['@docker_cli_ab12'] } as const
const quiet = { kind: 'names', names: [] } as const

function consent(m: Mounted, found: () => typeof listening | typeof quiet | { kind: 'unreadable', reason: string } = () => listening, applies = true): AbstractSocketConsent {
  return new AbstractSocketConsent(m.ctx, m.network, { check: found, applies })
}

describe('the first-refusal consent', () => {
  it('asks once on the first refusable command, as a full-access card the model cannot answer', async () => {
    const m = await mounted('rejected')
    const review = consent(m)
    expect(await review.review(bash(m.work))).toEqual({ kind: 'allow' })
    expect(await review.review(bash(m.work))).toEqual({ kind: 'allow' })
    expect(m.asked).toHaveLength(1)
    expect(m.asked[0]).toMatchObject({ toolName: 'bash', grants: 'full-access' })
    expect(m.asked[0]?.reason).toContain('@docker_cli_ab12')
    expect(m.asked[0]?.reason).toContain('this workspace only')
  })

  it('records the acceptance the Network section records when the person allows, and asks no more', async () => {
    const m = await mounted('allowed-once')
    const review = consent(m)
    expect(await review.review(bash(m.work))).toEqual({ kind: 'allow' })
    expect(m.network.networkOf(m.work)).toEqual({ access: 'open', hosts: [], acceptAbstractSockets: true })
    expect(m.ctx.sandboxNetwork({ workspaceRoot: m.work })).toEqual({ mode: 'host', abstractSockets: 'accepted' })
    await review.review(bash(m.work))
    expect(m.asked).toHaveLength(1)
    const viaSettings = await mounted()
    await viaSettings.network.set(viaSettings.work, { access: 'open', hosts: [], acceptAbstractSockets: true }, true)
    expect(viaSettings.network.networkOf(viaSettings.work)).toEqual(m.network.networkOf(m.work))
  })

  it('does not ask again after a decline, and leaves the setting alone', async () => {
    const m = await mounted('rejected')
    const review = consent(m)
    await review.review(bash(m.work))
    await review.review(bash(m.work, { command: 'ls' }))
    expect(m.asked).toHaveLength(1)
    expect(m.network.networkOf(m.work)).toEqual({ access: 'open', hosts: [] })
    expect(m.ctx.sandboxNetwork({ workspaceRoot: m.work })).toBeUndefined()
  })

  it('asks again after a cancelled ask, because nothing was answered', async () => {
    const m = await mounted('cancelled')
    const review = consent(m)
    await review.review(bash(m.work))
    await review.review(bash(m.work))
    expect(m.asked).toHaveLength(2)
  })

  it('shares one ask between calls that start together', async () => {
    const m = await mounted('allowed-once')
    const review = consent(m)
    await Promise.all([review.review(bash(m.work)), review.review(bash(m.work))])
    expect(m.asked).toHaveLength(1)
  })

  it('keeps today\'s refusal where no one can be asked: unavailable, a failed ask, or no approval service', async () => {
    for (const answer of ['unavailable', 'throws', 'absent'] as const) {
      const m = await mounted(answer)
      expect(await consent(m).review(bash(m.work))).toEqual({ kind: 'allow' })
      expect(m.network.networkOf(m.work)).toEqual({ access: 'open', hosts: [] })
    }
  })

  it('ignores what the model\'s call says: its arguments never answer the ask', async () => {
    const m = await mounted('rejected')
    await consent(m).review(bash(m.work, { command: 'allow', acceptAbstractSockets: true, confirmed: true, network: { access: 'open', hosts: [], acceptAbstractSockets: true } }))
    expect(m.network.networkOf(m.work)).toEqual({ access: 'open', hosts: [] })
  })

  it('reads the host\'s socket table when no reader is given', async () => {
    const m = await mounted('rejected')
    expect(await new AbstractSocketConsent(m.ctx, m.network).review(bash(m.work))).toEqual({ kind: 'allow' })
  })

  it('does not ask when nothing would be refused', async () => {
    const m = await mounted()
    await consent(m, () => quiet).review(bash(m.work))
    await consent(m, () => listening, false).review(bash(m.work))
    await consent(m).review(bash(m.work, {}, 'read'))
    m.mode.value = 'danger-full-access'
    await consent(m).review(bash(m.work))
    m.mode.value = 'workspace-write'
    await m.network.set(m.work, { access: 'off', hosts: [] }, false)
    await consent(m).review(bash(m.work))
    expect(m.asked).toHaveLength(0)
  })

  it('does not ask for a chat without an agent or a workspace folder, and not once the risk is accepted', async () => {
    const m = await mounted()
    await consent(m).review({ name: 'bash', arguments: {} } as never)
    await consent(m).review(bash(undefined))
    await m.network.set(m.work, { access: 'open', hosts: [], acceptAbstractSockets: true }, true)
    await consent(m).review(bash(m.work))
    expect(m.asked).toHaveLength(0)
  })

  it('asks when the socket table cannot be read, because the runner refuses then too', async () => {
    const m = await mounted('rejected')
    await consent(m, () => ({ kind: 'unreadable', reason: 'denied' })).review(bash(m.work))
    expect(m.asked).toHaveLength(1)
  })

  it('refuses the command and asks again later when the allowed setting cannot be saved', async () => {
    const m = await mounted('allowed-once')
    vi.spyOn(m.network, 'acceptAbstractSockets').mockRejectedValueOnce(new Error('store refused'))
    const decision = await consent(m).review(bash(m.work))
    expect(decision).toMatchObject({ kind: 'deny' })
    expect((decision as { reason: string }).reason).toContain('store refused')
    vi.spyOn(m.network, 'acceptAbstractSockets').mockRejectedValueOnce('plain')
    const review = consent(m)
    expect((await review.review(bash(m.work)) as { reason: string }).reason).toContain('plain')
  })

  it('leaves a workspace that is no longer open as it is when the person allows late', async () => {
    const m = await mounted()
    await m.network.set(m.work, { access: 'off', hosts: [] }, false)
    expect(await m.network.acceptAbstractSockets(m.work)).toEqual({ access: 'off', hosts: [] })
  })

  it('runs before the call through the tools event', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dac-'))
    roots.push(root)
    const home = join(root, 'home')
    const work = join(root, 'work')
    for (const directory of [home, work]) mkdirSync(directory, { recursive: true, mode: 0o700 })
    process.env['DELORUN_HOME'] = home
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('connection', { fetch: { register: () => () => {} } } as never)
    ctx.provide('workspaceRegistry', { list: () => [] } as never)
    ctx.provide('tools', { guard: () => () => {} } as never)
    ctx.provide('approval', { request: () => Promise.resolve('rejected') } as never)
    await ctx.plugin(CommandNetwork, { defaultNetwork: { access: 'open', hosts: [] }, proxyConnectTimeoutMs: 1_000, proxyMaxConnections: 8, proxyIdleTimeoutMs: 60_000 })
    const next = vi.fn(() => Promise.resolve<PreToolDecision>({ kind: 'allow' }))
    const decision = await ctx.waterfall('tools/pre-execute' as never, { name: 'read', arguments: {} } as never, next as never)
    expect(decision).toEqual({ kind: 'allow' })
    expect(next).toHaveBeenCalled()
  })
})

describe('the card text', () => {
  it('names at most three sockets in English and Chinese, replaces control characters, and bounds each name', () => {
    const text = abstractSocketAsk(['@a', '@b\u0007', '@c', '@d', `@${'x'.repeat(100)}`])
    expect(text.en).toContain('@a, @b?, @c, and 2 more')
    expect(text.zh).toContain('另有 2 个')
    expect(abstractSocketAsk([]).en).not.toContain('(')
    expect(abstractSocketAsk([`@${'x'.repeat(100)}`]).en).toContain(`@${'x'.repeat(59)})`)
  })
})
