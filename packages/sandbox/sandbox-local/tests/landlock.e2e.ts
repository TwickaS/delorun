import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { launcherPath } from '@deepseek-ai/node-addon-system/landlock-run'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import type { Config } from '@deepseek-ai/dsh-sandbox-local'
import { RUNNER_PROTECTION } from '../src/profiles.ts'
import { checkExtraWrites, checkRedirectedRoot } from './extra-roots.ts'
import {
  TEMP_BASE,
  checkHomeReadDenied,
  checkHomeSocketNotEnforced,
  checkHomeWriteDenied,
  checkWritableRootRefused,
  closeServers,
  checkHomeLinkDenied,
  checkHomeMountAliasDenied,
  checkReadableAboveHomeDropped,
  homeFixture,
  homeMountAliases,
} from './protected-home.ts'

/**
 * Keyless backend integration through `confine()` and the workspace `landlock-run` launcher, with
 * bwrap forced off. Tests assert real world effects; consumer coverage lives in dsh-bash-sandbox.
 * Skips when the platform package or enforcing kernel is unavailable. HOME-based workspaces avoid
 * Landlock's wholesale `/tmp` grant, so workspace-write proves the workspace-root grant itself.
 */

const probe = spawnSync(launcherPath(), ['--probe'], { timeout: 5_000, encoding: 'utf8' })
const landlockUsable = probe.status === 0
/** The running kernel's enforcement level, from the launcher's probe report — every wrap below must carry exactly this. */
const enforcement = /partially enforced/.test(probe.stdout ?? '') ? 'partial' : 'full'

let ctx: Context | undefined
const tempDirs: string[] = []

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  await closeServers()
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function tempDir(base: string): Promise<string> {
  const dir = await mkdtemp(join(base, 'dsh-landlock-e2e-'))
  tempDirs.push(dir)
  return dir
}

async function provider(config: Config = {}): Promise<LocalSandboxProvider> {
  await ctx?.fiber.dispose()
  ctx = new Context()
  await ctx.plugin(LocalSandboxProvider, config)
  const sandbox = ctx.sandbox as LocalSandboxProvider
  sandbox.internals = { probeBwrap: () => false, readUnixSockets: () => '' }
  return sandbox
}

/** Confine a shell command under `policy` and run it for real; returns the spawn result and the wrap's enforcement. */
async function runConfined(sandbox: LocalSandboxProvider, command: string, policy: SandboxPolicy) {
  const confined = await sandbox.confine(['bash', '-c', command], policy)
  const result = spawnSync(confined.argv[0] as string, confined.argv.slice(1), { timeout: 30_000, encoding: 'utf8' })
  return { result, enforcement: confined.enforcement }
}

describe.skipIf(!landlockUsable)('sandbox-local: real Landlock confinement through the bundled launcher', () => {
  it('grants explicit directories while denying unrelated and read-only writes', async () => {
    await checkExtraWrites(await provider(), tempDir)
  })
  it('rejects a directory grant redirected by a confined command', async () => {
    await checkRedirectedRoot(await provider(), tempDir)
  })
  it('read-only denies a write — the file must NOT exist, the wrap reports the probed enforcement', async () => {
    const workdir = await tempDir(tmpdir())
    const sandbox = await provider()
    const { result, enforcement: wrapped } = await runConfined(sandbox, `echo hi > ${workdir}/denied.txt`, { mode: 'read-only', workspaceRoot: workdir })
    expect(result.status).not.toBe(0)
    expect(wrapped).toBe(enforcement)
    expect(existsSync(join(workdir, 'denied.txt'))).toBe(false)
  })

  it('read-only keeps the tree readable/executable and /dev/null writable', async () => {
    const workdir = await tempDir(tmpdir())
    const sandbox = await provider()
    const { result } = await runConfined(sandbox, 'ls / > /dev/null && echo dev-ok', { mode: 'read-only', workspaceRoot: workdir })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('dev-ok\n')
  })

  it('read-only denies a write beneath the host /dev (the /dev/shm tmpfs must stay untouched)', async () => {
    // The grant is /dev/null the FILE, not /dev the directory: /dev/shm is a
    // world-writable host tmpfs, and a write landing there would be exactly
    // the persistent host effect read-only promises never happen.
    const workdir = await tempDir(tmpdir())
    const sandbox = await provider()
    const target = `/dev/shm/dsh-landlock-e2e-${process.pid}`
    const { result } = await runConfined(sandbox, `echo hi > ${target}`, { mode: 'read-only', workspaceRoot: workdir })
    expect(result.status).not.toBe(0)
    expect(existsSync(target)).toBe(false)
  })

  it('workspace-write lands a write inside the workspace root and still denies one beside it', async () => {
    const workdir = await tempDir(homedir())
    const outside = await tempDir(homedir())
    const sandbox = await provider()

    const inside = await runConfined(sandbox, `printf landlock-ok > ${workdir}/allowed.txt`, { mode: 'workspace-write', workspaceRoot: workdir })
    expect(inside.result.status).toBe(0)
    expect(readFileSync(join(workdir, 'allowed.txt'), 'utf8')).toBe('landlock-ok')

    const denied = await runConfined(sandbox, `echo hi > ${outside}/denied.txt`, { mode: 'workspace-write', workspaceRoot: workdir })
    expect(denied.result.status).not.toBe(0)
    expect(existsSync(join(outside, 'denied.txt'))).toBe(false)
  })

  it('workspace-write grants the host /tmp (the documented Landlock-profile difference)', async () => {
    const workdir = await tempDir(homedir())
    const scratch = await tempDir(tmpdir())
    const sandbox = await provider()
    const { result } = await runConfined(sandbox, `printf tmp-ok > ${scratch}/scratch.txt`, { mode: 'workspace-write', workspaceRoot: workdir })
    expect(result.status).toBe(0)
    expect(readFileSync(join(scratch, 'scratch.txt'), 'utf8')).toBe('tmp-ok')
  })
})

describe.skipIf(!landlockUsable)('sandbox-local: the protected home under real Landlock', () => {
  it('reports the socket rule as not expressed', () => {
    expect(RUNNER_PROTECTION.landlock).toEqual({ homeWrite: true, homeRead: true, socketConnect: false })
  })
  it('home-read-denied: a confined command in a workspace at ~ cannot read the home-auth key or the start token, and reads runtimes/', async () => {
    await checkHomeReadDenied(provider, tempDir)
  })
  it('home-write-denied: a confined command cannot create, change or delete a file under the home', async () => {
    await checkHomeWriteDenied(provider, tempDir)
  })
  // The profile lists /tmp at each wrap, and the launcher refuses the run when another process removes one of its
  // entries before the launch (C1's Landlock limits); parallel suites churn /tmp, so this case retries more.
  it('home-write-denied: a home inside the granted temp area stays unwritable under workspace-write', { retry: 4 }, async () => {
    await checkHomeWriteDenied(provider, tempDir, TEMP_BASE)
  })
  it('writable-root-refused: a workspace-write root that equals, lies inside or contains the home is refused', async () => {
    await checkWritableRootRefused(provider, tempDir)
  })
  it('home-read-denied: a hard link or clone of a home file into the workspace is refused', async () => {
    await checkHomeLinkDenied(provider, tempDir)
  })
  it('home-read-denied: a readable entry that links above the home is dropped', async () => {
    await checkReadableAboveHomeDropped(provider, tempDir)
  })
  it('home-read-denied: the home stays unreadable through another mount of its filesystem', async (test) => {
    const fixture = await homeFixture(tempDir)
    const aliases = homeMountAliases(fixture.home)
    if (typeof aliases === 'string') {
      test.skip(`not run: ${aliases}`)
      return
    }
    await checkHomeMountAliasDenied(provider, fixture, aliases)
  })
  it('landlock-token-unreadable: a socket under the home stays reachable, as reported, while the start token is unreadable', async () => {
    await checkHomeSocketNotEnforced(provider, tempDir)
  })
})
