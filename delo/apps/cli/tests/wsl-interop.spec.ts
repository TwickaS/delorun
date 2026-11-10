/**
 * `wsl-interop-denied` and `wsl-interop-landlock-refused`: under WSL with interop enabled, a command confined by the
 * sandbox Delo's start configures cannot start a Windows program by any way interop is reached, and a workspace on a
 * Windows drive stays readable and writable. The ways: the program by its `/mnt/c` path, by bare name through `PATH`,
 * as a copy in the workspace, through `/init` called directly, with `WSL_INTEROP` naming each interop socket, a direct
 * connect to each socket, and the kernel's `WSLInterop` binfmt registration read, changed or mounted again. Under
 * Landlock, which cannot hide the sockets, the provider refuses the wrap. The harmless program is `whoami.exe`, which
 * prints the Windows account and exits. Each case skips by name with its reason on a machine without WSL interop or
 * without bwrap.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, type TestContext } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { sandboxProtection, WSL_INTEROP_DIRECTORIES } from '../src/sandbox-protection.ts'

const WHOAMI = '/mnt/c/Windows/System32/whoami.exe'
const [INTEROP] = WSL_INTEROP_DIRECTORIES

/** Why this machine cannot run the WSL cases, read from the kernel and the filesystem, not the environment. */
function missingInterop(): string | undefined {
  let handler: string
  try {
    handler = readFileSync('/proc/sys/fs/binfmt_misc/WSLInterop', 'utf8')
  } catch (_absent) {
    // No WSLInterop handler is registered: this is not WSL, so there is no interop to deny.
    return 'not WSL: the kernel has no WSLInterop binfmt handler'
  }
  if (!handler.startsWith('enabled')) return 'WSL interop is disabled on this machine'
  if (!existsSync(INTEROP)) return `WSL interop has no ${INTEROP} directory on this machine`
  if (!existsSync(WHOAMI)) return `${WHOAMI} is absent`
  return undefined
}

/** Why bwrap cannot run here. */
function missingBwrap(): string | undefined {
  const probe = spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--', 'true'], { timeout: 5_000, stdio: 'ignore' })
  return probe.status === 0 ? undefined : 'bwrap cannot create a sandbox on this machine'
}

const interopReason = missingInterop()
const bwrapReason = missingBwrap()

/** Skip the running case by name with its reason when the machine cannot show the property. */
function requireWsl(test: TestContext, needsBwrap: boolean): void {
  const reason = interopReason ?? (needsBwrap ? bwrapReason : undefined)
  if (reason !== undefined) test.skip(reason)
}

const cleanups: Array<() => void> = []
let ctx: Context | undefined
afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function directory(base: string, prefix: string): string {
  const path = realpathSync(mkdtempSync(join(base, prefix)))
  cleanups.push(() => { rmSync(path, { recursive: true, force: true }) })
  return path
}

/** The provider as Delo's start configures it, from the real protection on this machine. */
async function provider(): Promise<LocalSandboxProvider> {
  const home = directory(tmpdir(), 'dsh-interop-home-')
  mkdirSync(join(home, 'run', 'default'), { recursive: true })
  const protection = await sandboxProtection(home, 'default', { DOCKER_HOST: 'tcp://127.0.0.1:2375', DOCKER_CONFIG: join(home, 'no-config') }, homedir())
  ctx = new Context()
  await ctx.plugin(LocalSandboxProvider, {
    protectedHome: protection.protectedHome,
    protectedHomeReadable: [...protection.protectedHomeReadable],
    deniedSockets: [...protection.deniedSockets],
    escapeSocketDirectories: [...protection.escapeSocketDirectories],
  })
  return ctx.sandbox as LocalSandboxProvider
}

/** Run a shell command confined under bwrap with this process's environment, `WSL_INTEROP` and `WSLENV` included. */
async function confined(sandbox: LocalSandboxProvider, command: string, workspace: string) {
  const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: workspace }
  const wrapped = await sandbox.confine(['sh', '-c', command], policy)
  expect(wrapped.argv[0]).toBe('bwrap')
  return spawnSync(wrapped.argv[0] as string, wrapped.argv.slice(1), { encoding: 'utf8', timeout: 30_000, cwd: workspace })
}

/** Expect a confined command to fail without the program's output. */
function refused(result: ReturnType<typeof spawnSync>, what: string): void {
  expect(result.status, what).not.toBe(0)
  expect(String(result.stdout), what).toBe('')
}

describe('wsl-interop-denied: a command the bwrap sandbox confines under WSL', { timeout: 120_000 }, () => {
  it('cannot start a Windows program by its /mnt/c path, by bare name or as a copy in its workspace', async (test) => {
    requireWsl(test, true)
    const sandbox = await provider()
    const workspace = directory(tmpdir(), 'dsh-interop-workspace-')
    for (const command of [WHOAMI, 'whoami.exe', `cp ${WHOAMI} ./copy.exe && ./copy.exe`]) {
      refused(await confined(sandbox, command, workspace), command)
    }
  })

  it('cannot start one through /init called directly', async (test) => {
    requireWsl(test, true)
    const sandbox = await provider()
    refused(await confined(sandbox, `/init ${WHOAMI}`, directory(tmpdir(), 'dsh-interop-workspace-')), '/init')
  })

  it('cannot start one with WSL_INTEROP naming any interop socket, nor connect to any of them', async (test) => {
    requireWsl(test, true)
    const sockets = readdirSync(INTEROP as string).map(name => join(INTEROP as string, name))
    expect(sockets.length).toBeGreaterThan(0)
    const sandbox = await provider()
    const workspace = directory(tmpdir(), 'dsh-interop-workspace-')
    expect((await confined(sandbox, `ls -A ${INTEROP}`, workspace)).stdout).toBe('')
    const connect = 'require("net").connect(process.argv[1]).on("connect",()=>process.exit(0)).on("error",()=>process.exit(3))'
    for (const socket of sockets) {
      refused(await confined(sandbox, `WSL_INTEROP=${socket} ${WHOAMI}`, workspace), `WSL_INTEROP=${socket}`)
      const result = await confined(sandbox, `${JSON.stringify(process.execPath)} -e '${connect}' ${socket}`, workspace)
      expect(result.status, socket).toBe(3)
    }
  })

  it('cannot read, change or mount again the kernel\'s WSLInterop registration', async (test) => {
    requireWsl(test, true)
    const sandbox = await provider()
    const workspace = directory(tmpdir(), 'dsh-interop-workspace-')
    for (const command of [
      'cat /proc/sys/fs/binfmt_misc/WSLInterop',
      'echo 0 > /proc/sys/fs/binfmt_misc/WSLInterop',
      'echo :planted:M::MZ::/bin/true: > /proc/sys/fs/binfmt_misc/register',
      `mount -t binfmt_misc none ${workspace}`,
    ]) {
      refused(await confined(sandbox, command, workspace), command)
    }
    // The host's registration is untouched.
    expect(readFileSync('/proc/sys/fs/binfmt_misc/WSLInterop', 'utf8')).toMatch(/^enabled/)
  })

  it('still reads and writes a workspace on a Windows drive', async (test) => {
    requireWsl(test, true)
    const answer = spawnSync('cmd.exe', ['/c', 'echo %TEMP%'], { encoding: 'utf8', timeout: 20_000, cwd: '/mnt/c' })
    const converted = spawnSync('wslpath', ['-u', answer.stdout.trim()], { encoding: 'utf8', timeout: 5_000 })
    expect(converted.status).toBe(0)
    const sandbox = await provider()
    const workspace = directory(converted.stdout.trim(), 'dsh-interop-drive-')
    const result = await confined(sandbox, `printf kept > ${workspace}/file && cat ${workspace}/file`, workspace)
    expect(result.status, String(result.stderr)).toBe(0)
    expect(result.stdout).toBe('kept')
  })
})

describe('wsl-interop-landlock-refused: the Landlock sandbox under WSL', () => {
  it('refuses to confine a command, because it cannot hide the interop sockets', async (test) => {
    requireWsl(test, false)
    const sandbox = await provider()
    // Landlock is the rung the Linux chain takes where bwrap cannot run.
    sandbox.internals = { platform: 'linux', probeBwrap: () => false, probeLandlock: () => 'full' }
    await expect(sandbox.confine(['true'], { mode: 'workspace-write', workspaceRoot: directory(tmpdir(), 'dsh-interop-workspace-') }))
      .rejects.toMatchObject({ code: 'SANDBOX_UNSUPPORTED_POLICY', message: expect.stringContaining(JSON.stringify(INTEROP)) })
  })
})
