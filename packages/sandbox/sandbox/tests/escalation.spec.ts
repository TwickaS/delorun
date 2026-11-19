/**
 * Tests for the shared escalation vocabulary and choreography: the strictly-
 * wider ladder, the argument-pairing validation, the model-facing markers, and
 * {@link approveEscalation}'s ordered fail-closed sequence. Both enforcing tool
 * families (`dsh-tool-bash`, `dsh-tool-fs`) delegate here, so the ordering and
 * verbatim texts are pinned once, next to the vocabulary that owns them.
 */

import { describe, expect, it } from 'vitest'
import {
  denialMarkers,
  environmentDenialMarker,
  ESCALATION_TARGETS,
  SandboxEscalationError,
  WIDER_MODES,
  approveEscalation,
  escalationHintMarker,
  clearSandboxFault,
  noteSandboxFault,
  sandboxDenialMarker,
  sandboxPermissionsDescription,
  validateEscalationArgs,
} from '@deepseek-ai/dsh-sandbox'
import type { EscalationApprover, EscalationOutcome, SandboxEscalationErrorCode } from '@deepseek-ai/dsh-sandbox'

/** The structured identity a failed escalation records on `tool/result`. */
const escalationError = (code: SandboxEscalationErrorCode): unknown => expect.objectContaining({ name: 'SandboxEscalationError', code })

/** The synchronous failure `run` throws. */
function thrown(run: () => void): unknown {
  try {
    run()
  } catch (error: unknown) {
    return error
  }
  throw new Error('expected a throw')
}

describe('the strictly-wider ladder', () => {
  it('read-only escalates to either wider mode; workspace-write only to full access', () => {
    expect(WIDER_MODES['read-only']).toEqual(['workspace-write', 'danger-full-access'])
    expect(WIDER_MODES['workspace-write']).toEqual(['danger-full-access'])
    expect(WIDER_MODES['danger-full-access']).toBeUndefined()
  })

  it('the target enum is the closed set every session could escalate TO (read-only is the floor)', () => {
    expect(ESCALATION_TARGETS).toEqual(['workspace-write', 'danger-full-access'])
  })
})

describe('validateEscalationArgs', () => {
  it('accepts neither field, or both with a non-empty justification', () => {
    expect(() => { validateEscalationArgs(undefined, undefined) }).not.toThrow()
    expect(() => { validateEscalationArgs('workspace-write', 'because the workspace needs it') }).not.toThrow()
  })

  it('rejects one field without the other, and a blank justification', () => {
    expect(() => { validateEscalationArgs('workspace-write', undefined) }).toThrow(/requires a justification/)
    expect(() => { validateEscalationArgs(undefined, 'orphan reason') }).toThrow(/only valid together with sandbox_permissions/)
    expect(() => { validateEscalationArgs('workspace-write', '   ') }).toThrow(/non-empty sentence/)
    for (const [mode, justification] of [['workspace-write', undefined], [undefined, 'orphan reason'], ['workspace-write', '   ']] as const) {
      const error = thrown(() => { validateEscalationArgs(mode, justification) })
      expect(error).toBeInstanceOf(SandboxEscalationError)
      expect(error).toEqual(escalationError('SANDBOX_ESCALATION_INVALID_ARGUMENT'))
    }
  })
})

describe('the model-facing markers', () => {
  it('the denial marker names the mode', () => {
    expect(sandboxDenialMarker('read-only')).toBe('[sandbox: file access denied under read-only mode]')
    expect(sandboxDenialMarker('workspace-write')).toBe('[sandbox: file access denied under workspace-write mode]')
  })

  it('a denial no mode lifts has the environment\'s marker and never the escalation hint', () => {
    expect(environmentDenialMarker()).toBe('[sandbox: file access denied by the environment the sandbox runs in; no sandbox mode allows it]')
    expect(denialMarkers({ mode: 'workspace-write', denied: true, deniedBy: 'environment' }, ['danger-full-access'], 'command')).toEqual([environmentDenialMarker()])
    expect(denialMarkers({ mode: 'workspace-write', denied: true }, ['danger-full-access'], 'command')).toEqual([sandboxDenialMarker('workspace-write'), escalationHintMarker('command')])
    expect(denialMarkers({ mode: 'read-only', denied: true }, [], 'command')).toEqual([sandboxDenialMarker('read-only')])
    expect(denialMarkers({ mode: 'read-only', denied: false }, ['workspace-write'], 'command')).toEqual([])
  })

  it('the sandbox_permissions description names the family subject', () => {
    expect(sandboxPermissionsDescription('command')).toBe('The narrowest wider sandbox mode for a one-shot retry of the exact command the sandbox just denied; the retry asks the user for approval.')
    expect(sandboxPermissionsDescription('operation')).toBe('The narrowest wider sandbox mode for a one-shot retry of the exact operation the sandbox just denied; the retry asks the user for approval.')
  })

  it('the hint marker names the family subject', () => {
    expect(escalationHintMarker('command')).toContain('retry this exact command once with sandbox_permissions')
    expect(escalationHintMarker('operation')).toContain('retry this exact operation once with sandbox_permissions')
  })
})

describe('approveEscalation', () => {
  const req = (over: Partial<Parameters<typeof approveEscalation>[0]> = {}) => ({
    requestedMode: 'workspace-write',
    justification: 'the user asked to write in the workspace',
    effectiveMode: 'read-only' as const,
    subject: 'command',
    ...over,
  })
  /** An approver that records the request and returns a fixed outcome. */
  const approver = (outcome: EscalationOutcome, sink?: (req: unknown) => void): EscalationApprover => ({
    request: async (request) => { sink?.(request); return outcome },
  })
  const ingredients = (over: Partial<Parameters<typeof approveEscalation>[1]> = {}) => ({
    approver: approver('allowed-once'),
    agent: {},
    callId: 'call-1',
    toolName: 'bash',
    ...over,
  })

  it('grants: returns the requested mode, asking through the approver with the audit reason', async () => {
    const seen: { reason?: string }[] = []
    const granted = await approveEscalation(req(), ingredients({ approver: approver('allowed-once', r => seen.push(r as { reason?: string })) }))
    expect(granted).toBe('workspace-write')
    expect(seen[0]?.reason).toBe('escalate sandbox to workspace-write: the user asked to write in the workspace')
    expect(seen[0]).toMatchObject({
      displayReason: {
        en: 'Allow this operation with workspace-write permissions: the user asked to write in the workspace',
        zh: '允许本次操作使用 workspace-write 权限：the user asked to write in the workspace',
        ja: 'workspace-write 権限でこの操作を許可します：the user asked to write in the workspace',
      },
    })
  })

  it('after a temporary sandbox fault, a full-access ask says so once, offers no chat-scoped choice, and a rejection tells the model to retry in the sandbox', async () => {
    const agent = {}
    const seen: { displayReason?: { en: string; zh: string }; notice?: { en: string; zh: string }; escalatesTo?: string }[] = []
    const record = (r: unknown): void => { seen.push(r as never) }
    noteSandboxFault(agent)
    await expect(approveEscalation(req({ requestedMode: 'danger-full-access' }), ingredients({ agent, approver: approver('rejected', record) }))).rejects.toThrow(/without sandbox_permissions/)
    expect(seen[0]?.notice?.en).toBe("Delorun's sandbox had a problem; this asks to run without it.")
    expect(seen[0]?.notice?.zh).toContain('Delorun 的沙盒出了问题')
    expect(seen[0]?.displayReason?.en).toMatch(/^Allow this operation/)
    expect(seen[0]).not.toHaveProperty('escalatesTo')
    await approveEscalation(req({ requestedMode: 'danger-full-access' }), ingredients({ agent, approver: approver('allowed-once', record) }))
    expect(seen[1]?.displayReason?.en).toMatch(/^Allow this operation/)
    expect(seen[1]).not.toHaveProperty('notice')
    expect(seen[1]?.escalatesTo).toBe('danger-full-access')
  })

  it('a confined success clears the fault note, and a workspace-write ask never carries it', async () => {
    const agent = {}
    const seen: { displayReason?: { en: string } }[] = []
    const record = (r: unknown): void => { seen.push(r as never) }
    noteSandboxFault(agent)
    clearSandboxFault(agent)
    await approveEscalation(req({ requestedMode: 'danger-full-access' }), ingredients({ agent, approver: approver('allowed-once', record) }))
    noteSandboxFault(agent)
    await approveEscalation(req(), ingredients({ agent, approver: approver('allowed-once', record) }))
    expect(seen.map(entry => entry.displayReason?.en.startsWith('Allow'))).toEqual([true, true])
    expect(seen.some(entry => 'notice' in entry)).toBe(false)
  })

  it('marks only an escalation to full access as a full-access grant', async () => {
    const seen: { grants?: string }[] = []
    const sink = approver('allowed-once', r => seen.push(r as { grants?: string }))
    await approveEscalation(req({ requestedMode: 'danger-full-access' }), ingredients({ approver: sink }))
    await approveEscalation(req(), ingredients({ approver: sink }))
    expect(seen[0]?.grants).toBe('full-access')
    expect(seen[1]).not.toHaveProperty('grants')
  })

  it('names the requested mode on the request so a presenter can offer to switch the session to it', async () => {
    const seen: { escalatesTo?: string }[] = []
    const sink = approver('allowed-once', r => seen.push(r as { escalatesTo?: string }))
    await approveEscalation(req({ requestedMode: 'danger-full-access' }), ingredients({ approver: sink }))
    await approveEscalation(req(), ingredients({ approver: sink }))
    expect(seen.map(request => request.escalatesTo)).toEqual(['danger-full-access', 'workspace-write'])
  })

  it('names the requested mode only for a command or operation escalation, never for plugin management', async () => {
    const seen: { escalatesTo?: string }[] = []
    const sink = approver('allowed-once', r => seen.push(r as { escalatesTo?: string }))
    await approveEscalation(req({ subject: 'operation' }), ingredients({ approver: sink }))
    await approveEscalation(req({ subject: 'plugin_manager' }), ingredients({ approver: sink }))
    expect(seen[0]?.escalatesTo).toBe('workspace-write')
    expect(seen[1]).not.toHaveProperty('escalatesTo')
  })

  it.each(ESCALATION_TARGETS)('repeating %s succeeds without asking for approval', async (mode) => {
    const seen: unknown[] = []
    const request = req({ requestedMode: mode, effectiveMode: mode })
    await expect(approveEscalation(request, ingredients({ approver: approver('rejected', r => seen.push(r)) })))
      .resolves.toBe(mode)
    expect(seen).toEqual([])
    await expect(approveEscalation(request, ingredients({ approver: undefined, agent: undefined })))
      .resolves.toBe(mode)
  })

  it('a narrower or unsupported target fails closed without asking', async () => {
    const seen: unknown[] = []
    const spy = ingredients({ approver: approver('allowed-once', r => seen.push(r)) })
    await expect(approveEscalation(req({ requestedMode: 'read-only', effectiveMode: 'workspace-write' }), spy))
      .rejects.toThrow(/not strictly wider than this call's current "workspace-write" mode/)
    await expect(approveEscalation(req({ requestedMode: 'workspace-write', effectiveMode: 'danger-full-access' as never }), spy))
      .rejects.toThrow(/not strictly wider/)
    await expect(approveEscalation(req({ requestedMode: 'unknown-mode' }), spy))
      .rejects.toThrow(/not strictly wider/)
    await expect(approveEscalation(req({ requestedMode: 'unknown-mode' }), spy))
      .rejects.toEqual(escalationError('SANDBOX_ESCALATION_INVALID_ARGUMENT'))
    expect(seen).toEqual([])
  })

  it('a missing approval service and an agent-less call each fail closed with distinct text', async () => {
    await expect(approveEscalation(req(), ingredients({ approver: undefined }))).rejects.toThrow(/no approval service is composed/)
    await expect(approveEscalation(req(), ingredients({ agent: undefined }))).rejects.toThrow(/no agent to route it through/)
    await expect(approveEscalation(req(), ingredients({ approver: undefined }))).rejects.toEqual(escalationError('SANDBOX_ESCALATION_UNAVAILABLE'))
    await expect(approveEscalation(req(), ingredients({ agent: undefined }))).rejects.toEqual(escalationError('SANDBOX_ESCALATION_UNAVAILABLE'))
  })

  it('maps each non-grant outcome to its distinct verbatim text (subject in the rejection)', async () => {
    await expect(approveEscalation(req({ subject: 'operation' }), ingredients({ approver: approver('rejected') })))
      .rejects.toThrow('the user rejected escalating this operation to "workspace-write"; it stays denied, so stop and explain instead of working around it')
    await expect(approveEscalation(req(), ingredients({ approver: approver('cancelled') })))
      .rejects.toThrow('approval for escalating to "workspace-write" was cancelled')
    await expect(approveEscalation(req(), ingredients({ approver: approver('unavailable') })))
      .rejects.toThrow('no approval channel is available')
  })

  it('codes each non-grant outcome', async () => {
    await expect(approveEscalation(req(), ingredients({ approver: approver('rejected') })))
      .rejects.toEqual(escalationError('SANDBOX_ESCALATION_REJECTED'))
    await expect(approveEscalation(req(), ingredients({ approver: approver('cancelled') })))
      .rejects.toEqual(escalationError('SANDBOX_ESCALATION_CANCELLED'))
    await expect(approveEscalation(req(), ingredients({ approver: approver('unavailable') })))
      .rejects.toEqual(escalationError('SANDBOX_ESCALATION_UNAVAILABLE'))
  })

  it('a cancelled approval for an aborted call rethrows the call\'s cancellation', async () => {
    const controller = new AbortController()
    const reason = new DOMException('caller stopped', 'AbortError')
    controller.abort(reason)
    await expect(approveEscalation(req(), ingredients({ approver: approver('cancelled'), signal: controller.signal })))
      .rejects.toBe(reason)
  })

  it('an outcome outside the closed union trips the exhaustiveness guard (defensive)', async () => {
    await expect(approveEscalation(req(), ingredients({ approver: approver('bogus' as never) }))).rejects.toThrow()
  })
})
