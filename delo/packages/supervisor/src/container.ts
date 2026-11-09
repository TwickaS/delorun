/**
 * The containers and networks the supervisor creates, as Engine API bodies built only from contract C9 (sections
 * "Containers" and "Networks and egress"): every capability dropped, `no-new-privileges`, the engine's seccomp
 * profile kept, a read-only root with a tmpfs `/tmp`, the preset's limits with swap equal to memory, an init process,
 * no restart policy, no device, none of the host's namespaces, and only the mounts C9 lists, the helper's among them
 * read-only but for its channel. An internal network is created with the bridge driver's `isolated` gateway mode, so
 * the container has no address of the machine to reach. After creation,
 * {@link hardeningDifferences} compares the engine's inspect record with what was asked, so a container the engine
 * changed is removed rather than started.
 *
 * @module @delo/supervisor/container
 */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import {
  EGRESS_PROXY_PORT,
  HELPER_CHANNEL_DIR,
  HELPER_CHANNEL_NAME,
  HELPER_SOCKET_DIR,
  LABELS,
  NAME_HASH_HEX_DIGITS,
  S3_USERS,
  type ResourceLimits,
  type WorkspaceId,
} from '@delo/contract-runtime-supervisor'
import { HOME_ID_HEX_DIGITS } from '@delo/contract-home-layout'

/** Whose containers these are: C1's `homeId` and the CLI profile, carried as labels on everything created. */
export interface Owner {
  /** C1's `homeId` of the Delo home. */
  readonly homeId: string
  /** The CLI profile. */
  readonly profile: string
}

/** The user workspace commands and the helper run as inside a container (C9, "The S2 helper channel"). */
export interface ContainerUser {
  /** The uid. */
  readonly uid: number
  /** The gid. */
  readonly gid: number
}

/**
 * The workspace user on an engine: the person's uid and gid on a rootful engine, and uid 0 on a rootless engine,
 * which the engine maps to the person's uid on the machine. On Windows, where the person has no uid, it is the uid and
 * gid of S3's workspace user.
 * @param rootless - whether the engine is rootless.
 * @returns the user.
 */
export function workspaceUser(rootless: boolean): ContainerUser {
  if (rootless) return { uid: 0, gid: 0 }
  return { uid: process.getuid?.() ?? S3_USERS.workspace.uid, gid: process.getgid?.() ?? S3_USERS.workspace.uid }
}

/**
 * C1's `homeId`: the first 16 lowercase hexadecimal digits of the SHA-256 digest of the resolved home path.
 * @param home - the resolved Delo home.
 * @returns the id.
 */
export function homeIdOf(home: string): string {
  return createHash('sha256').update(home, 'utf8').digest('hex').slice(0, HOME_ID_HEX_DIGITS)
}

/**
 * The 12 hexadecimal digits that name a workspace's container and networks.
 * @param workspaceId - the workspace.
 * @returns the first 12 digits of the SHA-256 digest of its id.
 */
export function workspaceHash(workspaceId: WorkspaceId): string {
  return createHash('sha256').update(workspaceId, 'utf8').digest('hex').slice(0, NAME_HASH_HEX_DIGITS)
}

/** The names of one workspace's Docker objects. */
export interface WorkspaceNames {
  /** The workspace container and its internal network: `delo-ws-<12 hex>`. */
  readonly container: string
  /** The internal network, which has the container's name. */
  readonly network: string
  /** The egress proxy's second network, its only route out: `delo-ws-<12 hex>-out`. */
  readonly outNetwork: string
  /** The egress proxy container. */
  readonly proxy: string
}

/**
 * The names of a workspace's container, networks and proxy.
 * @param workspaceId - the workspace.
 * @returns the names.
 */
export function workspaceNames(workspaceId: WorkspaceId): WorkspaceNames {
  const name = `delo-ws-${workspaceHash(workspaceId)}`
  return { container: name, network: name, outNetwork: `${name}-out`, proxy: `${name}-proxy` }
}

/**
 * The labels every object of a workspace carries.
 * @param owner - the home and profile.
 * @param workspaceId - the workspace, or `undefined` for a probe.
 * @returns the labels.
 */
export function labelsOf(owner: Owner, workspaceId: WorkspaceId | undefined): Record<string, string> {
  return {
    [LABELS.home]: owner.homeId,
    [LABELS.profile]: owner.profile,
    [LABELS.shape]: 's2',
    ...workspaceId === undefined ? {} : { [LABELS.workspace]: workspaceId },
  }
}

/**
 * The label carrying the limits a container was created with, as JSON: the supervisor's own record beside C9's
 * ownership labels, so a limit the machine changed afterwards is compared with what was asked and not with itself.
 */
export const LIMITS_LABEL = 'delo.limits'

/** The files every engine mounts itself, at these destinations. They are the engine's, not a host path a container chose. */
export const ENGINE_FILE_MOUNTS: readonly string[] = ['/etc/hosts', '/etc/hostname', '/etc/resolv.conf']

/**
 * The limits a container runs with, from its inspect record's own fields.
 * @param record - the container's inspect record.
 * @returns the limits the engine reports.
 */
export function limitsOf(record: InspectRecord): ResourceLimits {
  const host = record.HostConfig ?? {}
  return {
    cpus: (host.NanoCpus ?? 0) / 1e9,
    memoryBytes: host.Memory ?? 0,
    diskBytes: Number(host.StorageOpt?.size ?? 0),
    pids: host.PidsLimit ?? 0,
    tmpBytes: Number(/size=(\d+)/.exec(host.Tmpfs?.['/tmp'] ?? '')?.[1] ?? 0),
  }
}

/**
 * The limits a container records in {@link LIMITS_LABEL} that it was created with.
 * @param record - the container's inspect record.
 * @returns the recorded limits, or `undefined` when the label is absent or not the five whole numbers.
 */
export function recordedLimits(record: InspectRecord): ResourceLimits | undefined {
  const text = record.Config?.Labels?.[LIMITS_LABEL]
  if (text === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (_notJson) {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const value = parsed as Readonly<Record<string, unknown>>
  const whole = (field: string, least: number): number | undefined => {
    const entry = value[field]
    return typeof entry === 'number' && Number.isInteger(entry) && entry >= least ? entry : undefined
  }
  const cpus = whole('cpus', 1)
  const memoryBytes = whole('memoryBytes', 1)
  const diskBytes = whole('diskBytes', 0)
  const pids = whole('pids', 1)
  const tmpBytes = whole('tmpBytes', 1)
  if (cpus === undefined || memoryBytes === undefined || diskBytes === undefined || pids === undefined || tmpBytes === undefined) return undefined
  return { cpus, memoryBytes, diskBytes, pids, tmpBytes }
}

/**
 * Where a container's own limits differ from the ones it records it was created with: the fields behind C9's CPU,
 * memory, disk, PID and `/tmp` limits, each named with what it holds and what it must hold.
 * @param record - the container's inspect record.
 * @param limits - the limits recorded at its creation.
 * @returns one entry per differing field; empty when the container still runs with them.
 */
export function limitDifferences(record: InspectRecord, limits: ResourceLimits): string[] {
  const host = record.HostConfig ?? {}
  const actual = limitsOf(record)
  const differences: string[] = []
  if (actual.cpus !== limits.cpus) differences.push(`HostConfig.NanoCpus=${String(host.NanoCpus ?? 0)} is not ${String(limits.cpus)} CPUs`)
  if (actual.memoryBytes !== limits.memoryBytes) differences.push(`HostConfig.Memory=${String(actual.memoryBytes)} is not ${String(limits.memoryBytes)} bytes`)
  if ((host.MemorySwap ?? 0) !== limits.memoryBytes) differences.push(`HostConfig.MemorySwap=${String(host.MemorySwap ?? 0)} is not the memory limit ${String(limits.memoryBytes)} bytes`)
  if (actual.pids !== limits.pids) differences.push(`HostConfig.PidsLimit=${String(actual.pids)} is not ${String(limits.pids)} PIDs`)
  // A disk size is set only where the engine enforces one; where it is not, the created container has none either.
  if (host.StorageOpt?.size !== undefined && actual.diskBytes !== limits.diskBytes) differences.push(`HostConfig.StorageOpt.size=${String(actual.diskBytes)} is not ${String(limits.diskBytes)} bytes`)
  if (actual.tmpBytes !== limits.tmpBytes) differences.push(`HostConfig.Tmpfs["/tmp"] size=${String(actual.tmpBytes)} is not ${String(limits.tmpBytes)} bytes`)
  return differences
}

/** The variables a workspace container's tools read for the proxy. */
export const PROXY_VARIABLES = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'] as const

/** What one container is created with, before it becomes an Engine API body. */
export interface ContainerPlan {
  /** The container's name. */
  readonly name: string
  /** `<repository>@<digest>` from the verified manifest. */
  readonly image: string
  /** The labels. */
  readonly labels: Readonly<Record<string, string>>
  /** The user commands run as. */
  readonly user: ContainerUser
  /** The limits in effect. */
  readonly limits: ResourceLimits
  /** Whether the engine enforces a disk size, so `StorageOpt` is set. */
  readonly diskQuota: boolean
  /** The networks the container joins; the first is its network mode. */
  readonly networks: readonly string[]
  /** Bind mounts, each with the same path inside the container unless a target is given; all but `readOnly` ones are writable. */
  readonly binds: readonly { readonly source: string, readonly target: string, readonly readOnly?: boolean }[]
  /** The argv, or `undefined` for the image's own entry. */
  readonly command?: readonly string[]
  /** Variables derived from the contract; never a request's value. */
  readonly env: readonly string[]
  /** The seccomp profile the verified manifest lists for the image, as checked JSON text; the engine's default when absent. */
  readonly seccomp?: string
  /** The working directory, if any. */
  readonly workingDir?: string
}

/** An Engine API container-create body. */
export interface CreateBody {
  readonly Image: string
  readonly User: string
  readonly Labels: Readonly<Record<string, string>>
  readonly Env: readonly string[]
  readonly Cmd?: readonly string[]
  readonly WorkingDir?: string
  readonly HostConfig: {
    readonly CapDrop: readonly string[]
    readonly CapAdd: readonly string[]
    readonly Privileged: false
    readonly SecurityOpt: readonly string[]
    readonly ReadonlyRootfs: true
    readonly Tmpfs: Readonly<Record<string, string>>
    readonly NanoCpus: number
    readonly Memory: number
    readonly MemorySwap: number
    readonly PidsLimit: number
    readonly StorageOpt?: Readonly<Record<string, string>>
    readonly Init: true
    readonly RestartPolicy: { readonly Name: 'no' }
    readonly NetworkMode: string
    readonly Mounts: readonly { readonly Type: 'bind', readonly Source: string, readonly Target: string, readonly ReadOnly: boolean }[]
    readonly Devices: readonly []
    readonly IpcMode: 'private'
    readonly PidMode: ''
    readonly UsernsMode: ''
    readonly CgroupnsMode: 'private'
  }
  readonly NetworkingConfig: { readonly EndpointsConfig: Readonly<Record<string, Record<string, never>>> }
}

/**
 * The Engine API body of a hardened container.
 * @param plan - what the container is created with.
 * @returns the create body; the name goes in the query.
 */
export function createBody(plan: ContainerPlan): CreateBody {
  const [mode = 'none'] = plan.networks
  return {
    Image: plan.image,
    User: `${String(plan.user.uid)}:${String(plan.user.gid)}`,
    // The limits are recorded on the container itself, so a later start compares the machine's fields with what was
    // asked rather than with what the machine reports, which a `docker update` changes in both places at once.
    Labels: { ...plan.labels, [LIMITS_LABEL]: JSON.stringify(plan.limits) },
    Env: plan.env,
    ...plan.command === undefined ? {} : { Cmd: plan.command },
    ...plan.workingDir === undefined ? {} : { WorkingDir: plan.workingDir },
    HostConfig: {
      CapDrop: ['ALL'],
      CapAdd: [],
      Privileged: false,
      SecurityOpt: ['no-new-privileges:true', ...plan.seccomp === undefined ? [] : [`seccomp=${plan.seccomp}`]],
      ReadonlyRootfs: true,
      Tmpfs: { '/tmp': `rw,nosuid,nodev,size=${String(plan.limits.tmpBytes)}` },
      NanoCpus: Math.round(plan.limits.cpus * 1e9),
      Memory: plan.limits.memoryBytes,
      MemorySwap: plan.limits.memoryBytes,
      PidsLimit: plan.limits.pids,
      ...plan.diskQuota ? { StorageOpt: { size: String(plan.limits.diskBytes) } } : {},
      Init: true,
      RestartPolicy: { Name: 'no' },
      NetworkMode: mode,
      Mounts: plan.binds.map(bind => ({ Type: 'bind', Source: bind.source, Target: bind.target, ReadOnly: bind.readOnly === true })),
      Devices: [],
      IpcMode: 'private',
      PidMode: '',
      UsernsMode: '',
      CgroupnsMode: 'private',
    },
    // Only the first network can be given at creation; the others are connected before the container starts.
    NetworkingConfig: { EndpointsConfig: mode === 'none' ? {} : { [mode]: {} } },
  }
}

/** An Engine API network-create body. */
export interface NetworkBody {
  readonly Name: string
  readonly Driver: 'bridge'
  readonly Internal: boolean
  readonly Attachable: false
  readonly Labels: Readonly<Record<string, string>>
  readonly Options: Readonly<Record<string, string>>
}

/**
 * The bridge driver's gateway modes of a workspace's own network, which drop the container's traffic to the bridge
 * gateway: with the gateway mode `isolated`, the engine gives an internal network's bridge no host address, so the
 * container has no address of the machine to reach and none of the person's services answering on it.
 */
export const ISOLATED_GATEWAY_OPTIONS: Readonly<Record<string, string>> = {
  'com.docker.network.bridge.gateway_mode_ipv4': 'isolated',
}

/**
 * The Engine API body of a workspace network.
 * @param name - the network's name.
 * @param internal - true for the workspace's internal network, false for the proxy's way out.
 * @param labels - the owner's labels.
 * @returns the create body; an internal network carries {@link ISOLATED_GATEWAY_OPTIONS} and the way out carries none, because the proxy reaches the internet through that network's own gateway.
 */
export function networkBody(name: string, internal: boolean, labels: Readonly<Record<string, string>>): NetworkBody {
  return { Name: name, Driver: 'bridge', Internal: internal, Attachable: false, Labels: labels, Options: internal ? ISOLATED_GATEWAY_OPTIONS : {} }
}

/**
 * The variables a workspace container gets for its egress: the proxy variables, in every mode. Under `none` no proxy
 * runs, so the name does not resolve and nothing leaves; a later change of mode starts the proxy under the same name.
 * @param proxy - the proxy container's name, which the workspace network's DNS resolves.
 * @returns the `NAME=value` entries.
 */
export function workspaceEnv(proxy: string): string[] {
  return PROXY_VARIABLES.map(name => `${name}=http://${proxy}:${String(EGRESS_PROXY_PORT)}`)
}

/**
 * The bind mounts of an S2 workspace container: the resolved workspace root at the same path, writable; the helper's
 * directory at C9's mount point, read-only; and the one subdirectory of it the helper creates its sockets in, mounted
 * writable at {@link HELPER_CHANNEL_DIR}. A workspace therefore reaches the helper's directory without being able to
 * add to it, rename anything in it or replace it, and the only host path it may add to is the channel's subdirectory.
 * @param root - the resolved workspace root.
 * @param helperDir - `~/.delo/run/<profile>/s2/<12 hex>/`.
 * @returns the binds.
 */
export function workspaceBinds(root: string, helperDir: string): { readonly source: string, readonly target: string, readonly readOnly: boolean }[] {
  return [
    { source: root, target: root, readOnly: false },
    { source: helperDir, target: HELPER_SOCKET_DIR, readOnly: true },
    { source: join(helperDir, HELPER_CHANNEL_NAME), target: HELPER_CHANNEL_DIR, readOnly: false },
  ]
}

/**
 * The one writable subdirectory of the helper's directory on the machine: where the helper creates its sockets.
 * @param helperDir - the helper's directory on the machine.
 * @returns the path of the channel below it, which is the one part of that directory a workspace may write.
 */
export function helperChannelDirectory(helperDir: string): string {
  return join(helperDir, HELPER_CHANNEL_NAME)
}

/** The parts of an Engine API inspect record that {@link hardeningDifferences} reads. */
export interface InspectRecord {
  readonly Id: string
  readonly Name?: string
  readonly Config?: { readonly Image?: string, readonly Labels?: Readonly<Record<string, string>> | null, readonly User?: string, readonly Env?: readonly string[] | null }
  readonly State?: { readonly Status?: string, readonly Running?: boolean, readonly ExitCode?: number }
  readonly HostConfig?: {
    readonly CapDrop?: readonly string[] | null
    readonly CapAdd?: readonly string[] | null
    readonly Privileged?: boolean
    readonly SecurityOpt?: readonly string[] | null
    readonly ReadonlyRootfs?: boolean
    readonly NanoCpus?: number
    readonly Memory?: number
    readonly MemorySwap?: number
    readonly PidsLimit?: number | null
    readonly StorageOpt?: Readonly<Record<string, string>> | null
    readonly Init?: boolean | null
    readonly RestartPolicy?: { readonly Name?: string }
    readonly NetworkMode?: string
    readonly Devices?: readonly unknown[] | null
    readonly IpcMode?: string
    readonly PidMode?: string
    readonly UsernsMode?: string
    readonly CgroupnsMode?: string
    readonly Tmpfs?: Readonly<Record<string, string>> | null
  }
  readonly Mounts?: readonly { readonly Type?: string, readonly Source?: string, readonly Destination?: string, readonly ReadOnly?: boolean }[] | null
  readonly NetworkSettings?: { readonly Networks?: Readonly<Record<string, { readonly Gateway?: string, readonly IPAddress?: string }>> | null }
}

/**
 * Compare a created container's inspect record with its body.
 * @param record - the engine's inspect record.
 * @param body - the body it was created from.
 * @returns the differences, by field, empty when the engine applied every setting.
 */
export function hardeningDifferences(record: InspectRecord, body: CreateBody): { readonly mounts: string[], readonly settings: string[] } {
  const host = record.HostConfig ?? {}
  const settings: string[] = []
  const expect = (field: string, ok: boolean): void => {
    if (!ok) settings.push(field)
  }
  expect('Config.Image', record.Config?.Image === body.Image)
  expect('Config.User', record.Config?.User === body.User)
  expect('HostConfig.CapDrop', (host.CapDrop ?? []).some(cap => cap.toUpperCase() === 'ALL'))
  expect('HostConfig.CapAdd', (host.CapAdd ?? []).length === 0)
  expect('HostConfig.Privileged', host.Privileged === false)
  const listedProfile = body.HostConfig.SecurityOpt.find(option => option.startsWith('seccomp='))
  expect('HostConfig.SecurityOpt', (host.SecurityOpt ?? []).some(option => /^no-new-privileges(?::true|=true)?$/.test(option))
    && !(host.SecurityOpt ?? []).some(option => /^seccomp[:=]unconfined$/.test(option))
    && (listedProfile === undefined || (host.SecurityOpt ?? []).includes(listedProfile)))
  expect('HostConfig.ReadonlyRootfs', host.ReadonlyRootfs === true)
  expect('HostConfig.NanoCpus', host.NanoCpus === body.HostConfig.NanoCpus)
  expect('HostConfig.Memory', host.Memory === body.HostConfig.Memory)
  expect('HostConfig.MemorySwap', host.MemorySwap === body.HostConfig.MemorySwap)
  expect('HostConfig.PidsLimit', host.PidsLimit === body.HostConfig.PidsLimit)
  expect('HostConfig.Init', host.Init === true)
  expect('HostConfig.RestartPolicy', (host.RestartPolicy?.Name ?? 'no') === 'no' || host.RestartPolicy?.Name === '')
  expect('HostConfig.NetworkMode', host.NetworkMode === body.HostConfig.NetworkMode)
  expect('HostConfig.Devices', (host.Devices ?? []).length === 0)
  expect('HostConfig.PidMode', (host.PidMode ?? '') === '')
  expect('HostConfig.IpcMode', host.IpcMode === 'private')
  expect('HostConfig.UsernsMode', (host.UsernsMode ?? '') === '')
  expect('HostConfig.CgroupnsMode', host.CgroupnsMode === body.HostConfig.CgroupnsMode)
  expect('HostConfig.Tmpfs', host.Tmpfs?.['/tmp'] === body.HostConfig.Tmpfs['/tmp'])
  if (body.HostConfig.StorageOpt !== undefined) expect('HostConfig.StorageOpt', host.StorageOpt?.size === body.HostConfig.StorageOpt.size)
  const wanted = body.HostConfig.Mounts.map(mount => `${mount.Source}:${mount.Target}`).sort()
  // The engine mounts its own files beside the container's: they are the engine's, so they are neither asked for nor
  // a difference from the resolved paths.
  const found = (record.Mounts ?? []).filter(mount => mount.Type === 'bind' && !ENGINE_FILE_MOUNTS.includes(mount.Destination ?? '')).map(mount => `${mount.Source ?? ''}:${mount.Destination ?? ''}`).sort()
  const unexpected = (record.Mounts ?? []).filter(mount => mount.Type !== 'bind' && mount.Type !== 'tmpfs').map(mount => `${mount.Type ?? 'unknown'}:${mount.Destination ?? ''}`)
  // A mount asked for read-only that the container may write is a second writable path to the machine, so its mode is
  // compared like every other setting of the body.
  const writable = body.HostConfig.Mounts
    .filter(mount => mount.ReadOnly)
    .filter(mount => (record.Mounts ?? []).some(entry => entry.Type === 'bind' && entry.Source === mount.Source && entry.Destination === mount.Target && entry.ReadOnly !== true))
    .map(mount => `${mount.Source}:${mount.Target} is writable, not read-only`)
  const mounts = [...found.filter(mount => !wanted.includes(mount)), ...wanted.filter(mount => !found.includes(mount)), ...unexpected, ...writable]
  return { mounts, settings }
}
