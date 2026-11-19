/**
 * The real `bwrap` probe when `spawn` itself fails: a synchronous throw and an asynchronous `error` event for host
 * resource limits both give a transient refusal. `node:child_process` is mocked, so this runs on every platform.
 */

import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: mocks.spawn,
}))

const RO: SandboxPolicy = { mode: 'read-only', workspaceRoot: '/ws' }

afterEach(() => { mocks.spawn.mockReset() })

/** Confine once on the Linux chain with Landlock unusable, so the refusal is the bwrap probe's alone. */
async function refusal(): Promise<SandboxUnavailableError> {
  const ctx = new Context()
  await ctx.plugin(LocalSandboxProvider, { probeAttempts: 1, probeTimeoutMs: 5_000 })
  const sandbox = ctx.sandbox as LocalSandboxProvider
  sandbox.internals = { platform: 'linux', probeLandlock: () => 'unusable', readUnixSockets: () => '', vsockOffered: () => false }
  const error = await sandbox.confine(['true'], RO).catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(SandboxUnavailableError)
  return error as SandboxUnavailableError
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}

describe('the bwrap probe when spawn fails', () => {
  it('reports a synchronous ENOMEM from spawn as a transient resource limit', async () => {
    mocks.spawn.mockImplementation(() => { throw errno('ENOMEM') })
    expect((await refusal()).transient).toBe(true)
  })

  it('reports an EMFILE error event as a transient resource limit', async () => {
    mocks.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { kill: vi.fn() })
      queueMicrotask(() => child.emit('error', errno('EMFILE')))
      return child
    })
    expect((await refusal()).transient).toBe(true)
  })

  it('reports another spawn error as a lasting failure', async () => {
    mocks.spawn.mockImplementation(() => { throw errno('EACCES') })
    expect((await refusal()).transient).toBe(false)
  })
})
