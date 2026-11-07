import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider, RUNNER_PROTECTION } from '@deepseek-ai/dsh-sandbox-local'
import type { Config } from '@deepseek-ai/dsh-sandbox-local'
import { seatbeltProfileArgs } from '../src/profiles.ts'
import { checkExtraWrites, checkRedirectedRoot } from './extra-roots.ts'
import {
  TEMP_BASE,
  checkHomeReadDenied,
  checkHomeSocketDenied,
  checkHomeWriteDenied,
  checkRootfulDockerDenied,
  checkRootlessDockerDenied,
  checkWritableRootRefused,
  closeServers,
  checkSocketDirectoryDenied,
  checkHomeLinkDenied,
  checkHomeMountAliasDenied,
  checkReadableAboveHomeDropped,
  homeFixture,
  homeMountAliases,
  checkDockerMountAliasDenied,
  checkSocketSpellingsDenied,
  dockerSocketMountAliases,
  checkMacPathVariantsDenied,
  rootfulDockerUnusable,
} from './protected-home.ts'

/**
 * Keyless backend integration through `confine()` and a real macOS Seatbelt process, with Linux
 * rungs forced off. Tests assert world effects and that the kernel denial matches the advertised
 * dialect; consumer coverage lives in dsh-bash-sandbox. Skips off macOS or when the profile probe
 * fails. HOME-based workspaces avoid Seatbelt's wholesale temp-directory grants, so
 * workspace-write proves the workspace-root grant itself.
 */

const probe = spawnSync('sandbox-exec', [...seatbeltProfileArgs({ mode: 'read-only', workspaceRoot: '/' }), '--', 'true'], { timeout: 5_000, stdio: 'ignore' })
const seatbeltUsable = probe.status === 0
const gitUsable = spawnSync('git', ['--version'], { timeout: 5_000, stdio: 'ignore' }).status === 0

/** Quote one path for the confined `bash -c` command line. */
function quote(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`
}

let ctx: Context | undefined
const tempDirs: string[] = []
const tempFiles: string[] = []

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  await closeServers()
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  for (const file of tempFiles.splice(0)) rmSync(file, { force: true })
})

async function tempDir(base: string): Promise<string> {
  const dir = await mkdtemp(join(base, 'dsh-seatbelt-e2e-'))
  tempDirs.push(dir)
  return dir
}

async function provider(config: Config = {}): Promise<LocalSandboxProvider> {
  await ctx?.fiber.dispose()
  ctx = new Context()
  await ctx.plugin(LocalSandboxProvider, config)
  const sandbox = ctx.sandbox as LocalSandboxProvider
  sandbox.internals = { probeBwrap: () => false, probeLandlock: () => 'unusable' }
  return sandbox
}

/** Confine a shell command under `policy` and run it for real; returns the spawn result and the wrap's facts. */
async function runConfined(sandbox: LocalSandboxProvider, command: string, policy: SandboxPolicy, env?: NodeJS.ProcessEnv) {
  const confined = await sandbox.confine(['bash', '-c', command], policy)
  const result = spawnSync(confined.argv[0] as string, confined.argv.slice(1), { timeout: 30_000, encoding: 'utf8', env })
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  return { result, confined }
}

describe.skipIf(!seatbeltUsable)('sandbox-local: real Seatbelt confinement through sandbox-exec', () => {
  it('grants explicit directories while denying unrelated and read-only writes', async () => {
    await checkExtraWrites(await provider(), tempDir)
  })
  it('rejects a directory grant redirected by a confined command', async () => {
    await checkRedirectedRoot(await provider(), tempDir)
  })
  it('read-only denies a write — the file must NOT exist, and the kernel speaks the advertised dialect', async () => {
    const workdir = await tempDir(tmpdir())
    const sandbox = await provider()
    const { result, confined } = await runConfined(sandbox, `echo hi > ${workdir}/denied.txt`, { mode: 'read-only', workspaceRoot: workdir })
    expect(result.status).not.toBe(0)
    expect(confined.enforcement).toBe('full')
    // The wrap's denialSignatures must be what the kernel actually prints.
    expect(result.stderr.toLowerCase()).toContain('operation not permitted')
    expect(existsSync(join(workdir, 'denied.txt'))).toBe(false)
  })

  it('read-only keeps the tree readable/executable and /dev/null writable', async () => {
    const workdir = await tempDir(tmpdir())
    const sandbox = await provider()
    const { result } = await runConfined(sandbox, 'ls / > /dev/null && echo dev-ok', { mode: 'read-only', workspaceRoot: workdir })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('dev-ok\n')
  })

  it('read-only grants no temp area: a write under the user temp dir is denied too', async () => {
    // The per-user darwin temp dir is a workspace-write grant, not a
    // read-only one — under read-only the only write-shaped path is /dev/null.
    const workdir = await tempDir(tmpdir())
    const sandbox = await provider()
    const target = join(workdir, 'tmp-denied.txt')
    const { result } = await runConfined(sandbox, `echo hi > ${target}`, { mode: 'read-only', workspaceRoot: await tempDir(homedir()) })
    expect(result.status).not.toBe(0)
    expect(existsSync(target)).toBe(false)
  })

  it('workspace-write lands a write inside the workspace root and still denies one beside it', async () => {
    const workdir = await tempDir(homedir())
    const outside = await tempDir(homedir())
    const sandbox = await provider()

    const inside = await runConfined(sandbox, `printf seatbelt-ok > ${workdir}/allowed.txt`, { mode: 'workspace-write', workspaceRoot: workdir })
    expect(inside.result.status).toBe(0)
    expect(readFileSync(join(workdir, 'allowed.txt'), 'utf8')).toBe('seatbelt-ok')

    const denied = await runConfined(sandbox, `echo hi > ${outside}/denied.txt`, { mode: 'workspace-write', workspaceRoot: workdir })
    expect(denied.result.status).not.toBe(0)
    expect(existsSync(join(outside, 'denied.txt'))).toBe(false)
  })

  it('workspace-write grants /tmp and the user temp dir (the documented Seatbelt-profile temp areas)', async () => {
    const workdir = await tempDir(homedir())
    const hostTmp = await tempDir('/tmp')
    const userTmp = await tempDir(tmpdir())
    const sandbox = await provider()
    const { result } = await runConfined(
      sandbox,
      `printf tmp-ok > ${quote(join(hostTmp, 'scratch.txt'))} && printf user-tmp-ok > ${quote(join(userTmp, 'scratch.txt'))}`,
      { mode: 'workspace-write', workspaceRoot: workdir },
    )
    expect(result.status).toBe(0)
    expect(readFileSync(join(hostTmp, 'scratch.txt'), 'utf8')).toBe('tmp-ok')
    expect(readFileSync(join(userTmp, 'scratch.txt'), 'utf8')).toBe('user-tmp-ok')
  })

  it.skipIf(!gitUsable).each(['inside', 'outside'])('allows a linked worktree %s the repository to stage and commit with an explicit Git grant', async (placement) => {
    // HOME-based roots keep both fixtures outside the Seatbelt temp grants, so
    // the extra grant is what makes the common git directory writable.
    const primary = await tempDir(homedir())
    const linked = placement === 'inside'
      ? join(primary, '.agents', 'worktrees', 'linked')
      : join(await tempDir(homedir()), 'linked')
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'DSH Test',
      GIT_AUTHOR_EMAIL: 'dsh-test@example.invalid',
      GIT_COMMITTER_NAME: 'DSH Test',
      GIT_COMMITTER_EMAIL: 'dsh-test@example.invalid',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    }
    execFileSync('git', ['init', '-q', '-b', 'main', primary], { env: gitEnv })
    writeFileSync(join(primary, 'tracked.txt'), 'one\n')
    writeFileSync(join(primary, 'source.txt'), 'source\n')
    execFileSync('git', ['-C', primary, 'add', 'tracked.txt'], { env: gitEnv })
    execFileSync('git', ['-C', primary, 'commit', '-qm', 'init'], { env: gitEnv })
    execFileSync('git', ['-C', primary, 'worktree', 'add', '-q', linked], { env: gitEnv })
    writeFileSync(join(linked, 'linked.txt'), 'linked\n')
    const sandbox = await provider()
    const addCommand = `cd ${quote(linked)} && git add linked.txt && git -c commit.gpgSign=false commit -qm linked`

    const baseline = await runConfined(sandbox, addCommand, { mode: 'workspace-write', workspaceRoot: linked }, gitEnv)
    expect(baseline.result.status).not.toBe(0)
    expect(baseline.result.stderr).toContain('index.lock')

    const gitDir = realpathSync.native(join(primary, '.git'))
    const allowed = await runConfined(sandbox, addCommand, {
      mode: 'workspace-write',
      workspaceRoot: linked,
      additionalWritableRoots: [gitDir],
    }, gitEnv)
    expect(allowed.result.status, allowed.result.stderr).toBe(0)
    expect(execFileSync('git', ['-C', linked, 'show', 'HEAD:linked.txt'], { env: gitEnv, encoding: 'utf8' })).toBe('linked\n')
    expect(existsSync(join(primary, 'source.txt'))).toBe(true)

    const denied = await runConfined(sandbox, `printf hijack > ${quote(join(primary, 'source.txt'))}`, {
      mode: 'workspace-write',
      workspaceRoot: linked,
      additionalWritableRoots: [gitDir],
    })
    expect(denied.result.status).not.toBe(0)
    expect(readFileSync(join(primary, 'source.txt'), 'utf8')).toBe('source\n')
    const readOnly = await runConfined(sandbox, `printf denied > ${quote(join(gitDir, 'denied.txt'))}`, {
      mode: 'read-only', workspaceRoot: linked, additionalWritableRoots: [gitDir],
    })
    expect(readOnly.result.status).not.toBe(0)
    expect(existsSync(join(gitDir, 'denied.txt'))).toBe(false)
  })
})

describe.skipIf(!seatbeltUsable)('sandbox-local: the protected home and denied sockets under real Seatbelt', () => {
  it('reports every protection rule as expressed', () => {
    expect(RUNNER_PROTECTION.seatbelt).toEqual({ homeWrite: true, homeRead: true, socketConnect: true })
  })
  it('home-read-denied: a confined command in a workspace at ~ cannot read the home-auth key or the start token, and reads runtimes/', async () => {
    await checkHomeReadDenied(provider, tempDir)
  })
  it('home-write-denied: a confined command cannot create, change or delete a file under the home', async () => {
    await checkHomeWriteDenied(provider, tempDir)
  })
  it('home-write-denied: a home inside the granted temp area stays unwritable under workspace-write', async () => {
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
  it('docker-socket-connect-denied: the Docker socket is unreachable through its other mounts', async (test) => {
    const aliases = dockerSocketMountAliases()
    if (typeof aliases === 'string') {
      test.skip(`not run: ${aliases}`)
      return
    }
    await checkDockerMountAliasDenied(provider, tempDir, aliases)
  })
  it('home-socket-connect-denied: other spellings of a denied socket\'s path are refused too', async () => {
    await checkSocketSpellingsDenied(provider, tempDir)
  })
  it('home-read-denied: the Data-volume firmlink spelling and a case variant of the home are refused', async () => {
    await checkMacPathVariantsDenied(provider, tempDir)
  })
  it('docker-socket-connect-denied: every socket present in a denied socket directory is unreachable', async () => {
    await checkSocketDirectoryDenied(provider, tempDir, false)
  })
  it('home-socket-connect-denied: a socket under the home is unreachable and a fixture ssh-agent socket is reachable', async () => {
    await checkHomeSocketDenied(provider, tempDir)
  })
  it('docker-socket-connect-denied: the Docker socket at its real rootful path is unreachable', async (test) => {
    const unusable = rootfulDockerUnusable()
    if (unusable !== undefined) {
      test.skip(`not run: ${unusable}`)
      return
    }
    await checkRootfulDockerDenied(provider, tempDir)
  })
  it('docker-socket-connect-denied: a rootless Docker socket is unreachable while the ssh-agent socket beside it stays reachable', async () => {
    await checkRootlessDockerDenied(provider, tempDir, (file) => { tempFiles.push(file) })
  })
})
