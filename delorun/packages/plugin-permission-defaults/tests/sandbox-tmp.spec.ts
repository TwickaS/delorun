/**
 * Specs of the `delorun:sandbox-tmp` runtime context: the model learns that a sandboxed command's `/tmp` is discarded
 * while the session's mode confines commands, the text follows a mode switch, and it is absent under full access.
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import SandboxPolicyService, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { describe, expect, it } from 'vitest'
import { registerSandboxTmpContext, SANDBOX_TMP_CONTEXT, SANDBOX_TMP_TEXT } from '../src/sandbox-tmp.ts'

async function mounted(mode: 'read-only' | 'workspace-write' | 'danger-full-access'): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: '/fallback' })
  registerSandboxTmpContext(ctx)
  return ctx
}

function session(id: string): Session {
  const sessionId = SessionId(id)
  return Session.create(sessionId, undefined, { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 0, isSeeded: false, cwd: '/projects/current' })
}

async function contexts(ctx: Context, active: Session): Promise<string[]> {
  const assembled = await ctx.systemPrompt.assemble({ agent: { session: active } as Agent })
  return assembled.contexts.map(context => `${context.name}: ${context.text}`)
}

describe('delorun:sandbox-tmp', () => {
  it.each(['read-only', 'workspace-write'] as const)('states the sentence under %s, right after sandbox:policy', async (mode) => {
    const ctx = await mounted(mode)
    const names = (await contexts(ctx, session(`on-${mode}`))).map(line => line.split(':').slice(0, 2).join(':'))
    expect(names.indexOf(SANDBOX_TMP_CONTEXT)).toBe(names.indexOf('sandbox:policy') + 1)
    expect(await contexts(ctx, session(`text-${mode}`))).toContain(`${SANDBOX_TMP_CONTEXT}: ${SANDBOX_TMP_TEXT}`)
  })

  it('is absent under danger-full-access', async () => {
    const ctx = await mounted('danger-full-access')
    const lines = await contexts(ctx, session('off'))
    expect(lines.some(line => line.includes('/tmp'))).toBe(false)
  })

  it('follows a mode switch in either direction', async () => {
    const ctx = await mounted('workspace-write')
    const active = session('switch')
    expect(await contexts(ctx, active)).toContain(`${SANDBOX_TMP_CONTEXT}: ${SANDBOX_TMP_TEXT}`)
    setSandboxMode(active, 'danger-full-access')
    expect((await contexts(ctx, active)).some(line => line.includes(SANDBOX_TMP_TEXT))).toBe(false)
    setSandboxMode(active, 'read-only')
    expect(await contexts(ctx, active)).toContain(`${SANDBOX_TMP_CONTEXT}: ${SANDBOX_TMP_TEXT}`)
  })

  it('is empty for a request without a session', async () => {
    const ctx = await mounted('workspace-write')
    const assembled = await ctx.systemPrompt.assemble()
    expect(assembled.contexts.find(context => context.name === SANDBOX_TMP_CONTEXT)?.text).toBe('')
  })
})
