/**
 * The Docker part of the capability report, built by inspection (contract C9, "The capability report"). The
 * supervisor reads the engine's `info` and `version`, creates a probe container from the S2 image's listed digest
 * with the Small preset on an internal network of its own, reads the container's inspect record and runs fixed probe
 * commands inside it, then removes the container and the network whatever happens. A limit is `enforced` only when
 * the inspect record shows it and the probe inside the container confirms it; nothing is reported enforced from the
 * request or the configuration alone.
 *
 * @module @delo/supervisor/capabilities
 */
import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:net'
import {
  PRESETS,
  REQUIRED_LIMITS,
  type DockerCapabilities,
  type DockerLimit,
  type DockerShape,
  type LimitFinding,
  type ShapeAvailability,
  type ShapeReason,
} from '@delo/contract-runtime-supervisor'
import type { ImagePlatform } from '@delo/contract-release-manifest'
import { createBody, hardeningDifferences, labelsOf, networkBody, workspaceUser, type CreateBody, type InspectRecord, type Owner } from './container.ts'
import type { DockerContext } from './docker/endpoint.ts'
import { EngineError, type Engine } from './docker/engine.ts'
import { SupervisorError } from './errors.ts'
import { ensureListedImage, type ImagePull } from './images.ts'
import { imagePlatform, listedImage, type VerifiedManifest } from './manifest.ts'

/** The fields of the engine's `info` the report reads. */
export interface EngineInfo {
  readonly OperatingSystem?: string
  readonly Driver?: string
  readonly SecurityOptions?: readonly string[] | null
  readonly NCPU?: number
  readonly MemTotal?: number
  readonly Architecture?: string
  readonly CgroupVersion?: string
}

/** The fields of the engine's `version` the report reads. */
export interface EngineVersion {
  readonly Version?: string
  readonly Platform?: { readonly Name?: string }
}

/** The fields of a network's inspect record the report reads. */
export interface NetworkRecord {
  readonly Internal?: boolean
  readonly IPAM?: { readonly Config?: readonly { readonly Gateway?: string }[] | null }
}

/** The machine as the engine sees it, which bounds the presets. */
export interface EngineMachine {
  /** Logical CPUs. */
  readonly cpus: number
  /** Memory, in bytes. */
  readonly memoryBytes: number
}

/** What one inspection found. */
export interface Inspection {
  /** The Docker part, absent when no engine answers or the endpoint is a network endpoint. */
  readonly docker?: DockerCapabilities
  /** Availability per shape. */
  readonly shapes: Readonly<Record<DockerShape, ShapeAvailability>>
  /** The engine's machine, when an engine answered. */
  readonly machine?: EngineMachine
  /** The engine's image platform, when an engine answered. */
  readonly platform?: ImagePlatform
  /** The probe container's inspect record, when a probe ran. */
  readonly probe?: InspectRecord
}

/** The probe commands, each an argv whose exit code 0 means the property holds inside the container. */
export const PROBE_COMMANDS = {
  capabilities: ['sh', '-c', 'grep -Eq "^CapEff:[[:space:]]+0+$" /proc/self/status'],
  noNewPrivileges: ['sh', '-c', 'grep -Eq "^NoNewPrivs:[[:space:]]+1$" /proc/self/status'],
  seccomp: ['sh', '-c', 'grep -Eq "^Seccomp:[[:space:]]+2$" /proc/self/status'],
  readOnlyRoot: ['sh', '-c', 'grep -Eq "^[^ ]+ / [^ ]+ ro[, ]" /proc/mounts'],
  memory: ['sh', '-c', 'v=$(cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes); test "$v" = "$0"', String(PRESETS.small.memoryBytes)],
  pids: ['sh', '-c', 'v=$(cat /sys/fs/cgroup/pids.max 2>/dev/null || cat /sys/fs/cgroup/pids/pids.max); test "$v" = "$0"', String(PRESETS.small.pids)],
  cpu: ['sh', '-c', 'if [ -r /sys/fs/cgroup/cpu.max ]; then read q p < /sys/fs/cgroup/cpu.max; else q=$(cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us); p=$(cat /sys/fs/cgroup/cpu/cpu.cfs_period_us); fi; test "$q" != max && test $((q * 1000000000 / p)) = "$0"', String(PRESETS.small.cpus * 1e9)],
  userNamespace: ['sh', '-c', '! grep -Eq "^[[:space:]]*0[[:space:]]+0[[:space:]]+4294967295" /proc/self/uid_map'],
  // The kernel keeps a rejecting IPv6 default route on `lo` in every namespace; only a route on another interface leaves.
  noDefaultRoute: ['sh', '-c', 'awk \'NR > 1 && $2 == "00000000" { found = 1 } END { exit found }\' /proc/net/route && { [ ! -r /proc/net/ipv6_route ] || awk \'$1 ~ /^0+$/ && $2 == "00" && $10 != "lo" { found = 1 } END { exit found }\' /proc/net/ipv6_route; }'],
  disk: ['sh', '-c', 'test "$(df -B1 --output=size / | tail -n 1)" -le "$0"', String(PRESETS.small.diskBytes)],
} as const satisfies Record<string, readonly string[]>

/** The probe container's own entry: it waits, and the probes run as execs beside it. */
export const PROBE_ENTRY = ['sleep', 'infinity'] as const

/**
 * The argv that connects to one TCP address from inside the probe container: exit 0 when a connection opened.
 * @param host - an address or name.
 * @param port - the port.
 * @returns the argv.
 */
export function connectCommand(host: string, port: number): string[] {
  return ['timeout', '3', 'bash', '-c', 'exec 3<>"/dev/tcp/$0/$1"', host, String(port)]
}

/** How long one probe command may run, in milliseconds. */
const PROBE_COMMAND_MS = 10_000

/** Exit codes that mean a probe tool is missing or not runnable, not that the probed property failed. */
const TOOL_MISSING = new Set([126, 127])

/** What the probe container showed, for {@link limitFindings}. */
export interface ProbeEvidence {
  /** The engine's info. */
  readonly info: EngineInfo
  /** The probe container's inspect record. */
  readonly inspect: InspectRecord
  /** The body the container was created from. */
  readonly body: CreateBody
  /** The probe network's inspect record. */
  readonly network: NetworkRecord
  /** Each probe command's exit code, or `undefined` when it did not exit in time. */
  readonly exits: Readonly<Record<keyof typeof PROBE_COMMANDS, number | undefined>>
  /** Why the container was created without a disk size, when it was. */
  readonly diskRefused?: string
  /** The host-gateway probe: the connect's exit code, or why it did not run. */
  readonly gateway: { readonly exit: number | undefined, readonly address: string } | { readonly skipped: string }
  /** The host-loopback probe: each target's connect exit code. */
  readonly loopback: readonly { readonly target: string, readonly exit: number | undefined }[]
}

/**
 * A finding from an inspected field and an in-container probe.
 * @param field - the inspected field's name.
 * @param value - its value.
 * @param shown - whether the inspected value shows the limit.
 * @param exit - the probe's exit code, when one ran.
 * @param probe - the probe's description.
 * @returns the finding.
 */
function finding(field: string, value: unknown, shown: boolean, exit: number | undefined, probe: string): LimitFinding {
  const evidence = `${field}=${JSON.stringify(value) ?? 'null'}; ${probe} exit ${exit === undefined ? 'none (timed out)' : String(exit)}`
  if (exit === undefined || TOOL_MISSING.has(exit)) return { status: 'unknown', evidence }
  return { status: shown && exit === 0 ? 'enforced' : 'not-enforced', evidence }
}

/**
 * Whether every connect of a probe failed, with each tool present.
 * @param exits - the connects' exit codes.
 * @returns the status the connects show.
 */
function blocked(exits: readonly (number | undefined)[]): LimitFinding['status'] {
  if (exits.some(exit => exit === 0)) return 'not-enforced'
  if (exits.some(exit => exit === undefined || TOOL_MISSING.has(exit))) return 'unknown'
  return 'enforced'
}

/**
 * The limit findings of one probe.
 * @param evidence - what the probe container showed.
 * @returns one finding per limit.
 */
export function limitFindings(evidence: ProbeEvidence): Record<DockerLimit, LimitFinding> {
  const host = evidence.inspect.HostConfig ?? {}
  const security = evidence.info.SecurityOptions ?? []
  const differences = new Set(hardeningDifferences(evidence.inspect, evidence.body).settings)
  const { exits } = evidence
  const engineUserNamespace = security.some(option => option.includes('name=userns') || option.includes('name=rootless'))
  const isolated = evidence.network.Internal === true && Object.keys(evidence.inspect.NetworkSettings?.Networks ?? {}).length === 1
  const gateway: LimitFinding = 'skipped' in evidence.gateway
    ? { status: 'unknown', evidence: evidence.gateway.skipped }
    : { status: blocked([evidence.gateway.exit]), evidence: `connect to a listener on ${evidence.gateway.address} exit ${String(evidence.gateway.exit ?? 'none (timed out)')}` }
  return {
    'cpu': finding('HostConfig.NanoCpus', host.NanoCpus, !differences.has('HostConfig.NanoCpus'), exits.cpu, 'cgroup cpu quota'),
    'memory': finding('HostConfig.Memory', host.Memory, !differences.has('HostConfig.Memory') && !differences.has('HostConfig.MemorySwap'), exits.memory, 'cgroup memory limit'),
    'pids': finding('HostConfig.PidsLimit', host.PidsLimit, !differences.has('HostConfig.PidsLimit'), exits.pids, 'cgroup pids limit'),
    'disk': evidence.diskRefused !== undefined
      ? { status: 'not-enforced', evidence: `HostConfig.StorageOpt refused: ${evidence.diskRefused}` }
      : finding('HostConfig.StorageOpt', host.StorageOpt ?? null, host.StorageOpt?.size !== undefined && host.StorageOpt.size === evidence.body.HostConfig.StorageOpt?.size, exits.disk, 'root filesystem size within the limit'),
    'cap-drop': finding('HostConfig.CapDrop', host.CapDrop, !differences.has('HostConfig.CapDrop') && !differences.has('HostConfig.CapAdd') && !differences.has('HostConfig.Privileged'), exits.capabilities, 'CapEff zero'),
    'no-new-privileges': finding('HostConfig.SecurityOpt', host.SecurityOpt, (host.SecurityOpt ?? []).some(option => /^no-new-privileges(?::true|=true)?$/.test(option)), exits.noNewPrivileges, 'NoNewPrivs 1'),
    'read-only-root': finding('HostConfig.ReadonlyRootfs', host.ReadonlyRootfs, host.ReadonlyRootfs === true, exits.readOnlyRoot, '/ mounted ro'),
    'seccomp': finding('Info.SecurityOptions', security, security.some(option => option.includes('name=seccomp')) && !(host.SecurityOpt ?? []).some(option => /^seccomp[:=]unconfined$/.test(option)), exits.seccomp, 'Seccomp 2'),
    'user-namespace': finding('Info.SecurityOptions', security, engineUserNamespace, exits.userNamespace, 'uid_map not the identity'),
    'network-isolation': finding('Network.Internal', evidence.network.Internal, isolated, exits.noDefaultRoute, 'no default route'),
    'host-gateway-block': gateway,
    'host-loopback-block': {
      status: blocked(evidence.loopback.map(entry => entry.exit)),
      evidence: evidence.loopback.map(entry => `connect to ${entry.target} exit ${String(entry.exit ?? 'none (timed out)')}`).join('; '),
    },
    'egress-allowlist': { status: 'unknown', evidence: 'not probed: the probe needs the S2 image\'s egress proxy' },
  }
}

/**
 * Every limit as `unknown`, when no probe ran.
 * @param reason - why no probe ran.
 * @returns the findings.
 */
function unprobed(reason: string): Record<DockerLimit, LimitFinding> {
  const keys: readonly DockerLimit[] = ['cpu', 'memory', 'pids', 'disk', 'cap-drop', 'no-new-privileges', 'read-only-root', 'seccomp', 'user-namespace', 'network-isolation', 'host-gateway-block', 'host-loopback-block', 'egress-allowlist']
  return Object.fromEntries(keys.map(key => [key, { status: 'unknown', evidence: `no probe: ${reason}` }])) as Record<DockerLimit, LimitFinding>
}

/**
 * The engine kind from its info and version.
 * @param info - the engine's info.
 * @param version - the engine's version.
 * @returns the kind.
 */
export function engineKind(info: EngineInfo, version: EngineVersion): DockerCapabilities['engine'] {
  if ((info.OperatingSystem ?? '').includes('Docker Desktop')) return 'docker-desktop'
  if ((version.Platform?.Name ?? '').includes('Docker Engine')) return 'docker-engine'
  return 'other'
}

/**
 * The availability of each shape.
 * @param docker - the Docker part, or `undefined` when none was built.
 * @param absent - why the Docker part is absent.
 * @param images - why each shape's image is unverified, if it is.
 * @returns the availability per shape.
 */
export function shapesOf(docker: DockerCapabilities | undefined, absent: ShapeReason | undefined, images: Readonly<Partial<Record<DockerShape, string>>>): Record<DockerShape, ShapeAvailability> {
  const unavailable = (reason: ShapeReason): ShapeAvailability => ({ available: false, reason, fileWatching: 'unsupported' })
  if (docker === undefined) return { s2: unavailable(absent ?? 'docker-unavailable'), s3: unavailable(absent ?? 'docker-unavailable') }
  if (docker.endpoint.kind === 'tcp' || docker.endpoint.kind === 'ssh') return { s2: unavailable('docker-endpoint-network'), s3: unavailable('docker-endpoint-network') }
  // Bind-mounted helper sockets do not cross Docker Desktop's VM file sharing, on any host system.
  const fileWatching = docker.engine === 'docker-desktop' ? 'unsupported' : 'supported'
  const missing = REQUIRED_LIMITS.some(limit => docker.limits[limit].status !== 'enforced')
  const shape = (name: DockerShape): ShapeAvailability => {
    if (name === 's2' && docker.engine === 'docker-desktop') return unavailable('s2-transport-unsupported')
    if (images[name] !== undefined) return unavailable('image-unverified')
    if (missing) return unavailable('limits-missing')
    return { available: true, fileWatching }
  }
  return { s2: shape('s2'), s3: shape('s3') }
}

/** What an inspection needs. */
export interface InspectOptions {
  /** The engine of the active context. */
  readonly engine: Engine
  /** The active context. */
  readonly context: DockerContext
  /** The verified manifest. */
  readonly manifest: VerifiedManifest
  /** Whether absent images are pulled. */
  readonly pull: ImagePull
  /** The home and profile the probe's labels name. */
  readonly owner: Owner
}

function listen(host: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer(socket => { socket.destroy() })
    server.once('error', reject)
    server.listen(0, host, () => { resolve(server) })
  })
}

function portOf(server: Server): number {
  const address = server.address()
  return typeof address === 'object' && address !== null ? address.port : 0
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (server === undefined) return
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
}

/**
 * Remove a probe object, whatever state it is in.
 * @param engine - the engine.
 * @param path - the object's DELETE path.
 */
async function removeQuietly(engine: Engine, path: string): Promise<void> {
  try {
    await engine.call('DELETE', path)
  } catch (error) {
    // An object that is already gone is removed; any other failure is the caller's to report.
    if (!(error instanceof EngineError) || error.status !== 404) throw error
  }
}

/**
 * Run the probe container and collect its evidence. The container and network are removed before this returns.
 * @param options - the engine and owner.
 * @param info - the engine's info.
 * @param image - the listed image's reference.
 * @returns the evidence.
 */
async function probe(options: InspectOptions, info: EngineInfo, image: string): Promise<ProbeEvidence> {
  const { engine, owner } = options
  const suffix = randomBytes(6).toString('hex')
  const name = `delo-probe-${owner.homeId}-${suffix}`
  const labels = labelsOf(owner, undefined)
  const rootless = (info.SecurityOptions ?? []).some(option => option.includes('name=rootless'))
  let gatewayServer: Server | undefined
  let loopbackServer: Server | undefined
  let networkCreated = false
  let containerCreated = false
  try {
    await engine.call('POST', '/networks/create', networkBody(name, true, labels))
    networkCreated = true
    const plan = { name, image, labels, user: workspaceUser(rootless), limits: PRESETS.small, networks: [name], binds: [], command: [...PROBE_ENTRY], env: [] }
    let body = createBody({ ...plan, diskQuota: true })
    let diskRefused: string | undefined
    try {
      await engine.call('POST', `/containers/create?name=${encodeURIComponent(name)}`, body)
    } catch (error) {
      if (!(error instanceof EngineError) || error.status === 0) throw error
      diskRefused = error.message.slice(0, 200)
      body = createBody({ ...plan, diskQuota: false })
      await engine.call('POST', `/containers/create?name=${encodeURIComponent(name)}`, body)
    }
    containerCreated = true
    await engine.call('POST', `/containers/${encodeURIComponent(name)}/start`)
    const inspect = await engine.call('GET', `/containers/${encodeURIComponent(name)}/json`) as InspectRecord
    const network = await engine.call('GET', `/networks/${encodeURIComponent(name)}`) as NetworkRecord
    const exits = Object.fromEntries(await Promise.all(Object.entries(PROBE_COMMANDS).map(async ([key, cmd]) => [key, await engine.execExitCode(name, cmd, PROBE_COMMAND_MS)] as const))) as ProbeEvidence['exits']
    const address = network.IPAM?.Config?.[0]?.Gateway
    let gateway: ProbeEvidence['gateway']
    if (address === undefined || address === '') {
      gateway = { skipped: 'the probe network has no gateway address' }
    } else {
      try {
        gatewayServer = await listen(address)
        gateway = { address, exit: await engine.execExitCode(name, connectCommand(address, portOf(gatewayServer)), PROBE_COMMAND_MS) }
      } catch (error) {
        gateway = { skipped: `the supervisor cannot listen on the gateway address ${address} (${(error as NodeJS.ErrnoException).code ?? 'error'}); the engine's network is not on this machine` }
      }
    }
    loopbackServer = await listen('127.0.0.1')
    const port = portOf(loopbackServer)
    const targets = ['host.docker.internal', '10.0.2.2', ...address === undefined || address === '' ? [] : [address]]
    const loopback = await Promise.all(targets.map(async target => ({ target: `${target}:${String(port)}`, exit: await engine.execExitCode(name, connectCommand(target, port), PROBE_COMMAND_MS) })))
    return { info, inspect, body, network, exits, gateway, loopback, ...diskRefused === undefined ? {} : { diskRefused } }
  } finally {
    await closeServer(gatewayServer)
    await closeServer(loopbackServer)
    if (containerCreated) await removeQuietly(engine, `/containers/${encodeURIComponent(name)}?force=true&v=true`)
    if (networkCreated) await removeQuietly(engine, `/networks/${encodeURIComponent(name)}`)
  }
}

/**
 * Inspect the engine of the active context and build the Docker part of the report.
 * @param options - the engine, context, manifest and owner.
 * @returns the inspection; a probe the engine failed reports every limit `unknown` with the engine's message.
 */
export async function inspectDocker(options: InspectOptions): Promise<Inspection> {
  const { engine, context } = options
  if (context.endpoint.kind === 'tcp' || context.endpoint.kind === 'ssh') return { shapes: shapesOf(undefined, 'docker-endpoint-network', {}) }
  let info: EngineInfo
  let version: EngineVersion
  try {
    info = await engine.call('GET', '/info') as EngineInfo
    version = await engine.call('GET', '/version') as EngineVersion
  } catch (error) {
    if (error instanceof EngineError && error.status === 0) return { shapes: shapesOf(undefined, 'docker-unavailable', {}) }
    throw error
  }
  const platform = imagePlatform(info.Architecture ?? '')
  const machine = { cpus: info.NCPU ?? 0, memoryBytes: info.MemTotal ?? 0 }
  const images: Partial<Record<DockerShape, string>> = {}
  let s2Image: string | undefined
  for (const shape of ['s2', 's3'] as const) {
    try {
      const listed = listedImage(options.manifest, shape, platform)
      if (shape === 's2') s2Image = await ensureListedImage(engine, listed, options.pull)
    } catch (error) {
      if (!(error instanceof SupervisorError)) throw error
      images[shape] = error.detail ?? error.code
    }
  }
  let limits: Record<DockerLimit, LimitFinding>
  let probeRecord: InspectRecord | undefined
  if (s2Image === undefined) {
    limits = unprobed(images.s2 ?? 'the S2 image is not verified')
  } else {
    try {
      const evidence = await probe(options, info, s2Image)
      limits = limitFindings(evidence)
      probeRecord = evidence.inspect
    } catch (error) {
      if (!(error instanceof EngineError)) throw error
      limits = unprobed(`the probe container failed: ${error.message}`)
    }
  }
  const docker: DockerCapabilities = {
    engine: engineKind(info, version),
    version: version.Version ?? 'unknown',
    rootless: (info.SecurityOptions ?? []).some(option => option.includes('name=rootless')),
    context: context.name,
    endpoint: context.endpoint,
    storageDriver: info.Driver ?? 'unknown',
    limits,
  }
  return { docker, shapes: shapesOf(docker, undefined, images), machine, ...platform === undefined ? {} : { platform }, ...probeRecord === undefined ? {} : { probe: probeRecord } }
}
