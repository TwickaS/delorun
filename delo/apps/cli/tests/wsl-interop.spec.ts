/**
 * `wsl-interop-denied`: under WSL with interop enabled, a command confined by the bwrap profile Delo's start gives the
 * CLI profile cannot start a Windows program, neither by its `/mnt/c/...` path, nor by bare name through `PATH`, nor
 * as a copy in its workspace; and a workspace on a Windows drive stays readable and writable. Runs only where the
 * kernel's `WSLInterop` handler is enabled and bwrap runs; the harmless program is `whoami.exe`.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { sandboxProtection } from '../src/sandbox-protection.ts'

const WHOAMI = '/mnt/c/Windows/System32/whoami.exe'

/** Whether the kernel hands Windows executables to WSL's interop handler on this machine. */
function interopEnabled(): boolean {
  try {
    return readFileSync('/proc/sys/fs/binfmt_misc/WSLInterop', 'utf8').startsWith('enabled') && existsSync(WHOAMI)
  } catch (_absent) {
    // No handler registered: not WSL, or interop is off, so there is nothing to deny.
    return false
  }
}

const bwrapUsable = process.platform === 'linux'
  && spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--', 'true'], { timeout: 5_000, stdio: 'ignore' }).status === 0

/** The Windows temporary directory as a WSL path, which the test process may ask Windows for; null when it cannot. */
function windowsTemp(): string | null {
  const answer = spawnSync('cmd.exe', ['/c', 'echo %TEMP%'], { encoding: 'utf8', timeout: 20_000, cwd: '/mnt/c' })
  const path = answer.status === 0 ? answer.stdout.trim() : ''
  if (path === '') return null
  const converted = spawnSync('wslpath', ['-u', path], { encoding: 'utf8', timeout: 5_000 })
  return converted.status === 0 ? converted.stdout.trim() : null
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
    deniedSocketDirectories: [...protection.deniedSocketDirectories],
  })
  return ctx.sandbox as LocalSandboxProvider
}

/** Run a shell command confined under `policy` with the test's own environment, `WSL_INTEROP` included. */
async function confined(sandbox: LocalSandboxProvider, command: string, policy: SandboxPolicy) {
  const wrapped = await sandbox.confine(['sh', '-c', command], policy)
  expect(wrapped.argv[0]).toBe('bwrap')
  return spawnSync(wrapped.argv[0] as string, wrapped.argv.slice(1), { encoding: 'utf8', timeout: 30_000 })
}

describe.skipIf(!interopEnabled() || !bwrapUsable)('wsl-interop-denied: a confined command under WSL', { timeout: 120_000 }, () => {
  it('cannot start a Windows program by its path, by bare name or as a copy in its workspace', async () => {
    const sandbox = await provider()
    const workspace = directory(tmpdir(), 'dsh-interop-workspace-')
    const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: workspace }
    for (const command of [WHOAMI, 'whoami.exe', `cp ${WHOAMI} ./copy.exe && ./copy.exe`]) {
      const result = await confined(sandbox, `cd ${workspace} && ${command}`, policy)
      expect(result.status, command).not.toBe(0)
      expect(result.stdout, command).toBe('')
    }
  })

  it('still reads and writes a workspace on a Windows drive', async () => {
    const temp = windowsTemp()
    expect(temp).not.toBeNull()
    const sandbox = await provider()
    const workspace = directory(temp as string, 'dsh-interop-drive-')
    const result = await confined(sandbox, `printf kept > ${workspace}/file && cat ${workspace}/file`, { mode: 'workspace-write', workspaceRoot: workspace })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('kept')
  })
})
