/**
 * The default spill root against a real kernel: the file the store writes by default sits inside the
 * Harness home, so the same protected-home rule that keeps a confined command out of the home keeps it
 * out of spilled tool output. A control file in the workspace proves the confinement itself works on
 * this host, so a host where the runner cannot start skips instead of passing vacuously.
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { privateRoot, saveTextFile } from '@deepseek-ai/dsh-spill-local'

/** Whether this host can run a confined command at all: bwrap present and user namespaces usable. */
const CONFINEMENT_USABLE = spawnSync(
  'bwrap',
  ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--', 'true'],
  { timeout: 5_000, stdio: 'ignore' },
).status === 0

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe.runIf(CONFINEMENT_USABLE)('the default spill root under the Harness home', () => {
  it('is unreadable to a confined command that reads the workspace beside it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-spill-confined-'))
    roots.push(root)
    const home = join(root, 'home')
    const workspace = join(root, 'workspace')
    mkdirSync(home, { mode: 0o700 })
    mkdirSync(workspace)
    writeFileSync(join(workspace, 'control.txt'), 'workspace control\n')
    const saved = await saveTextFile({
      root: privateRoot(home),
      sessionId: 'sess-1',
      suggestedName: 'result.txt',
      content: 'spilled tool output\n',
    })

    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LocalSandboxProvider, { protectedHome: home })
    const sandbox = ctx.sandbox as LocalSandboxProvider
    sandbox.internals = { probeBwrap: () => true, probeLandlock: () => 'unusable' }
    const confined = await sandbox.confine(
      ['cat', join(workspace, 'control.txt'), saved.path],
      { mode: 'read-only', workspaceRoot: workspace },
    )
    const program = confined.argv[0]
    expect(program).toBeDefined()
    const run = spawnSync(program!, confined.argv.slice(1), { encoding: 'utf8' })
    // The control read succeeded under the same profile, so the denial below is the home rule
    // and not a runner that never started.
    expect(run.stdout).toContain('workspace control')
    expect(run.stdout).not.toContain('spilled tool output')
  })
})
