/**
 * Native backend checks for the protected home and the denied sockets, shared by the per-runner e2e files. Each
 * check runs a confined Node command against fixtures and asserts its world effect, and the read and connect checks
 * also run the same command without the protection, so a pass shows the profile denied it rather than the fixture.
 */
import { execFile, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { promisify } from 'node:util'
import { expect } from 'vitest'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import type { Config, LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { mountAliases, readMountTable } from '../src/mounts.ts'

/** Creates a provider with the given config; the e2e file forces its own runner. */
export type ProviderFactory = (config: Config) => Promise<LocalSandboxProvider>
/** Creates a fixture directory under `base`; the e2e file owns cleanup. */
export type DirectoryFactory = (base: string) => Promise<string>

/** The readable entries C1 names: the runtime store, skills and the desktop app's runtimes. */
const READABLE = ['runtimes', 'skills', 'dsh-runtimes']

/** The real rootful Docker socket path on Linux and macOS. */
export const ROOTFUL_DOCKER_SOCKET = '/var/run/docker.sock'

/**
 * The confined command: one operation on one path, printing `ok` or the error code. `connect` prints `ok` once the
 * kernel accepts the connection, without waiting for the server.
 */
const PROBE = `
const fs = require('node:fs'), net = require('node:net')
const [op, path, second] = process.argv.slice(1)
const done = result => { console.log(result); process.exit(0) }
const code = error => error.code || 'error'
if (op === 'connect') {
  const socket = net.connect(path)
  socket.on('connect', () => done('ok'))
  socket.on('error', error => done(code(error)))
} else {
  try {
    if (op === 'read') fs.readFileSync(path)
    else if (op === 'list') fs.readdirSync(path)
    else if (op === 'create') fs.writeFileSync(path, 'planted', { flag: 'wx' })
    else if (op === 'change') fs.appendFileSync(path, 'changed')
    else if (op === 'delete') fs.unlinkSync(path)
    else if (op === 'link') { fs.linkSync(path, second); fs.readFileSync(second) }
    else if (op === 'clone') { fs.copyFileSync(path, second, fs.constants.COPYFILE_FICLONE_FORCE); fs.readFileSync(second) }
    else throw Object.assign(new Error(op), { code: 'BAD_OP' })
    done('ok')
  } catch (error) { done(code(error)) }
}
`

const execFileAsync = promisify(execFile)

/** The listening fixture sockets, closed by {@link closeServers}. */
const servers: Server[] = []

/**
 * Close every fixture socket server a check opened.
 * @returns completion after every server closed.
 */
export async function closeServers(): Promise<void> {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => { server.close(() => { resolve() }) })))
}

/**
 * Listen on a Unix socket at `path`.
 * @param path - the socket path.
 * @returns the path.
 */
async function listen(path: string): Promise<string> {
  const server = createServer((socket) => { socket.end() })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => { resolve() })
  })
  return path
}

/**
 * Run one probe operation confined by `provider` under `policy`, without blocking this process, whose event loop
 * serves the fixture sockets.
 * @param provider - the provider.
 * @param policy - the policy.
 * @param op - the operation.
 * @param path - its path.
 * @returns what the probe printed.
 */
async function probe(provider: LocalSandboxProvider, policy: SandboxPolicy, op: string, path: string, second = '', cwd?: string): Promise<string> {
  const confined = await provider.confine([process.execPath, '-e', PROBE, op, path, second], policy)
  const { stdout } = await execFileAsync(confined.argv[0] ?? '', confined.argv.slice(1), { encoding: 'utf8', timeout: 30_000, cwd })
  return stdout.trim()
}

/** A fixture home and its surroundings. */
export interface HomeFixture {
  /** The canonical home. */
  readonly home: string
  /** A home-auth key under `secrets/`. */
  readonly secret: string
  /** The start token under `run/`. */
  readonly token: string
  /** A file under the readable `runtimes/` entry. */
  readonly runtimeFile: string
  /** A runtime identity record under `trust/runtime-files/`, outside every readable entry. */
  readonly identityRecord: string
  /** A listening channel socket under `run/`, named short so the path fits macOS's 104-byte limit in a temp area. */
  readonly channelSocket: string
  /** A listening fixture ssh-agent socket outside the home. */
  readonly agentSocket: string
  /** A workspace directory beside the home. */
  readonly workspace: string
  /** The home-auth key reached through symbolic links to the home, to the home's parent and to its `secrets/`. */
  readonly aliases: readonly string[]
}

/**
 * Create a fixture home with C1's protected and readable entries inside a new directory under `base`.
 * @param directory - the fixture directory factory.
 * @param base - where the fixture directory is created; the OS home when omitted.
 * @returns the fixture.
 */
export async function homeFixture(directory: DirectoryFactory, base: string = homedir()): Promise<HomeFixture> {
  const root = realpathSync.native(await directory(base))
  const home = join(root, 'h')
  for (const path of ['secrets/home-auth', 'run', 'runtimes/0.1.0', 'skills', 'trust/runtime-files']) mkdirSync(join(home, path), { recursive: true, mode: 0o700 })
  const secret = join(home, 'secrets', 'home-auth', 'device.key')
  writeFileSync(secret, 'fixture-key\n', { mode: 0o600 })
  const token = join(home, 'run', 'start-token')
  writeFileSync(token, 'fixture-token\n', { mode: 0o600 })
  const runtimeFile = join(home, 'runtimes', '0.1.0', 'runtime.txt')
  writeFileSync(runtimeFile, 'runtime\n')
  const identityRecord = join(home, 'trust', 'runtime-files', 'delorun-0.1.0-linux-x64.json')
  writeFileSync(identityRecord, 'identity\n', { mode: 0o600 })
  const workspace = join(root, 'w')
  mkdirSync(workspace)
  const channelSocket = await listen(join(home, 'run', 'u.sock'))
  const agentSocket = await listen(join(root, 'a.sock'))
  symlinkSync(home, join(root, 'home-alias'), 'dir')
  symlinkSync(root, join(root, 'parent-alias'), 'dir')
  symlinkSync(join(home, 'secrets'), join(root, 'secrets-alias'), 'dir')
  const aliases = [
    join(root, 'home-alias', 'secrets', 'home-auth', 'device.key'),
    join(root, 'parent-alias', 'h', 'secrets', 'home-auth', 'device.key'),
    join(root, 'secrets-alias', 'home-auth', 'device.key'),
  ]
  return { home, secret, token, runtimeFile, identityRecord, channelSocket, agentSocket, workspace, aliases }
}

/**
 * The provider config that protects a fixture home.
 * @param fixture - the fixture.
 * @param deniedSockets - the denied sockets; the fixture's channel socket when omitted.
 * @returns the config.
 */
export function protectionConfig(fixture: HomeFixture, deniedSockets: readonly string[] = [fixture.channelSocket]): Config {
  return { protectedHome: fixture.home, protectedHomeReadable: READABLE, deniedSockets: [...deniedSockets] }
}

/**
 * A confined command in a read-only workspace at the OS home cannot read the home-auth key or the start token, nor
 * the key through a symbolic link to the home or to its parent, and reads a file under `runtimes/`; without the
 * protection the same command reads the key.
 * @param make - the provider factory.
 * @param directory - the fixture directory factory.
 * @returns completion.
 */
export async function checkHomeReadDenied(make: ProviderFactory, directory: DirectoryFactory): Promise<void> {
  const fixture = await homeFixture(directory)
  const atHome: SandboxPolicy = { mode: 'read-only', workspaceRoot: homedir() }
  const provider = await make(protectionConfig(fixture))
  expect(await probe(provider, atHome, 'read', fixture.secret)).not.toBe('ok')
  expect(await probe(provider, atHome, 'read', fixture.token)).not.toBe('ok')
  expect(await probe(provider, atHome, 'read', fixture.identityRecord)).not.toBe('ok')
  expect(await probe(provider, atHome, 'list', join(fixture.home, 'secrets'))).not.toBe('ok')
  for (const alias of fixture.aliases) expect(await probe(provider, atHome, 'read', alias)).not.toBe('ok')
  expect(await probe(provider, atHome, 'read', fixture.runtimeFile)).toBe('ok')
  expect(await probe(await make({}), atHome, 'read', fixture.secret)).toBe('ok')
}

/**
 * Confined commands cannot create, change or delete a file under the home, a runtime identity record under
 * `trust/runtime-files/` included, in a read-only workspace at the OS home and in a writable workspace beside the
 * home, and the home's files stay unchanged.
 * @param make - the provider factory.
 * @param directory - the fixture directory factory.
 * @param base - where the fixture is created; under the OS temporary directory the home lies inside a temp area
 *   that `workspace-write` grants.
 * @returns completion.
 */
export async function checkHomeWriteDenied(make: ProviderFactory, directory: DirectoryFactory, base: string = homedir()): Promise<void> {
  const fixture = await homeFixture(directory, base)
  const provider = await make(protectionConfig(fixture))
  const planted = join(fixture.home, 'planted')
  const policies: SandboxPolicy[] = [
    { mode: 'read-only', workspaceRoot: homedir() },
    { mode: 'workspace-write', workspaceRoot: fixture.workspace },
  ]
  for (const policy of policies) {
    expect(await probe(provider, policy, 'create', planted)).not.toBe('ok')
    expect(await probe(provider, policy, 'change', fixture.runtimeFile)).not.toBe('ok')
    expect(await probe(provider, policy, 'delete', fixture.secret)).not.toBe('ok')
    expect(await probe(provider, policy, 'change', fixture.identityRecord)).not.toBe('ok')
    expect(await probe(provider, policy, 'create', join(fixture.home, 'trust', 'runtime-files', 'planted.json'))).not.toBe('ok')
  }
  expect(existsSync(planted)).toBe(false)
  expect(existsSync(join(fixture.home, 'trust', 'runtime-files', 'planted.json'))).toBe(false)
  expect(readFileSync(fixture.runtimeFile, 'utf8')).toBe('runtime\n')
  expect(readFileSync(fixture.identityRecord, 'utf8')).toBe('identity\n')
  expect(readFileSync(fixture.secret, 'utf8')).toBe('fixture-key\n')
  // The writable workspace beside the home stays writable.
  expect(await probe(provider, policies[1]!, 'create', join(fixture.workspace, 'allowed'))).toBe('ok')
}

/**
 * `workspace-write` with the workspace at the OS home, at the home, inside it, or with an extra root containing it
 * is refused with `HOME_IN_WRITABLE_ROOT` before any command runs; read-only at the OS home is not refused.
 * @param make - the provider factory.
 * @param directory - the fixture directory factory.
 * @returns completion.
 */
export async function checkWritableRootRefused(make: ProviderFactory, directory: DirectoryFactory): Promise<void> {
  const fixture = await homeFixture(directory)
  const provider = await make(protectionConfig(fixture))
  const marker = join(fixture.workspace, 'ran')
  const argv = [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`]
  const refused: SandboxPolicy[] = [
    { mode: 'workspace-write', workspaceRoot: homedir() },
    { mode: 'workspace-write', workspaceRoot: fixture.home },
    { mode: 'workspace-write', workspaceRoot: join(fixture.home, 'skills') },
    { mode: 'workspace-write', workspaceRoot: fixture.workspace, additionalWritableRoots: [join(fixture.home, '..')] },
  ]
  for (const policy of refused) {
    await expect(provider.confine(argv, policy)).rejects.toMatchObject({ code: 'HOME_IN_WRITABLE_ROOT' })
  }
  expect(existsSync(marker)).toBe(false)
  await expect(provider.confine(argv, { mode: 'read-only', workspaceRoot: homedir() })).resolves.toMatchObject({ argv: expect.any(Array) })
}

/**
 * A confined command cannot connect to the channel socket under the home and connects to a fixture ssh-agent socket
 * outside it; without the protection it connects to the channel socket.
 * @param make - the provider factory.
 * @param directory - the fixture directory factory.
 * @returns completion.
 */
export async function checkHomeSocketDenied(make: ProviderFactory, directory: DirectoryFactory): Promise<void> {
  const fixture = await homeFixture(directory)
  const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: fixture.workspace }
  const provider = await make(protectionConfig(fixture))
  expect(await probe(provider, policy, 'connect', fixture.channelSocket)).not.toBe('ok')
  expect(await probe(provider, policy, 'connect', fixture.agentSocket)).toBe('ok')
  expect(await probe(await make({}), policy, 'connect', fixture.channelSocket)).toBe('ok')
}

/**
 * On a runner that cannot express the socket rule, a confined command still connects to the channel socket under the
 * home while it cannot read the start token, as {@link RUNNER_PROTECTION} reports.
 * @param make - the provider factory.
 * @param directory - the fixture directory factory.
 * @returns completion.
 */
export async function checkHomeSocketNotEnforced(make: ProviderFactory, directory: DirectoryFactory): Promise<void> {
  const fixture = await homeFixture(directory)
  const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: fixture.workspace }
  const provider = await make(protectionConfig(fixture))
  expect(await probe(provider, policy, 'connect', fixture.channelSocket)).toBe('ok')
  expect(await probe(provider, policy, 'read', fixture.token)).not.toBe('ok')
}

/**
 * Why the real rootful Docker socket cannot be used on this host, or `undefined` when an unconfined command connects
 * to it.
 * @returns the reason, or `undefined`.
 */
export function rootfulDockerUnusable(): string | undefined {
  if (!existsSync(ROOTFUL_DOCKER_SOCKET)) return `no Docker socket at ${ROOTFUL_DOCKER_SOCKET} on this host`
  const result = spawnSync(process.execPath, ['-e', PROBE, 'connect', ROOTFUL_DOCKER_SOCKET], { encoding: 'utf8', timeout: 10_000 })
  const outcome = result.stdout.trim()
  return outcome === 'ok' ? undefined : `an unconfined connect to ${ROOTFUL_DOCKER_SOCKET} fails on this host (${outcome || String(result.error)})`
}

/**
 * A confined command cannot connect to the Docker socket at its real rootful path, by its configured path or its
 * resolved one, and connects to the fixture ssh-agent socket; without the socket denied it connects to Docker.
 * @param make - the provider factory.
 * @param directory - the fixture directory factory.
 * @returns completion.
 */
export async function checkRootfulDockerDenied(make: ProviderFactory, directory: DirectoryFactory): Promise<void> {
  const fixture = await homeFixture(directory)
  const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: fixture.workspace }
  const real = realpathSync.native(ROOTFUL_DOCKER_SOCKET)
  const provider = await make(protectionConfig(fixture, [fixture.channelSocket, ROOTFUL_DOCKER_SOCKET]))
  expect(await probe(provider, policy, 'connect', ROOTFUL_DOCKER_SOCKET)).not.toBe('ok')
  expect(await probe(provider, policy, 'connect', real)).not.toBe('ok')
  expect(await probe(provider, policy, 'connect', fixture.agentSocket)).toBe('ok')
  expect(await probe(await make(protectionConfig(fixture)), policy, 'connect', ROOTFUL_DOCKER_SOCKET)).toBe('ok')
}

/**
 * The directory a rootless engine puts its socket in: `$XDG_RUNTIME_DIR` when it is a writable directory, as on a
 * Linux login session, else a fixture directory under the OS home.
 * @param directory - the fixture directory factory.
 * @returns the directory, and the prefix that keeps fixture socket names apart from real ones.
 */
async function runtimeDirectory(directory: DirectoryFactory): Promise<{ readonly dir: string; readonly prefix: string }> {
  const xdg = process.env['XDG_RUNTIME_DIR']
  const prefix = `dsh-e2e-${String(process.pid)}-${String(Date.now())}-`
  if (xdg !== undefined && xdg !== '' && existsSync(xdg) && statSync(xdg).isDirectory()) {
    const probePath = join(xdg, `${prefix}probe`)
    try {
      writeFileSync(probePath, '')
      rmSync(probePath)
      return { dir: realpathSync.native(xdg), prefix }
    } catch {
      // The runtime directory is not writable here; a fixture directory stands in for it.
    }
  }
  return { dir: realpathSync.native(await directory(homedir())), prefix }
}

/**
 * A confined command cannot connect to a rootless Docker socket in the runtime directory, while an ssh-agent socket
 * in the same directory stays reachable: the profile denies the socket's own path, never its directory.
 * @param make - the provider factory.
 * @param directory - the fixture directory factory.
 * @param cleanup - registers a path for the e2e file to remove.
 * @returns completion.
 */
export async function checkRootlessDockerDenied(
  make: ProviderFactory,
  directory: DirectoryFactory,
  cleanup: (path: string) => void,
): Promise<void> {
  const fixture = await homeFixture(directory)
  const { dir, prefix } = await runtimeDirectory(directory)
  const docker = join(dir, `${prefix}docker.sock`)
  const agent = join(dir, `${prefix}agent.sock`)
  cleanup(docker)
  cleanup(agent)
  await listen(docker)
  await listen(agent)
  const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: fixture.workspace }
  const provider = await make(protectionConfig(fixture, [fixture.channelSocket, docker]))
  expect(await probe(provider, policy, 'connect', docker)).not.toBe('ok')
  expect(await probe(provider, policy, 'connect', agent)).toBe('ok')
  expect(await probe(await make(protectionConfig(fixture)), policy, 'connect', docker)).toBe('ok')
}

/** The OS temporary directory, where a home lies inside a temp area that `workspace-write` grants. */
export const TEMP_BASE = tmpdir()

/**
 * A confined command in a writable workspace beside the home cannot hard-link or clone the home-auth key into the
 * workspace and read it there.
 * @param make - the provider factory.
 * @param directory - the fixture directory factory.
 * @returns completion.
 */
export async function checkHomeLinkDenied(make: ProviderFactory, directory: DirectoryFactory): Promise<void> {
  const fixture = await homeFixture(directory)
  const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: fixture.workspace }
  const provider = await make(protectionConfig(fixture))
  expect(await probe(provider, policy, 'link', fixture.secret, join(fixture.workspace, 'linked'))).not.toBe('ok')
  expect(await probe(provider, policy, 'clone', fixture.secret, join(fixture.workspace, 'cloned'))).not.toBe('ok')
  for (const copy of ['linked', 'cloned']) {
    const path = join(fixture.workspace, copy)
    if (existsSync(path)) expect(readFileSync(path, 'utf8')).not.toBe('fixture-key\n')
  }
}

/**
 * A readable entry that is a symbolic link to a directory above the home is dropped, so the home stays unreadable
 * through it.
 * @param make - the provider factory.
 * @param directory - the fixture directory factory.
 * @returns completion.
 */
export async function checkReadableAboveHomeDropped(make: ProviderFactory, directory: DirectoryFactory): Promise<void> {
  const fixture = await homeFixture(directory)
  const provider = await make(protectionConfig(fixture))
  // Created after the provider loaded, so only the wrap-time check can drop it.
  symlinkSync(dirname(fixture.home), join(fixture.home, 'dsh-runtimes'), 'dir')
  const through = join(fixture.home, 'dsh-runtimes', basename(fixture.home), relative(fixture.home, fixture.secret))
  expect(await probe(provider, { mode: 'read-only', workspaceRoot: homedir() }, 'read', through)).not.toBe('ok')
}

/**
 * The mount aliases of a fixture home on this host, such as the root filesystem's second mount at
 * `/mnt/wslg/distro` under WSLg, or why there are none.
 * @param home - the fixture home.
 * @returns the aliases, or the reason none exists.
 */
export function homeMountAliases(home: string): readonly string[] | string {
  const aliases = mountAliases(home, readMountTable()).map(alias => alias.path)
  return aliases.length > 0 ? aliases : `no other mount of the filesystem holding ${home} on this host`
}

/**
 * A confined command cannot read the home-auth key through another mount of the home's filesystem, and a writable
 * root inside that mount's view of the home is refused; without the protection the key is readable there.
 * @param make - the provider factory.
 * @param fixture - a fixture home with at least one mount alias.
 * @param aliases - the home's mount aliases.
 * @returns completion.
 */
export async function checkHomeMountAliasDenied(make: ProviderFactory, fixture: HomeFixture, aliases: readonly string[]): Promise<void> {
  const provider = await make(protectionConfig(fixture))
  const atHome: SandboxPolicy = { mode: 'read-only', workspaceRoot: homedir() }
  for (const alias of aliases) {
    const secret = join(alias, relative(fixture.home, fixture.secret))
    expect(await probe(provider, atHome, 'read', secret)).not.toBe('ok')
    await expect(provider.confine(['true'], { mode: 'workspace-write', workspaceRoot: join(alias, 'skills') })).rejects.toMatchObject({ code: 'HOME_IN_WRITABLE_ROOT' })
  }
  const open = await make({})
  expect(await probe(open, atHome, 'read', join(aliases[0]!, relative(fixture.home, fixture.secret)))).toBe('ok')
}

/**
 * The mount aliases of the real rootful Docker socket on this host, such as Docker Desktop's
 * `/mnt/wsl/docker-desktop-bind-mounts/<distro>/docker.sock` under WSL, or why there are none.
 * @returns the aliases, or the reason none exists.
 */
export function dockerSocketMountAliases(): readonly string[] | string {
  const unusable = rootfulDockerUnusable()
  if (unusable !== undefined) return unusable
  const aliases = mountAliases(realpathSync.native(ROOTFUL_DOCKER_SOCKET), readMountTable()).map(alias => alias.path)
  return aliases.length > 0 ? aliases : `no other mount reaches ${ROOTFUL_DOCKER_SOCKET} on this host`
}

/**
 * With only the Docker socket's configured path denied, a confined command cannot connect to it through any of its
 * mount aliases; without the denial it connects through each.
 * @param make - the provider factory.
 * @param directory - the fixture directory factory.
 * @param aliases - the socket's mount aliases.
 * @returns completion.
 */
export async function checkDockerMountAliasDenied(
  make: ProviderFactory,
  directory: DirectoryFactory,
  aliases: readonly string[],
): Promise<void> {
  const fixture = await homeFixture(directory)
  const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: fixture.workspace }
  const provider = await make(protectionConfig(fixture, [fixture.channelSocket, ROOTFUL_DOCKER_SOCKET]))
  for (const alias of aliases) expect(await probe(provider, policy, 'connect', alias)).not.toBe('ok')
  const open = await make(protectionConfig(fixture))
  for (const alias of aliases) expect(await probe(open, policy, 'connect', alias)).toBe('ok')
}

/**
 * A confined command cannot reach the denied channel socket by another spelling of its path: relative to its working
 * directory, with a doubled slash, with `/./`, or through a symbolic link in its workspace.
 * @param make - the provider factory.
 * @param directory - the fixture directory factory.
 * @returns completion.
 */
export async function checkSocketSpellingsDenied(make: ProviderFactory, directory: DirectoryFactory): Promise<void> {
  const fixture = await homeFixture(directory)
  const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: fixture.workspace }
  const provider = await make(protectionConfig(fixture))
  const link = join(fixture.workspace, 'socket-link')
  symlinkSync(fixture.channelSocket, link)
  const directoryOf = dirname(fixture.channelSocket)
  const name = basename(fixture.channelSocket)
  expect(await probe(provider, policy, 'connect', name, '', directoryOf)).not.toBe('ok')
  expect(await probe(provider, policy, 'connect', `${directoryOf}//${name}`)).not.toBe('ok')
  expect(await probe(provider, policy, 'connect', `${directoryOf}/./${name}`)).not.toBe('ok')
  expect(await probe(provider, policy, 'connect', link)).not.toBe('ok')
  expect(await probe(await make({}), policy, 'connect', link)).toBe('ok')
}

/**
 * On macOS, a confined command cannot read the home-auth key through the Data volume's firmlink spelling or through a
 * case variant of the home's path on a case-insensitive volume.
 * @param make - the provider factory.
 * @param directory - the fixture directory factory.
 * @returns completion.
 */
export async function checkMacPathVariantsDenied(make: ProviderFactory, directory: DirectoryFactory): Promise<void> {
  const fixture = await homeFixture(directory)
  const provider = await make(protectionConfig(fixture))
  const atHome: SandboxPolicy = { mode: 'read-only', workspaceRoot: homedir() }
  const variants = [join('/System/Volumes/Data', fixture.secret), fixture.secret.replace('/h/secrets/', '/H/SECRETS/')]
  for (const variant of variants) {
    expect(await probe(provider, atHome, 'read', variant)).not.toBe('ok')
  }
  const open = await make({})
  for (const variant of variants) expect(await probe(open, atHome, 'read', variant)).toBe('ok')
}

/** Docker Desktop's world-writable engine-control socket under WSL. */
export const WSL_DOCKER_DESKTOP_BACKEND = '/mnt/wsl/docker-desktop/shared-sockets/host-services/backend.sock'

/**
 * Why Docker Desktop's WSL backend socket cannot be used on this host, or `undefined` when an unconfined command
 * connects to it.
 * @returns the reason, or `undefined`.
 */
export function dockerDesktopBackendUnusable(): string | undefined {
  if (!existsSync(WSL_DOCKER_DESKTOP_BACKEND)) return `no Docker Desktop backend socket at ${WSL_DOCKER_DESKTOP_BACKEND} on this host`
  const result = spawnSync(process.execPath, ['-e', PROBE, 'connect', WSL_DOCKER_DESKTOP_BACKEND], { encoding: 'utf8', timeout: 10_000 })
  return result.stdout.trim() === 'ok' ? undefined : `an unconfined connect to ${WSL_DOCKER_DESKTOP_BACKEND} fails on this host`
}

/**
 * With Docker Desktop's control-socket directory denied, a confined command cannot connect to its backend socket;
 * without the denial it connects.
 * @param make - the provider factory.
 * @param directory - the fixture directory factory.
 * @returns completion.
 */
export async function checkDockerDesktopBackendDenied(make: ProviderFactory, directory: DirectoryFactory): Promise<void> {
  const fixture = await homeFixture(directory)
  const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: fixture.workspace }
  const denied = await make({ ...protectionConfig(fixture), deniedSocketDirectories: [dirname(WSL_DOCKER_DESKTOP_BACKEND)] })
  expect(await probe(denied, policy, 'connect', WSL_DOCKER_DESKTOP_BACKEND)).not.toBe('ok')
  expect(await probe(await make(protectionConfig(fixture)), policy, 'connect', WSL_DOCKER_DESKTOP_BACKEND)).toBe('ok')
}

/**
 * Every socket in a denied socket directory is unreachable, while an ssh-agent socket elsewhere stays reachable;
 * without the denial the directory's socket connects. With `later`, a socket created in the directory after the wrap
 * is unreachable too, as bwrap hides the whole directory.
 * @param make - the provider factory.
 * @param directory - the fixture directory factory.
 * @param later - whether to check a socket created after the wrap.
 * @returns completion.
 */
export async function checkSocketDirectoryDenied(make: ProviderFactory, directory: DirectoryFactory, later: boolean): Promise<void> {
  const fixture = await homeFixture(directory)
  const sockets = join(dirname(fixture.home), 'shared-sockets')
  mkdirSync(sockets)
  const backend = await listen(join(sockets, 'backend.sock'))
  const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: fixture.workspace }
  const provider = await make({ ...protectionConfig(fixture), deniedSocketDirectories: [sockets] })
  expect(await probe(provider, policy, 'connect', backend)).not.toBe('ok')
  expect(await probe(provider, policy, 'connect', fixture.agentSocket)).toBe('ok')
  if (later) {
    const confined = await provider.confine([process.execPath, '-e', PROBE, 'connect', join(sockets, 'later.sock'), ''], policy)
    await listen(join(sockets, 'later.sock'))
    const { stdout } = await execFileAsync(confined.argv[0] ?? '', confined.argv.slice(1), { encoding: 'utf8', timeout: 30_000 })
    expect(stdout.trim()).not.toBe('ok')
  }
  expect(await probe(await make(protectionConfig(fixture)), policy, 'connect', backend)).toBe('ok')
}
