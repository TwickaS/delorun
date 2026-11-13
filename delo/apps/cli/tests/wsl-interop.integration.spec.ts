/**
 * `wsl-interop-denied`, `wsl-vsock-denied` and `wsl-interop-landlock-refused`: under WSL with interop enabled, a
 * command confined by the sandbox Delo's start configures cannot start a Windows program by any way interop is
 * reached, and a workspace on a Windows drive stays readable and writable. The ways: the program by its `/mnt/c` path,
 * by bare name through `PATH`, as a copy in the workspace, through `/init` called directly, with `WSL_INTEROP` naming
 * each interop socket, a direct connect to each socket, and the kernel's `WSLInterop` binfmt registration, which no
 * writable `binfmt_misc` mount exposes. Under bwrap the command also cannot create a vsock socket, the transport WSL's
 * interop runs over, nor set up io_uring, whose requests create sockets the seccomp filter does not see. Under
 * Landlock, which cannot hide the sockets, the provider refuses the wrap. The harmless program is `whoami.exe`, which
 * prints the Windows account and exits; the vsock case only creates a socket and connects nothing. Each case skips by
 * name with its reason on a machine without WSL interop or without bwrap.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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

/**
 * A writable temporary directory on the C: drive, found without interop, which the check tooling's environment may
 * lack: the first user profile's `AppData/Local/Temp` this process can create a directory in.
 */
function windowsTemp(): string | undefined {
  let users: string[]
  try {
    users = readdirSync('/mnt/c/Users')
  } catch (_absent) {
    // No C: drive mounted: nothing to test the workspace on.
    return undefined
  }
  for (const user of users) {
    const temp = join('/mnt/c/Users', user, 'AppData', 'Local', 'Temp')
    try {
      rmSync(mkdtempSync(join(temp, 'dsh-interop-probe-')), { recursive: true })
      return temp
    } catch (_unwritable) {
      // Another user's profile, or a profile without a temporary directory: try the next.
    }
  }
  return undefined
}

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

/** The provider as Delorun's start configures it, from the real protection on this machine. */
async function provider(): Promise<LocalSandboxProvider> {
  const home = directory(tmpdir(), 'dsh-interop-home-')
  mkdirSync(join(home, 'run', 'default'), { recursive: true })
  const protection = await sandboxProtection(home, 'default', { DOCKER_HOST: 'tcp://127.0.0.1:2375', DOCKER_CONFIG: join(home, 'no-config') }, homedir(), process.getuid?.())
  ctx = new Context()
  await ctx.plugin(LocalSandboxProvider, {
    protectedHome: protection.protectedHome,
    protectedHomeReadable: [...protection.protectedHomeReadable],
    deniedSockets: [...protection.deniedSockets],
    escapeSocketDirectories: [...protection.escapeSocketDirectories],
    privateTmp: protection.privateTmp,
  })
  return ctx.sandbox as LocalSandboxProvider
}

/** Run a shell command confined under bwrap with this process's environment, `WSL_INTEROP` and `WSLENV` included. */
async function confined(sandbox: LocalSandboxProvider, command: string, workspace: string) {
  const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: workspace }
  const wrapped = await sandbox.confine(['sh', '-c', command], policy)
  // Under WSL the provider starts bwrap from a shell that hands it the escape filter.
  expect(wrapped.argv).toContain('bwrap')
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

  it('sees no writable binfmt_misc mount and no registration in it, so WSLInterop cannot be read or changed', async (test) => {
    requireWsl(test, true)
    const sandbox = await provider()
    const workspace = directory(tmpdir(), 'dsh-interop-workspace-')
    // Only reads and existence checks: nothing here writes a registration, whatever user runs the test.
    for (const command of [
      // Any binfmt_misc mount the command sees is read-only.
      'grep binfmt_misc /proc/self/mounts | grep -q -v " ro,"',
      'test -e /proc/sys/fs/binfmt_misc/register',
      'test -e /proc/sys/fs/binfmt_misc/WSLInterop',
      'cat /proc/sys/fs/binfmt_misc/WSLInterop',
    ]) {
      refused(await confined(sandbox, command, workspace), command)
    }
    // The host's registration is untouched.
    expect(readFileSync('/proc/sys/fs/binfmt_misc/WSLInterop', 'utf8')).toMatch(/^enabled/)
  })

  it('still reads and writes a workspace on a Windows drive', async (test) => {
    requireWsl(test, true)
    const base = windowsTemp()
    if (base === undefined) return test.skip('no writable temporary directory on the C: drive')
    const sandbox = await provider()
    const workspace = directory(base, 'dsh-interop-drive-')
    const result = await confined(sandbox, `printf kept > ${workspace}/file && cat ${workspace}/file`, workspace)
    expect(result.status, String(result.stderr)).toBe(0)
    expect(result.stdout).toBe('kept')
  })
})

/** Creates a vsock socket and prints the marker only once it exists; it connects nothing. */
const VSOCK = 'import socket; socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM); print("vsock-socket-created")'
/** Calls `io_uring_setup` (425) and prints the marker only for a descriptor; otherwise exits with the errno. */
const IO_URING = 'import ctypes; c = ctypes.CDLL(None, use_errno=True); b = ctypes.create_string_buffer(120); '
  + 'print("io-uring-created") if c.syscall(425, 4, b) >= 0 else exit(ctypes.get_errno())'
/** Creates an IPv4 and a Unix socket, which the filter leaves alone. */
const OTHER_SOCKETS = 'import socket; socket.socket(socket.AF_INET, socket.SOCK_STREAM); socket.socket(socket.AF_UNIX); print("ok")'

/**
 * Creates a vsock socket and sets up io_uring through the entries the native ones do not cover, on x86-64: the 32-bit
 * `int 0x80` entry (`socket`, `socketcall(SYS_SOCKET)` and `io_uring_setup`) through eleven bytes of machine code in
 * a page below 4 GiB, and the x32 `socket`. It prints, for each, `descriptor` or the errno name, and connects nothing.
 */
const COMPAT_ENTRIES = [
  'import ctypes, errno',
  'libc = ctypes.CDLL(None, use_errno=True)',
  'libc.mmap.restype = ctypes.c_void_p',
  'libc.mmap.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_long]',
  // Readable, writable and executable; private, anonymous and below 4 GiB, so 32-bit pointers reach it.
  'page = libc.mmap(None, 4096, 7, 0x62, -1, 0)',
  // push rbx; mov eax, edi; mov ebx, esi; xchg edx, ecx; int 0x80; pop rbx; ret
  "ctypes.memmove(page, bytes.fromhex('5389f889f387cacd805bc3'), 11)",
  // socketcall's arguments: AF_VSOCK, SOCK_STREAM, protocol 0.
  'ctypes.memmove(page + 64, (ctypes.c_uint32 * 3)(40, 1, 0), 12)',
  'int80 = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_uint, ctypes.c_uint, ctypes.c_uint, ctypes.c_uint)(page)',
  'libc.syscall.restype = ctypes.c_long',
  "def name(r): return 'descriptor' if r >= 0 else errno.errorcode[-r]",
  'x32 = libc.syscall(0x40000029, 40, 1, 0)',
  "print('int80-socket', name(int80(359, 40, 1, 0)))",
  "print('int80-socketcall', name(int80(102, 1, page + 64, 0)))",
  "print('int80-io_uring', name(int80(425, 4, page + 128, 0)))",
  "print('x32-socket', name(x32 if x32 >= 0 else -ctypes.get_errno()))",
].join('\n')

describe('wsl-vsock-denied: a command the bwrap sandbox confines under WSL', { timeout: 120_000 }, () => {
  it('cannot create a vsock socket, the transport interop runs over, nor set up io_uring', async (test) => {
    requireWsl(test, true)
    if (spawnSync('python3', ['--version'], { stdio: 'ignore', timeout: 30_000 }).status !== 0) return test.skip('python3 is absent on this machine')
    // The host itself offers vsock, so a refusal below is the filter's.
    expect(spawnSync('python3', ['-c', VSOCK], { encoding: 'utf8', timeout: 30_000 }).stdout).toBe('vsock-socket-created\n')
    const sandbox = await provider()
    const workspace = directory(tmpdir(), 'dsh-interop-workspace-')
    // The scripts hold double quotes and no `$`, backslash or backquote, so JSON quoting is shell quoting here.
    const python = (script: string) => confined(sandbox, `python3 -c ${JSON.stringify(script)}`, workspace)
    const vsock = await python(VSOCK)
    refused(vsock, 'AF_VSOCK')
    expect(String(vsock.stderr)).toContain('Address family not supported')
    const ioUring = await python(IO_URING)
    expect(ioUring.status, 'io_uring_setup').toBe(38)
    expect(ioUring.stdout).toBe('')
    expect((await python(OTHER_SOCKETS)).stdout).toBe('ok\n')
  })

  it('cannot create one or set up io_uring through the 32-bit int 0x80 entry, socketcall or the x32 numbers', async (test) => {
    requireWsl(test, true)
    if (process.arch !== 'x64') return test.skip(`the 32-bit and x32 entries are x86-64's; this machine is ${process.arch}`)
    if (spawnSync('python3', ['--version'], { stdio: 'ignore', timeout: 30_000 }).status !== 0) return test.skip('python3 is absent on this machine')
    const workspace = directory(tmpdir(), 'dsh-interop-workspace-')
    writeFileSync(join(workspace, 'compat.py'), COMPAT_ENTRIES)
    // Unconfined, each 32-bit entry creates what it asks for, so a refusal below is the filter's; the x32 numbers
    // answer ENOSYS where the kernel leaves them out.
    const host = spawnSync('python3', [join(workspace, 'compat.py')], { encoding: 'utf8', timeout: 30_000 })
    if (host.status !== 0) return test.skip(`the kernel has no 32-bit entry here: ${host.stderr || String(host.signal)}`)
    expect(host.stdout).toMatch(/^int80-socket descriptor\nint80-socketcall descriptor\nint80-io_uring descriptor\nx32-socket (descriptor|ENOSYS)\n$/)
    const confinedRun = await confined(await provider(), 'python3 compat.py', workspace)
    expect(confinedRun.stdout, String(confinedRun.stderr))
      .toBe('int80-socket EAFNOSUPPORT\nint80-socketcall EAFNOSUPPORT\nint80-io_uring ENOSYS\nx32-socket EAFNOSUPPORT\n')
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
