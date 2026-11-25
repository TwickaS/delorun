/**
 * The bench's one way to talk to Docker: every container, image and volume it makes carries the label `delorun.bench=1`,
 * and it removes only things that carry it. {@link hardenedRunArgs} builds the `docker run` arguments of a plugin
 * container, and {@link inspectProblems} reads a container's `docker inspect` output back and lists every way it differs
 * from the hardening (the plan's list: no capabilities, no new privileges, a non-root user, no bind mount but the output
 * folder, loopback-only published ports, memory and process limits, no secret in the environment). The denial tests
 * start a container with no plugin and assert that list is empty.
 *
 * @module @delorun/tools/compat-bench/docker
 */
import { execFile, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** The label every bench container, image and volume carries. */
export const BENCH_LABEL = 'delorun.bench=1'

/** The ports a bench container may publish, on `127.0.0.1` only. */
export const BENCH_PORT_RANGE = { first: 18700, last: 18749 } as const

/** The memory limit of a plugin container, in bytes (4 GiB), and its process limit. */
export const MEMORY_LIMIT_BYTES = 4 * 1024 ** 3
/** The most processes a plugin container may hold. */
export const PIDS_LIMIT = 1024

/** The environment names a bench image sets for itself, fixed at build time by `docker/Dockerfile`; a change there adds its name here. */
export const IMAGE_ENV: readonly string[] = ['DEBIAN_FRONTEND', 'CI', 'COREPACK_ENABLE_DOWNLOAD_PROMPT', 'DSH_BUILD_SOURCE_COMMIT', 'DSH_BUILD_SOURCE_TREE', 'DSH_CLIENT_COMMIT_HASH', 'DSH_CLIENT_TITLE', 'BENCH_HOST_KIND', 'BENCH_COMMIT', 'BENCH_DSH_VERSION']

/** The environment names a plugin container is started with; anything else is a secret or a leak to the denial test. */
export const ENV_ALLOWLIST: readonly string[] = ['PATH', 'HOME', 'LANG', 'NODE_VERSION', 'YARN_VERSION', 'PLAYWRIGHT_BROWSERS_PATH', 'DELORUN_HOME', 'DSH_HOME', 'BENCH_HOST', 'BENCH_RUN_ID', 'BENCH_OUT', 'NODE_ENV', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'COREPACK_HOME', 'PNPM_HOME', ...IMAGE_ENV]

/** Names that mean a secret whatever their value. */
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH/i

/** What a plugin container is made from. */
export interface RunSpec {
  /** The container's name. */
  readonly name: string
  /** The image tag. */
  readonly image: string
  /** The run's id, for the label. */
  readonly runId: string
  /** The host folder mounted at `/out`: the only bind mount. */
  readonly outDir: string
  /** The numeric user and group the container runs as (the caller's own, so the output folder is writable). */
  readonly user: string
  /** Environment names and values; only {@link ENV_ALLOWLIST} names are accepted. */
  readonly env?: Readonly<Record<string, string>>
  /** A host port in {@link BENCH_PORT_RANGE} to publish the container's studio port on `127.0.0.1`; none when absent. */
  readonly publish?: { readonly host: number, readonly container: number }
  /** Another container whose network namespace this one joins (the helper's), or the default bridge when absent. */
  readonly networkContainer?: string
  /** A named volume carried across versions by the update stage, mounted at `/home/bench/home`. */
  readonly homeVolume?: string
  /** Environment names an observer added for this run; they pass the allow-list check (their values are checked by the caller). */
  readonly observerEnv?: readonly string[]
  /** Another container whose process namespace this one joins, so the helper can see its executions. */
  readonly pidContainer?: string
  /** The command to run; the image's default when absent. */
  readonly command?: readonly string[]
}

/**
 * The `docker run` arguments of a hardened plugin container, started detached.
 * @param spec - what to run.
 * @returns the arguments after `docker`.
 * @throws Error when an environment name is not on the allow-list or looks like a secret, or the port is outside the bench range.
 */
export function hardenedRunArgs(spec: RunSpec): string[] {
  for (const name of Object.keys(spec.env ?? {})) {
    if ((spec.observerEnv ?? []).includes(name)) continue
    if (!ENV_ALLOWLIST.includes(name) || SECRET_NAME.test(name)) throw new Error(`the environment name ${name} is not one a plugin container is started with`)
  }
  if (spec.publish !== undefined && (spec.publish.host < BENCH_PORT_RANGE.first || spec.publish.host > BENCH_PORT_RANGE.last)) {
    throw new Error(`port ${String(spec.publish.host)} is outside ${String(BENCH_PORT_RANGE.first)}-${String(BENCH_PORT_RANGE.last)}`)
  }
  return [
    'run', '--detach', '--name', spec.name,
    '--label', BENCH_LABEL, '--label', `delorun.bench.run=${spec.runId}`,
    '--user', spec.user,
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--memory', String(MEMORY_LIMIT_BYTES), '--memory-swap', String(MEMORY_LIMIT_BYTES), '--pids-limit', String(PIDS_LIMIT), '--cpus', '2',
    '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=1g',
    '--volume', `${spec.outDir}:/out`,
    ...(spec.homeVolume === undefined ? [] : ['--volume', `${spec.homeVolume}:/home/bench/home`]),
    ...(spec.networkContainer === undefined ? [] : ['--network', `container:${spec.networkContainer}`]),
    ...(spec.pidContainer === undefined ? [] : ['--pid', `container:${spec.pidContainer}`]),
    ...(spec.publish === undefined || spec.networkContainer !== undefined ? [] : ['--publish', `127.0.0.1:${String(spec.publish.host)}:${String(spec.publish.container)}`]),
    ...Object.entries(spec.env ?? {}).flatMap(([name, value]) => ['--env', `${name}=${value}`]),
    spec.image,
    ...(spec.command ?? []),
  ]
}

/** The part of `docker inspect` output the checks read. */
export interface InspectedContainer {
  readonly Config: { readonly User?: string, readonly Env?: readonly string[], readonly Labels?: Readonly<Record<string, string>> }
  readonly HostConfig: {
    readonly CapDrop?: readonly string[] | null
    readonly CapAdd?: readonly string[] | null
    readonly SecurityOpt?: readonly string[] | null
    readonly Privileged?: boolean
    readonly NetworkMode?: string
    readonly PidMode?: string
    readonly IpcMode?: string
    readonly Memory?: number
    readonly PidsLimit?: number | null
    readonly PortBindings?: Readonly<Record<string, ReadonlyArray<{ readonly HostIp?: string, readonly HostPort?: string }> | null>> | null
    readonly Devices?: readonly unknown[] | null
  }
  readonly Mounts?: ReadonlyArray<{ readonly Type: string, readonly Source?: string, readonly Destination: string, readonly Name?: string }>
}

/**
 * List every way a container differs from the plugin-container hardening.
 * @param inspected - one element of `docker inspect` output.
 * @param expected - the output folder (the only bind mount), the volume names the run made and the environment names an observer was allowed to add.
 * @returns the problems, one line each; empty when the container is hardened.
 */
export function inspectProblems(inspected: InspectedContainer, expected: { readonly outDir: string, readonly volumes?: readonly string[], readonly allowedEnv?: readonly string[] }): string[] {
  const problems: string[] = []
  const host = inspected.HostConfig
  if (!(host.CapDrop ?? []).map(name => name.toUpperCase()).includes('ALL')) problems.push('capabilities are not all dropped')
  if ((host.CapAdd ?? []).length > 0) problems.push(`capabilities were added: ${(host.CapAdd ?? []).join(', ')}`)
  if (!(host.SecurityOpt ?? []).includes('no-new-privileges') && !(host.SecurityOpt ?? []).includes('no-new-privileges:true')) problems.push('no-new-privileges is not set')
  if (host.Privileged === true) problems.push('the container is privileged')
  const user = inspected.Config.User ?? ''
  if (user === '' || user === '0' || user === 'root' || user.startsWith('0:') || user.startsWith('root:')) problems.push(`the container runs as root (user "${user}")`)
  if (host.NetworkMode === 'host') problems.push('the container uses the host network')
  if (host.PidMode === 'host') problems.push('the container shares the host process namespace')
  if (host.IpcMode === 'host') problems.push('the container shares the host IPC namespace')
  if ((host.Devices ?? []).length > 0) problems.push('a host device is attached')
  for (const mount of inspected.Mounts ?? []) {
    if (mount.Type === 'bind') {
      if (mount.Source !== expected.outDir || mount.Destination !== '/out') problems.push(`bind mount ${mount.Source ?? '?'} -> ${mount.Destination} is not the output folder`)
    } else if (mount.Type === 'volume') {
      if (!(expected.volumes ?? []).includes(mount.Name ?? '')) problems.push(`volume ${mount.Name ?? '?'} is not one this run made`)
    } else {
      problems.push(`mount of type ${mount.Type} at ${mount.Destination}`)
    }
  }
  for (const [port, bindings] of Object.entries(host.PortBindings ?? {})) {
    for (const binding of bindings ?? []) {
      if (binding.HostIp !== '127.0.0.1') problems.push(`port ${port} is published on ${binding.HostIp === undefined || binding.HostIp === '' ? 'every address' : binding.HostIp}`)
      const hostPort = Number(binding.HostPort)
      if (hostPort < BENCH_PORT_RANGE.first || hostPort > BENCH_PORT_RANGE.last) problems.push(`port ${port} is published on host port ${binding.HostPort ?? '?'}, outside the bench range`)
    }
  }
  if ((host.Memory ?? 0) <= 0) problems.push('there is no memory limit')
  if ((host.PidsLimit ?? 0) <= 0) problems.push('there is no process limit')
  for (const entry of inspected.Config.Env ?? []) {
    const name = entry.slice(0, Math.max(0, entry.indexOf('=')))
    if ((expected.allowedEnv ?? []).includes(name)) continue
    if (SECRET_NAME.test(name)) problems.push(`the environment holds ${name}`)
    else if (!ENV_ALLOWLIST.includes(name)) problems.push(`the environment holds ${name}, which is not on the allow-list`)
  }
  if (inspected.Config.Labels?.['delorun.bench'] !== '1') problems.push('the container does not carry the bench label')
  return problems
}

/** What a finished docker command left behind. */
export interface DockerResult {
  /** Standard output. */
  readonly stdout: string
  /** Standard error. */
  readonly stderr: string
  /** The exit code. */
  readonly code: number
}

/**
 * Run `docker` to its end.
 * @param args - the arguments.
 * @param options - `input` is written to standard input; `timeoutMs` kills the command when exceeded.
 * @returns the result; a failing command resolves with its code rather than throwing.
 */
export async function docker(args: readonly string[], options: { readonly input?: string, readonly timeoutMs?: number } = {}): Promise<DockerResult> {
  if (options.input !== undefined) {
    return await new Promise((done) => {
      const child = spawn('docker', [...args], { stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => { child.kill('SIGKILL') }, options.timeoutMs)
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      child.on('close', (code) => { if (timer !== undefined) clearTimeout(timer); done({ stdout, stderr, code: code ?? 1 }) })
      child.stdin.end(options.input)
    })
  }
  try {
    const { stdout, stderr } = await execFileAsync('docker', [...args], { maxBuffer: 256 * 1024 * 1024, ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }) })
    return { stdout, stderr, code: 0 }
  } catch (error) {
    const failure = error as { stdout?: string, stderr?: string, code?: number | string }
    return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? String(error), code: typeof failure.code === 'number' ? failure.code : 1 }
  }
}

/**
 * Whether a Docker daemon answers.
 * @returns true when `docker version` succeeds.
 */
export async function dockerAvailable(): Promise<boolean> {
  return (await docker(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 20_000 })).code === 0
}

/**
 * Inspect one container.
 * @param name - the container's name or id.
 * @returns the inspected container.
 * @throws Error when Docker does not know the container.
 */
export async function inspectContainer(name: string): Promise<InspectedContainer> {
  const result = await docker(['inspect', name])
  if (result.code !== 0) throw new Error(`docker inspect ${name}: ${result.stderr.trim()}`)
  const parsed = JSON.parse(result.stdout) as InspectedContainer[]
  const first = parsed[0]
  if (first === undefined) throw new Error(`docker inspect ${name} returned nothing`)
  return first
}

/**
 * Pick a free host port in the bench range.
 * @param taken - ports to skip.
 * @returns a port nothing listens on.
 * @throws Error when none is free.
 */
export async function pickBenchPort(taken: readonly number[] = []): Promise<number> {
  for (let port = BENCH_PORT_RANGE.first; port <= BENCH_PORT_RANGE.last; port++) {
    if (taken.includes(port)) continue
    const free = await new Promise<boolean>((done) => {
      const server = createServer()
      server.once('error', () => { done(false) })
      server.listen(port, '127.0.0.1', () => { server.close(() => { done(true) }) })
    })
    if (free) return port
  }
  throw new Error('no free port in the bench range')
}

/**
 * Remove containers the bench made for one run, and its volumes.
 * @param runId - the run's id.
 * @returns nothing; removal failures are ignored, since the labels let a later sweep find leftovers.
 */
export async function removeRun(runId: string): Promise<void> {
  const containers = (await docker(['ps', '-aq', '--filter', `label=delorun.bench.run=${runId}`])).stdout.split('\n').filter(line => line !== '')
  if (containers.length > 0) await docker(['rm', '-f', '-v', ...containers])
  const volumes = (await docker(['volume', 'ls', '-q', '--filter', `label=delorun.bench.run=${runId}`])).stdout.split('\n').filter(line => line !== '')
  if (volumes.length > 0) await docker(['volume', 'rm', '-f', ...volumes])
}
