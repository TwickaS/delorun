/**
 * The optional network seam of the sandbox policy: without a mounted `ctx.sandboxNetwork` resolver no resolved policy
 * carries a network, so every runner shares the host's; with one, each call's policy carries what the resolver answers
 * for that call's session and workspace root, and the model-visible policy text stays unchanged.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SandboxNetwork } from '@deepseek-ai/dsh-sandbox'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import SandboxPolicyService, { type SandboxNetworkRequest } from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'

async function mounted(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: '/fallback' })
  return ctx
}

function session(id: string, cwd: string): Session {
  const sessionId = SessionId(id)
  return Session.create(sessionId, undefined, { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 0, isSeeded: false, cwd })
}

describe('the sandbox network seam', () => {
  it('leaves every policy without a network while no resolver is mounted', async () => {
    const ctx = await mounted()
    expect(ctx.sandboxPolicy.resolve()).not.toHaveProperty('network')
    expect(ctx.sandboxPolicy.resolve({ session: session('a', '/ws') })).not.toHaveProperty('network')
  })

  it('asks a mounted resolver for each call, with the call\'s session and workspace root', async () => {
    const ctx = await mounted()
    const requests: SandboxNetworkRequest[] = []
    const answers: Record<string, SandboxNetwork | undefined> = {
      '/off': { mode: 'off' },
      '/proxy': { mode: 'proxy', socket: '/run/p.sock' },
      '/fallback': undefined,
    }
    ctx.provide('sandboxNetwork', (request: SandboxNetworkRequest) => {
      requests.push(request)
      return answers[request.workspaceRoot]
    })
    const off = session('off', '/off')
    expect(ctx.sandboxPolicy.resolve({ session: off }).network).toEqual({ mode: 'off' })
    expect(ctx.sandboxPolicy.resolve({ session: session('proxy', '/proxy'), mode: 'read-only' })).toMatchObject({ mode: 'read-only', network: { mode: 'proxy', socket: '/run/p.sock' } })
    expect(ctx.sandboxPolicy.resolve()).not.toHaveProperty('network')
    expect(requests[0]).toEqual({ session: off, workspaceRoot: '/off' })
    expect(requests.at(-1)).toEqual({ workspaceRoot: '/fallback' })
  })

  it('keeps the model-visible policy text unchanged by a network', async () => {
    const ctx = await mounted()
    const active = session('text', '/ws')
    const text = async (): Promise<string | undefined> => (await ctx.systemPrompt.assemble({ agent: { session: active } as Agent }))
      .contexts.find(context => context.name === 'sandbox:policy')?.text
    const before = await text()
    ctx.provide('sandboxNetwork', () => ({ mode: 'off' }))
    expect(await text()).toBe(before)
  })
})
