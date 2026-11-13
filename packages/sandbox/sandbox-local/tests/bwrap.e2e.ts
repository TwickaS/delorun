import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readlinkSync, rmSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider, RUNNER_PROTECTION } from '@deepseek-ai/dsh-sandbox-local'
import type { Config } from '@deepseek-ai/dsh-sandbox-local'
import { bwrapProfileArgs } from '../src/profiles.ts'
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
  checkDockerDesktopBackendDenied,
  checkSocketDirectoryDenied,
  checkPrivateTmpDenied,
  dockerDesktopBackendUnusable,
  checkHomeLinkDenied,
  checkHomeMountAliasDenied,
  checkReadableAboveHomeDropped,
  homeFixture,
  homeMountAliases,
  checkDockerMountAliasDenied,
  checkSocketSpellingsDenied,
  dockerSocketMountAliases,
  rootfulDockerUnusable,
} from './protected-home.ts'

/**
 * Keyless backend integration through `confine()` and a real bwrap process. With no rung forced,
 * a passing probe must select the first rung. Tests assert world effects, wrap shape, and that the
 * kernel denial matches the advertised dialect; consumer coverage lives in dsh-bash-sandbox.
 * Skips when bwrap or user namespaces are unavailable. HOME-based workspaces avoid bwrap's
 * ephemeral `/tmp`, so workspace-write actually proves the workspace-root rebind.
 */

const probe = spawnSync('bwrap', [...bwrapProfileArgs({ mode: 'read-only', workspaceRoot: '/' }), '--', 'true'], { timeout: 5_000, stdio: 'ignore' })
const bwrapUsable = probe.status === 0

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
  const dir = await mkdtemp(join(base, 'dsh-bwrap-e2e-'))
  tempDirs.push(dir)
  return dir
}

async function provider(config: Config = {}): Promise<LocalSandboxProvider> {
  await ctx?.fiber.dispose()
  ctx = new Context()
  await ctx.plugin(LocalSandboxProvider, config)
  return ctx.sandbox as LocalSandboxProvider
}

/** Confine a shell command under `policy` and run it for real; returns the spawn result and the wrap's facts. */
async function runConfined(sandbox: LocalSandboxProvider, command: string, policy: SandboxPolicy) {
  const confined = await sandbox.confine(['bash', '-c', command], policy)
  const result = spawnSync(confined.argv[0] as string, confined.argv.slice(1), { timeout: 30_000, encoding: 'utf8' })
  return { result, confined }
}

describe.skipIf(!bwrapUsable)('sandbox-local: real bwrap confinement', () => {
  it('grants explicit directories while denying unrelated and read-only writes', async () => {
    await checkExtraWrites(await provider(), tempDir)
  })
  it('rejects a directory grant redirected by a confined command', async () => {
    await checkRedirectedRoot(await provider(), tempDir)
  })
  it('the passing probe selects the bwrap rung naturally — first in the ladder, full enforcement, EROFS dialect', async () => {
    const workdir = await tempDir(tmpdir())
    const sandbox = await provider()
    const confined = await sandbox.confine(['true'], { mode: 'read-only', workspaceRoot: workdir })
    // Where the kernel offers vsock, bwrap is started from the shell that hands it the seccomp filter.
    expect(confined.argv).toContain('bwrap')
    expect(confined.enforcement).toBe('full')
    expect(confined.denialSignatures).toEqual(['read-only file system'])
  })

  it('read-only denies a write — the file must NOT exist, and the kernel speaks the advertised dialect', async () => {
    const workdir = await tempDir(tmpdir())
    const sandbox = await provider()
    const { result } = await runConfined(sandbox, `echo hi > ${workdir}/denied.txt`, { mode: 'read-only', workspaceRoot: workdir })
    expect(result.status).not.toBe(0)
    // The wrap's denialSignatures must be what the kernel actually prints.
    expect(result.stderr.toLowerCase()).toContain('read-only file system')
    expect(existsSync(join(workdir, 'denied.txt'))).toBe(false)
  })

  it('read-only keeps the tree readable/executable and the fresh /dev/null writable', async () => {
    const workdir = await tempDir(tmpdir())
    const sandbox = await provider()
    const { result } = await runConfined(sandbox, 'ls / > /dev/null && echo dev-ok', { mode: 'read-only', workspaceRoot: workdir })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('dev-ok\n')
  })

  it.each(['read-only', 'workspace-write'] as const)(
    '%s runs in a private PID namespace and blocks writes through procfs root magic links',
    async (mode) => {
      const workdir = await tempDir(homedir())
      const outside = await tempDir(homedir())
      const target = join(outside, 'escaped.txt')
      const sandbox = await provider()
      // Compare PID-namespace identity, not PID numbers: numeric /proc entries
      // recur inside a private namespace, and the /proc/1/root write below is
      // denied even in a shared namespace (host init is root-owned), so this
      // comparison is the assertion that fails when --unshare-pid is lost.
      const hostPidNamespace = readlinkSync('/proc/self/ns/pid')
      const visibility = await runConfined(sandbox, 'readlink /proc/self/ns/pid', { mode, workspaceRoot: workdir })
      expect(visibility.result.status).toBe(0)
      expect(visibility.result.stdout.trim()).not.toBe('')
      expect(visibility.result.stdout.trim()).not.toBe(hostPidNamespace)

      const escape = await runConfined(
        sandbox,
        `printf escaped > /proc/1/root${target}`,
        { mode, workspaceRoot: workdir },
      )
      expect(escape.result.status).not.toBe(0)
      expect(existsSync(target)).toBe(false)
    },
  )

  it('keeps descendants observable and controllable inside the private PID namespace', async () => {
    const workdir = await tempDir(homedir())
    const sandbox = await provider()
    const { result } = await runConfined(
      sandbox,
      'sleep 30 & child=$!; kill -0 "$child" && kill "$child"; wait "$child"; status=$?; test "$status" -ge 128',
      { mode: 'read-only', workspaceRoot: workdir },
    )
    expect(result.status).toBe(0)
  })

  it('workspace-write lands a write inside the workspace root and still denies one beside it', async () => {
    const workdir = await tempDir(homedir())
    const outside = await tempDir(homedir())
    const sandbox = await provider()

    const inside = await runConfined(sandbox, `printf bwrap-ok > ${workdir}/allowed.txt`, { mode: 'workspace-write', workspaceRoot: workdir })
    expect(inside.result.status).toBe(0)
    expect(readFileSync(join(workdir, 'allowed.txt'), 'utf8')).toBe('bwrap-ok')

    const denied = await runConfined(sandbox, `echo hi > ${outside}/denied.txt`, { mode: 'workspace-write', workspaceRoot: workdir })
    expect(denied.result.status).not.toBe(0)
    expect(existsSync(join(outside, 'denied.txt'))).toBe(false)
  })

  it('workspace-write mounts an EPHEMERAL /tmp: the write succeeds inside, the host /tmp stays untouched', async () => {
    // The documented bwrap-profile difference: Landlock and Seatbelt grant
    // the HOST temp areas, bwrap swaps in a fresh tmpfs that dies with the
    // process — the strongest of the three temp semantics.
    const workdir = await tempDir(homedir())
    const target = `/tmp/dsh-bwrap-e2e-ephemeral-${process.pid}.txt`
    tempFiles.push(target)
    const sandbox = await provider()
    const { result } = await runConfined(sandbox, `printf tmp-ok > ${target} && cat ${target}`, { mode: 'workspace-write', workspaceRoot: workdir })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('tmp-ok')
    expect(existsSync(target)).toBe(false)
  })
})

describe.skipIf(!bwrapUsable)('sandbox-local: the protected home and denied sockets under real bwrap', () => {
  it('reports every protection rule as expressed', () => {
    expect(RUNNER_PROTECTION.bwrap).toEqual({ homeWrite: true, homeRead: true, socketConnect: true })
  })
  it('home-read-denied: a confined command in a workspace at ~ cannot read the home-auth key or the start token, and reads runtimes/', async () => {
    await checkHomeReadDenied(provider, tempDir)
  })
  it('home-write-denied: a confined command cannot create, change or delete a file under the home', async () => {
    await checkHomeWriteDenied(provider, tempDir)
  })
  it('home-write-denied: a home inside the temp area stays unwritable under workspace-write', async () => {
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
  it('docker-socket-connect-denied: every socket in a denied socket directory is unreachable, including one created after the wrap', async () => {
    await checkSocketDirectoryDenied(provider, tempDir, true)
  })
  it('docker-socket-connect-denied: Docker Desktop\'s backend control socket is unreachable', async (test) => {
    const unusable = dockerDesktopBackendUnusable()
    if (unusable !== undefined) {
      test.skip(`not run: ${unusable}`)
      return
    }
    await checkDockerDesktopBackendDenied(provider, tempDir)
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

const pythonUsable = spawnSync('python3', ['-c', 'import socket; socket.AF_VSOCK'], { timeout: 5_000, stdio: 'ignore' }).status === 0

/**
 * Prints, for a vsock, an IPv4 and a Unix socket, `created` or the errno name, then what `io_uring_setup` (425 on
 * every architecture the filter names) returned, then one line of standard input. It creates sockets without
 * connecting them.
 */
const SOCKET_PROBE = `
import ctypes, errno, socket
for family, name in ((socket.AF_VSOCK, 'vsock'), (socket.AF_INET, 'inet'), (socket.AF_UNIX, 'unix')):
    try:
        socket.socket(family, socket.SOCK_STREAM).close()
        print(name, 'created')
    except OSError as error:
        print(name, errno.errorcode[error.errno])
libc = ctypes.CDLL(None, use_errno=True)
params = ctypes.create_string_buffer(120)
print('io_uring', 'descriptor' if libc.syscall(425, 4, params) >= 0 else errno.errorcode[ctypes.get_errno()])
print('stdin', input())
`

describe.skipIf(!bwrapUsable)('sandbox-local: privateTmp under real bwrap', () => {
  it('private-tmp-denied: a read-only command reaches no socket or file in the host\'s /tmp beside its workspace', async () => {
    await checkPrivateTmpDenied(provider, tempDir)
  })
})

describe.skipIf(!bwrapUsable)('sandbox-local: the escape filter under real bwrap', () => {
  // While an escape directory exists, the command keeps its other sockets, standard input and exit status.
  it('vsock-socket-denied: while an escape directory exists, a command creates no vsock socket and sets up no io_uring', async (test) => {
    if (!pythonUsable) return test.skip('python3 with AF_VSOCK is absent on this machine')
    const escape = await tempDir(homedir())
    const workdir = await tempDir(homedir())
    const sandbox = await provider({ escapeSocketDirectories: [escape] })
    const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: workdir }
    const confined = await sandbox.confine(['python3', '-c', SOCKET_PROBE], policy)
    const result = spawnSync(confined.argv[0] as string, confined.argv.slice(1), { timeout: 30_000, encoding: 'utf8', input: 'kept\n' })
    expect(result.stdout, result.stderr).toBe('vsock EAFNOSUPPORT\ninet created\nunix created\nio_uring ENOSYS\nstdin kept\n')
    expect((await runConfined(sandbox, 'exit 7', policy)).result.status).toBe(7)
  })

  it('vsock-socket-denied: a command under the filter still writes to the descriptors 3 and 4 its caller passes it', async () => {
    const escape = await tempDir(homedir())
    const workdir = await tempDir(homedir())
    const sandbox = await provider({ escapeSocketDirectories: [escape] })
    const confined = await sandbox.confine(['sh', '-c', 'echo three >&3; echo four >&4'], { mode: 'read-only', workspaceRoot: workdir })
    expect(confined.argv).toContain('--seccomp')
    const result = spawnSync(confined.argv[0] as string, confined.argv.slice(1), { timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'] })
    expect(result.status, String(result.stderr)).toBe(0)
    expect([String(result.output[3]), String(result.output[4])]).toEqual(['three\n', 'four\n'])
  })
})
