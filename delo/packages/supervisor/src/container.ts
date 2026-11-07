/**
 * The containers and networks the supervisor creates, as Engine API bodies built only from contract C9 (sections
 * "Containers" and "Networks and egress"): every capability dropped, `no-new-privileges`, the engine's seccomp
 * profile kept, a read-only root with a tmpfs `/tmp`, the preset's limits with swap equal to memory, an init process,
 * no restart policy, no device, none of the host's namespaces, and only the mounts C9 lists. After creation,
 * {@link hardeningDifferences} compares the engine's inspect record with what was asked, so a container the engine
 * changed is removed rather than started.
 *
 * @module @delo/supervisor/container
 */
import { createHash } from 'node:crypto'
import {
  EGRESS_PROXY_PORT,
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
  /** Bind mounts, each with the same path inside the container unless a target is given. */
  readonly binds: readonly { readonly source: string, readonly target: string }[]
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
    readonly Mounts: readonly { readonly Type: 'bind', readonly Source: string, readonly Target: string, readonly ReadOnly: false }[]
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
    Labels: plan.labels,
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
      Mounts: plan.binds.map(bind => ({ Type: 'bind', Source: bind.source, Target: bind.target, ReadOnly: false })),
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
}

/**
 * The Engine API body of a workspace network.
 * @param name - the network's name.
 * @param internal - true for the workspace's internal network, false for the proxy's way out.
 * @param labels - the owner's labels.
 * @returns the create body.
 */
export function networkBody(name: string, internal: boolean, labels: Readonly<Record<string, string>>): NetworkBody {
  return { Name: name, Driver: 'bridge', Internal: internal, Attachable: false, Labels: labels }
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
 * The bind mounts of an S2 workspace container: the resolved workspace root at the same path, and the helper's
 * socket directory at C9's mount point.
 * @param root - the resolved workspace root.
 * @param helperDir - `~/.delo/run/<profile>/s2/<12 hex>/`.
 * @returns the binds.
 */
export function workspaceBinds(root: string, helperDir: string): { readonly source: string, readonly target: string }[] {
  return [{ source: root, target: root }, { source: helperDir, target: HELPER_SOCKET_DIR }]
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
    readonly Tmpfs?: Readonly<Record<string, string>> | null
  }
  readonly Mounts?: readonly { readonly Type?: string, readonly Source?: string, readonly Destination?: string }[] | null
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
  expect('HostConfig.Tmpfs', host.Tmpfs?.['/tmp'] === body.HostConfig.Tmpfs['/tmp'])
  if (body.HostConfig.StorageOpt !== undefined) expect('HostConfig.StorageOpt', host.StorageOpt?.size === body.HostConfig.StorageOpt.size)
  const wanted = body.HostConfig.Mounts.map(mount => `${mount.Source}:${mount.Target}`).sort()
  const found = (record.Mounts ?? []).filter(mount => mount.Type === 'bind').map(mount => `${mount.Source ?? ''}:${mount.Destination ?? ''}`).sort()
  const unexpected = (record.Mounts ?? []).filter(mount => mount.Type !== 'bind' && mount.Type !== 'tmpfs').map(mount => `${mount.Type ?? 'unknown'}:${mount.Destination ?? ''}`)
  const mounts = [...found.filter(mount => !wanted.includes(mount)), ...wanted.filter(mount => !found.includes(mount)), ...unexpected]
  return { mounts, settings }
}
