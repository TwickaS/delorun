/**
 * `user-manager-denied`, `system-bus-denied`, `terminal-server-denied`, `ssh-agent-denied`, `display-denied`,
 * `private-tmp` and `session-escape-landlock-refused`: a command confined by the sandbox Delo's start configures, on
 * bwrap, in `read-only` and in `workspace-write`, cannot reach the person's session services through their sockets,
 * which would run a program outside the sandbox or act with the person's authority: the user manager and session bus
 * (`systemd-run --user`, `busctl --user`), the system bus, a tmux server, an ssh-agent and the display server, by their
 * own paths and by every other mount that reaches them, such as WSLg's. Each case first shows that the same command
 * unconfined reaches the service, and skips by name with its reason where this machine has no such service or no
 * bwrap. Under Landlock, which cannot hide them, the provider refuses the wrap. The commands only list, ask an agent
 * for its key list or start `true`.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, type TestContext } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { escapeDirectories, sandboxProtection } from '../src/sandbox-protection.ts'

const UID = process.getuid?.()
const RUNTIME = `/run/user/${String(UID)}`
const MODES: readonly SandboxPolicy['mode'][] = ['read-only', 'workspace-write']

/** Why bwrap cannot run here. */
function missingBwrap(): string | undefined {
  const probe = spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--', 'true'], { timeout: 5_000, stdio: 'ignore' })
  return probe.status === 0 ? undefined : 'bwrap cannot create a sandbox on this machine'
}

/** Whether a program is on `PATH`. */
function installed(program: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${program}`], { timeout: 5_000, stdio: 'ignore' }).status === 0
}

const bwrapReason = UID === undefined ? 'the platform has no user ids' : missingBwrap()

/** Skip the running case by name with its reason when the machine cannot show the property. */
function requireService(test: TestContext, reason: string | undefined): void {
  const missing = bwrapReason ?? reason
  if (missing !== undefined) test.skip(missing)
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

/**
 * The provider as Delo's start configures it on this machine, with this launch environment.
 * @param env - the launch environment's extra variables, such as `SSH_AUTH_SOCK`.
 * @returns the provider.
 */
async function provider(env: Readonly<Record<string, string>> = {}): Promise<LocalSandboxProvider> {
  const home = directory(tmpdir(), 'dsh-runtime-home-')
  mkdirSync(join(home, 'run', 'default'), { recursive: true })
  const protection = await sandboxProtection(home, 'default', { DOCKER_HOST: 'tcp://127.0.0.1:2375', DOCKER_CONFIG: join(home, 'no-config'), ...env }, homedir(), UID)
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

/** The outcome of one shell command. */
interface Run {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

function run(argv: readonly string[], cwd: string): Run {
  const result = spawnSync(argv[0] as string, argv.slice(1), { encoding: 'utf8', timeout: 60_000, cwd })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** Run a shell command unconfined, in a workspace under the temporary directory. */
function unconfined(command: string): Run {
  return run(['sh', '-c', command], tmpdir())
}

/** The line a confined shell prints first, so a failure of bwrap itself is not taken for a denial. */
const STARTED = 'confined command started'

/**
 * Run a shell command confined under bwrap in each mode, each in its own workspace under the temporary directory, and
 * expect bwrap to have started it.
 */
async function confinedEach(sandbox: LocalSandboxProvider, command: string): Promise<Array<Run & { readonly mode: SandboxPolicy['mode'] }>> {
  const runs: Array<Run & { readonly mode: SandboxPolicy['mode'] }> = []
  for (const mode of MODES) {
    const workspace = directory(tmpdir(), 'dsh-runtime-workspace-')
    const wrapped = await sandbox.confine(['sh', '-c', `echo '${STARTED}'; ${command}`], { mode, workspaceRoot: workspace })
    expect(wrapped.argv.join(' ')).toContain('bwrap')
    const result = run(wrapped.argv, workspace)
    expect(result.stdout.startsWith(`${STARTED}\n`), `${mode}: bwrap did not start the command: ${result.stderr}`).toBe(true)
    runs.push({ mode, ...result, stdout: result.stdout.slice(STARTED.length + 1) })
  }
  return runs
}

/** Expect a command that succeeds unconfined to fail confined in each mode. */
async function deniedEach(sandbox: LocalSandboxProvider, command: string): Promise<void> {
  const reached = unconfined(command)
  expect(reached.status, `unconfined: ${command}: ${reached.stderr}`).toBe(0)
  for (const confined of await confinedEach(sandbox, command)) {
    expect(confined.status, `${confined.mode}: ${command}: ${confined.stdout}`).not.toBe(0)
  }
}

/** A program that connects to the socket its argument names and exits 0 when it connects, 3 otherwise. */
const CONNECT = `${JSON.stringify(process.execPath)} -e 'require("net").connect(process.argv[1]).on("connect",()=>process.exit(0)).on("error",()=>process.exit(3))'`

/** The other paths that reach `path` through WSLg's mounts, which the mount table lists on WSL with WSLg. */
function wslgAliases(path: string): string[] {
  return [join('/mnt/wslg', path), join('/mnt/wslg/distro', path)].filter(alias => existsSync(alias))
}

describe('user-manager-denied: the person\'s user manager and session bus', { timeout: 120_000 }, () => {
  const bus = join(RUNTIME, 'bus')
  const reason = !existsSync(bus) ? `${bus} is absent` : !installed('systemd-run') || !installed('busctl') ? 'systemd-run or busctl is absent' : undefined
  const env = `XDG_RUNTIME_DIR=${RUNTIME} DBUS_SESSION_BUS_ADDRESS=unix:path=${bus}`

  it('cannot start a program as a user unit with systemd-run --user, nor list the session bus', async (test) => {
    requireService(test, reason)
    const sandbox = await provider()
    await deniedEach(sandbox, `${env} timeout 30 systemd-run --user --quiet --pipe --wait -- true`)
    await deniedEach(sandbox, `${env} timeout 30 busctl --user list --no-pager`)
  })

  it('sees the runtime directory empty, and cannot reach the session bus through another mount of it', async (test) => {
    requireService(test, reason)
    const sandbox = await provider()
    for (const confined of await confinedEach(sandbox, `ls -A ${RUNTIME}`)) expect(confined.stdout, confined.mode).toBe('')
    for (const alias of wslgAliases(bus)) {
      await deniedEach(sandbox, `DBUS_SESSION_BUS_ADDRESS=unix:path=${alias} timeout 30 busctl --user list --no-pager`)
    }
  })
})

describe('system-bus-denied: the system bus', { timeout: 120_000 }, () => {
  it('cannot list the system bus', async (test) => {
    requireService(test, !existsSync('/run/dbus/system_bus_socket') ? 'no system bus listens here' : installed('busctl') ? undefined : 'busctl is absent')
    await deniedEach(await provider(), 'timeout 30 busctl --system list --no-pager')
  })
})

describe('terminal-server-denied: a tmux server of the person', { timeout: 120_000 }, () => {
  it('cannot reach the server in its socket directory under /tmp, nor through another mount of /tmp', async (test) => {
    requireService(test, installed('tmux') ? undefined : 'tmux is absent')
    const socketDirectory = `/tmp/tmux-${String(UID)}`
    mkdirSync(socketDirectory, { recursive: true, mode: 0o700 })
    const socket = join(socketDirectory, `dsh-probe-${String(process.pid)}`)
    expect(unconfined(`tmux -S ${socket} new-session -d 'sleep 600'`).status).toBe(0)
    cleanups.push(() => { spawnSync('tmux', ['-S', socket, 'kill-server'], { timeout: 10_000, stdio: 'ignore' }) })
    const sandbox = await provider()
    await deniedEach(sandbox, `tmux -S ${socket} list-sessions`)
    for (const alias of wslgAliases(socket)) await deniedEach(sandbox, `tmux -S ${alias} list-sessions`)
  })
})

describe('ssh-agent-denied: an ssh-agent of the person', { timeout: 120_000 }, () => {
  const reason = installed('ssh-agent') && installed('ssh-add') ? undefined : 'ssh-agent or ssh-add is absent'

  /**
   * Start an agent listening on `socket` for the test's length.
   * @param socket - the socket path.
   */
  async function agent(socket: string): Promise<void> {
    const child: ChildProcess = spawn('ssh-agent', ['-D', '-a', socket], { stdio: 'ignore' })
    cleanups.push(() => { child.kill() })
    for (let attempt = 0; attempt < 100 && !existsSync(socket); attempt++) await new Promise(resolve => setTimeout(resolve, 50))
    expect(existsSync(socket)).toBe(true)
  }

  /** `ssh-add -l` exits 1 for an agent that holds no key and 2 when it cannot reach one. */
  async function deniedAgent(sandbox: LocalSandboxProvider, socket: string): Promise<void> {
    const command = `SSH_AUTH_SOCK=${socket} ssh-add -l`
    expect(unconfined(command).status).toBe(1)
    for (const confined of await confinedEach(sandbox, command)) expect(confined.status, `${confined.mode}: ${confined.stdout}`).toBe(2)
  }

  it('cannot use the agent SSH_AUTH_SOCK names at start, outside /tmp and the runtime directory', async (test) => {
    requireService(test, reason)
    const socket = join(directory('/var/tmp', 'dsh-agent-'), 'agent.sock')
    await agent(socket)
    await deniedAgent(await provider({ SSH_AUTH_SOCK: socket }), socket)
  })

  it('cannot use an agent under /tmp that the start does not know', async (test) => {
    requireService(test, reason)
    const socket = join(directory('/tmp', 'ssh-dsh-'), 'agent.sock')
    await agent(socket)
    await deniedAgent(await provider(), socket)
  })
})

describe('display-denied: the display server and WSLg', { timeout: 120_000 }, () => {
  it('cannot connect to an X server socket, by its path or through WSLg', async (test) => {
    const display = '/tmp/.X11-unix/X0'
    requireService(test, existsSync(display) ? undefined : `${display} is absent`)
    const sandbox = await provider()
    for (const path of [display, ...wslgAliases(display), ...existsSync('/mnt/wslg/.X11-unix/X0') ? ['/mnt/wslg/.X11-unix/X0'] : []]) {
      await deniedEach(sandbox, `${CONNECT} ${path}`)
    }
  })

  it('sees WSLg\'s directory empty', async (test) => {
    requireService(test, existsSync('/mnt/wslg') ? undefined : 'not WSL with WSLg: /mnt/wslg is absent')
    for (const confined of await confinedEach(await provider(), 'ls -A /mnt/wslg')) expect(confined.stdout, confined.mode).toBe('')
  })
})

describe('private-tmp: the host\'s /tmp under bwrap', { timeout: 120_000 }, () => {
  it('shows a read-only command its workspace under /tmp and nothing else of /tmp, and lets it write nothing there', async (test) => {
    requireService(test, undefined)
    const sibling = directory('/tmp', 'dsh-runtime-sibling-')
    writeFileSync(join(sibling, 'note.txt'), 'outside')
    const workspace = directory('/tmp', 'dsh-runtime-workspace-')
    writeFileSync(join(workspace, 'note.txt'), 'inside')
    const command = `cat note.txt; echo; test -e ${sibling} || echo hidden; touch /tmp/x 2>/dev/null || echo read-only`
    const wrapped = await (await provider()).confine(['sh', '-c', command], { mode: 'read-only', workspaceRoot: workspace })
    const result = run(wrapped.argv, workspace)
    expect(result.stdout, result.stderr).toBe('inside\nhidden\nread-only\n')
    expect(unconfined(`test -e ${sibling} && echo visible`).stdout).toBe('visible\n')
  })
})

describe('session-escape-landlock-refused: the Landlock sandbox where an escape directory exists', () => {
  it('refuses to confine a command, naming the first escape directory that exists', async (test) => {
    const present = UID === undefined ? undefined : escapeDirectories(UID).find(path => existsSync(path))
    if (present === undefined) test.skip('no escape directory exists on this machine')
    const sandbox = await provider()
    // Landlock is the rung the Linux chain takes where bwrap cannot run.
    sandbox.internals = { platform: 'linux', probeBwrap: () => false, probeLandlock: () => 'full' }
    await expect(sandbox.confine(['true'], { mode: 'read-only', workspaceRoot: directory(tmpdir(), 'dsh-runtime-workspace-') }))
      .rejects.toMatchObject({ code: 'SANDBOX_UNSUPPORTED_POLICY', message: expect.stringContaining(JSON.stringify(present)) })
  })
})
