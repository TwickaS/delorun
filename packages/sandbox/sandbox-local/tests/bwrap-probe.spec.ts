/**
 * The real `bwrap` probe against fake `bwrap` executables on a temporary PATH: its four results, and that a timed-out
 * probe leaves no child behind. Linux only, where the Linux chain probes `bwrap`.
 */

import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'

const RO: SandboxPolicy = { mode: 'read-only', workspaceRoot: '/ws' }
const originalPath = process.env['PATH']
const dirs: string[] = []

afterEach(() => {
  process.env['PATH'] = originalPath
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Put a fake `bwrap` running `body` first on PATH; returns the directory. */
function fakeBwrap(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fake-bwrap-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'bwrap'), `#!/bin/sh\n${body}\n`)
  chmodSync(join(dir, 'bwrap'), 0o755)
  process.env['PATH'] = `${dir}:${originalPath ?? ''}`
  return dir
}

/** Confine once on the Linux chain with Landlock unusable, so the result is the bwrap probe's alone. */
async function refusal(probeTimeoutMs: number): Promise<SandboxUnavailableError> {
  const ctx = new Context()
  await ctx.plugin(LocalSandboxProvider, { probeAttempts: 1, probeTimeoutMs })
  const sandbox = ctx.sandbox as LocalSandboxProvider
  sandbox.internals = { platform: 'linux', probeLandlock: () => 'unusable', readUnixSockets: () => '', vsockOffered: () => false }
  const error = await sandbox.confine(['true'], RO).catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(SandboxUnavailableError)
  return error as SandboxUnavailableError
}

describe.skipIf(process.platform !== 'linux')('the real bwrap probe', () => {
  it('reports a probe that outlasts the timeout as transient and kills the child', async () => {
    fakeBwrap(`echo $$ > "${tmpdir()}/dsh-fake-bwrap-pid-$PPID"\nexec sleep 30`)
    const error = await refusal(200)
    expect(error.transient).toBe(true)
    expect(error.message).toContain('temporary fault')
    const files = readdirSync(tmpdir()).filter(name => name === `dsh-fake-bwrap-pid-${String(process.pid)}`)
    expect(files).toHaveLength(1)
    const pid = Number(readFileSync(join(tmpdir(), files[0] as string), 'utf8').trim())
    rmSync(join(tmpdir(), files[0] as string), { force: true })
    await new Promise<void>(resolve => setTimeout(resolve, 100))
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it('reports a non-zero exit as a permanent failure', async () => {
    fakeBwrap('exit 1')
    expect((await refusal(5_000)).transient).toBe(false)
  })

  it('reports a child killed by a signal as a resource limit', async () => {
    fakeBwrap('kill -9 $$')
    expect((await refusal(5_000)).transient).toBe(true)
  })

  it.each(['SIGSYS', 'SIGTERM'])('reports a child killed by %s as a permanent failure', async (signal) => {
    fakeBwrap(`kill -${signal.slice(3)} $$`)
    expect((await refusal(5_000)).transient).toBe(false)
  })

  it('reports a missing bwrap as a permanent failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-empty-path-'))
    dirs.push(dir)
    process.env['PATH'] = dir
    expect((await refusal(5_000)).transient).toBe(false)
  })
})
