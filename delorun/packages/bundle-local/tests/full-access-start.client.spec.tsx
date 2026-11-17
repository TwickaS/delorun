// @vitest-environment jsdom
/** The "Started without asking" line: which external starts get it, what it says, and what registers it. */
import { Context } from '@deepseek-ai/cordis'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ConversationContextReader, ConversationStartMatch } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { en, zh } from '../src/client/consents-locales.ts'
import { FullAccessStartNotice, type FullAccessStartNoticeProps } from '../src/client/FullAccessStartNotice.tsx'
import {
  APPROVAL_POLICY_KIND, approvalPolicyDefinition, FULL_ACCESS_START_KIND, fullAccessStartDefinition, SANDBOX_MODE_KIND, sandboxModeDefinition,
} from '../src/client/full-access-start.ts'
import { applyConsents } from '../src/client/index.ts'

afterEach(cleanup)

/** The parent's catalog entry for a child of `mode`, at log position 30. */
function catalog(mode: 'external' | 'continuable'): SessionEvent {
  return { type: 'subagent/catalog', seq: 30, time: 1_700_000_000_000, data: { version: 3, childId: 'child-1', childCreatedAt: 1, mode, label: 'Review', name: 'claude-code' } } as never
}

/** An `approval/policy` event. */
function policy(value: string): SessionEvent {
  return { type: 'approval/policy', seq: 4, time: 1, data: { policy: value } } as never
}

/** A `sandbox/mode` event. */
function mode(value: string): SessionEvent {
  return { type: 'sandbox/mode', seq: 3, time: 1, data: { mode: value } } as never
}

/** The reader a start sees, holding the nearest recorded policy and sandbox mode, or none. */
function readerOf(value: string | undefined, sandbox?: string): ConversationContextReader {
  return {
    previous: (kind: string) => {
      if (kind === APPROVAL_POLICY_KIND && value !== undefined) return { state: { policy: value } } as never
      if (kind === SANDBOX_MODE_KIND && sandbox !== undefined) return { state: { mode: sandbox } } as never
      return undefined
    },
  }
}

/** The line's node for an external start under a recorded policy and sandbox mode, or null. */
function nodeFor(value: string | undefined, sandbox: string | null = 'danger-full-access') {
  const match = { event: catalog('external'), location: { kind: 'unresolved' }, role: 'start' } as ConversationStartMatch
  const state = fullAccessStartDefinition.start({} as never, match, readerOf(value, sandbox ?? undefined))
  const base = { key: 'k', kind: fullAccessStartDefinition.kind, id: 'child-1', matches: [match], start: match }
  return fullAccessStartDefinition.buildViewNode?.({ ...base, state } as never)
}

describe('which starts get the line', () => {
  it('matches an external execution and no other child', () => {
    expect(fullAccessStartDefinition.match(catalog('external'))).toEqual({ id: 'child-1', role: 'start' })
    expect(fullAccessStartDefinition.match(catalog('continuable'))).toBeNull()
    expect(fullAccessStartDefinition.match(policy('never'))).toBeNull()
  })

  it('records each approval policy for the start to read', () => {
    expect(approvalPolicyDefinition.match(policy('never'))).toEqual({ id: '4', role: 'start' })
    expect(approvalPolicyDefinition.match(catalog('external'))).toBeNull()
    const match = { event: policy('never'), location: { kind: 'unresolved' }, role: 'start' } as ConversationStartMatch
    expect(approvalPolicyDefinition.start({} as never, match, readerOf(undefined))).toEqual({ policy: 'never' })
    expect(() => approvalPolicyDefinition.start({} as never, { ...match, event: catalog('external') } as never, readerOf(undefined))).toThrow('approval/policy')
  })

  it('records each sandbox mode for the start to read', () => {
    expect(sandboxModeDefinition.match(mode('danger-full-access'))).toEqual({ id: '3', role: 'start' })
    expect(sandboxModeDefinition.match(policy('never'))).toBeNull()
    const match = { event: mode('workspace-write'), location: { kind: 'unresolved' }, role: 'start' } as ConversationStartMatch
    expect(sandboxModeDefinition.start({} as never, match, readerOf(undefined))).toEqual({ mode: 'workspace-write' })
    expect(() => sandboxModeDefinition.start({} as never, { ...match, event: policy('never') } as never, readerOf(undefined))).toThrow('sandbox/mode')
  })

  it.each([['workspace-write'], ['read-only'], [null]])('shows nothing for a never policy on the sandbox mode %s', (sandbox) => {
    expect(nodeFor('never', sandbox)).toBeNull()
  })

  it('shows one node at the start when the recorded policy is never', () => {
    expect(nodeFor('never')).toMatchObject({ kind: FULL_ACCESS_START_KIND, target: 'chat', anchorSeq: 30, visibility: 'visible', groupTree: 'process', data: { time: 1_700_000_000_000 } })
  })

  it.each([['ask'], [undefined]])('shows nothing when the recorded policy is %s', (value) => {
    expect(nodeFor(value)).toBeNull()
  })

  it('keeps its state when a later event arrives', () => {
    const state = { seq: 30, time: 1, policy: 'never', mode: 'danger-full-access' }
    expect(fullAccessStartDefinition.update({ state } as never, {} as never)).toBe(state)
    expect(approvalPolicyDefinition.update({ state: { policy: 'never' } } as never, {} as never)).toEqual({ policy: 'never' })
    expect(sandboxModeDefinition.update({ state: { mode: 'read-only' } } as never, {} as never)).toEqual({ mode: 'read-only' })
  })
})

describe('the line', () => {
  it('says the agent started without asking in Full access, in both languages', () => {
    const t = ((key: keyof typeof en) => en[key]) as FullAccessStartNoticeProps['t']
    render(<FullAccessStartNotice {...{ node: { data: { time: 0 } }, t } as never as FullAccessStartNoticeProps} />)
    expect(screen.getByRole('status').textContent).toBe('Started without asking · Full access')
    expect(zh['agents.fullAccessStarted']).toBe('已启动，未经询问 · 完全访问')
  })
})

describe('registration', () => {
  it('registers both Definitions and the row with the conversation, and removes them on unload', async () => {
    const ctx = new Context()
    const definitions = new Set<unknown>()
    const rows = new Map<string, unknown>()
    ctx.provide('locale', { register: () => () => undefined, bind: () => (key: string) => key } as never)
    ctx.provide('uiConversation', { events: { register: (definition: unknown) => { definitions.add(definition); return () => { definitions.delete(definition) } } } } as never)
    ctx.provide('slots', {
      inject: (_: string, register: () => () => void) => register(),
      register: (slot: { name: string; key?: string }, component: unknown) => { rows.set(`${slot.name}#${slot.key ?? ''}`, component); return () => { rows.delete(`${slot.name}#${slot.key ?? ''}`) } },
    } as never)
    ctx.provide('configForms', { get: () => ({}) } as never)
    ctx.provide('sessions', {} as never)
    const fiber = ctx.plugin({ name: 'consents', inject: ['slots', 'locale', 'configForms', 'sessions'], apply: scope => { applyConsents(scope, (() => Promise.reject(new Error('unused'))) as never) } })
    await fiber
    expect([...definitions]).toEqual([approvalPolicyDefinition, sandboxModeDefinition, fullAccessStartDefinition])
    expect(rows.get(`conversation.chat.node#${FULL_ACCESS_START_KIND}`)).toBe(FullAccessStartNotice)
    await fiber.dispose()
    expect(definitions.size).toBe(0)
    expect(rows.has(`conversation.chat.node#${FULL_ACCESS_START_KIND}`)).toBe(false)
  })
})
