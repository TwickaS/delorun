/**
 * Types and constants of contract C9, the runtime and supervisor interface
 * (`delorun/docs/contracts/c09-runtime-supervisor.md`): the runtime provider's
 * operations, the capability report, the Docker shapes, the resource presets,
 * the egress defaults, credential forwarding, the supervisor's closed request
 * schema, the roots file, the S2 helper channel, the images and the container
 * denial marker. The package holds no runtime behaviour; the contract page is
 * the authority for every value here.
 *
 * @module @delorun/contract-runtime-supervisor
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ConfinementReport, StartToken } from '@delorun/contract-home-layout'

/** Upstream's workspace id; the same branded type as `WorkspaceId` of `@deepseek-ai/dsh-workspace`. */
export type WorkspaceId = Branded<'WorkspaceId'>

/** Name of the Cordis service the runtime provider registers. */
export const RUNTIME_PROVIDER_SERVICE = 'delorunRuntime'

/** The supervisor protocol's version and the capability report's version. */
export const SUPERVISOR_PROTOCOL_VERSION = 1

/** Where a workspace's commands run. */
export type RuntimeKind = 'native' | 'docker-s2' | 'docker-s3'

/** A Docker shape, chosen per machine in setup. */
export type DockerShape = 's2' | 's3'

/** A resource preset name. */
export type PresetName = 'small' | 'balanced' | 'large' | 'advanced'

/** Resource limits of one workspace container. */
export interface ResourceLimits {
  /** CPUs. */
  readonly cpus: number
  /** Memory, in bytes; swap equals it. */
  readonly memoryBytes: number
  /** Disk, in bytes; enforced only where the storage driver supports a size. */
  readonly diskBytes: number
  /** Process ids. */
  readonly pids: number
  /** Size of the tmpfs `/tmp`, in bytes. */
  readonly tmpBytes: number
}

/** One gibibyte, in bytes. */
export const GIB = 1_073_741_824

/** One mebibyte, in bytes. */
export const MIB = 1_048_576

/** The fixed presets. */
export const PRESETS: Readonly<Record<Exclude<PresetName, 'advanced'>, ResourceLimits>> = {
  small: { cpus: 2, memoryBytes: 4 * GIB, diskBytes: 20 * GIB, pids: 1_024, tmpBytes: 1 * GIB },
  balanced: { cpus: 4, memoryBytes: 8 * GIB, diskBytes: 50 * GIB, pids: 2_048, tmpBytes: 2 * GIB },
  large: { cpus: 8, memoryBytes: 16 * GIB, diskBytes: 100 * GIB, pids: 4_096, tmpBytes: 4 * GIB },
}

/** The preset a request without one resolves to. */
export const DEFAULT_PRESET: Exclude<PresetName, 'advanced'> = 'balanced'

/** Bounds of the Advanced preset; machine-relative bounds are stated on the contract page. */
export const ADVANCED_BOUNDS = {
  /** Fewest CPUs; the most is the machine's logical CPU count. */
  minCpus: 1,
  /** Least memory, in bytes; the most is the machine's memory minus 1 GiB. */
  minMemoryBytes: 1 * GIB,
  /** Memory the machine keeps for itself, in bytes. */
  reservedMemoryBytes: 1 * GIB,
  /** Least disk, in bytes. */
  minDiskBytes: 10 * GIB,
  /** Most disk, in bytes. */
  maxDiskBytes: 1_024 * GIB,
  /** Fewest process ids. */
  minPids: 256,
  /** Most process ids. */
  maxPids: 32_768,
  /** Smallest `/tmp`, in bytes; the largest is half of the memory. */
  minTmpBytes: 256 * MIB,
} as const

/** A workspace's egress mode. */
export type EgressMode = 'allowlist' | 'open' | 'none'

/** The egress mode a request without one resolves to. */
export const DEFAULT_EGRESS: EgressMode = 'allowlist'

/**
 * The default allowlist's fixed hosts. The hosts of the model providers
 * configured in the profile are added to it at resolution.
 */
export const DEFAULT_EGRESS_HOSTS = [
  'registry.npmjs.org',
  'pypi.org',
  'files.pythonhosted.org',
  'crates.io',
  'static.crates.io',
  'index.crates.io',
  'proxy.golang.org',
  'sum.golang.org',
  'github.com',
  'api.github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'raw.githubusercontent.com',
  'release-assets.githubusercontent.com',
] as const

/** Most hosts a person adds to one workspace's allowlist. */
export const MAX_ALLOWLIST_ADDITIONS = 64

/** Longest allowlist entry, in characters. */
export const MAX_HOST_LENGTH = 253

/** The egress proxy's port inside the workspace network. */
export const EGRESS_PROXY_PORT = 3128

/**
 * The egress proxy's entry in the S2 workspace image, which the image provides, and the variables the supervisor sets
 * on the proxy's container: the egress mode (`allowlist` or `open`) and the allowed hosts, comma-separated.
 */
export const EGRESS_PROXY_ENTRY = {
  /** The proxy's argv. */
  command: ['/usr/local/bin/delorun-egress-proxy'],
  /** The variable holding the egress mode. */
  modeVariable: 'DELORUN_EGRESS_MODE',
  /** The variable holding the allowed hosts, comma-separated. */
  hostsVariable: 'DELORUN_EGRESS_HOSTS',
} as const

/** Destination ranges the egress proxy refuses in every mode, besides the machine's own addresses. */
export const EGRESS_REFUSED_RANGES = [
  '127.0.0.0/8',
  '::1/128',
  '169.254.0.0/16',
  'fe80::/10',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  'fc00::/7',
  '100.64.0.0/10',
  '224.0.0.0/4',
  'ff00::/8',
] as const

/** A credential forwarding option; absent means no forwarding. */
export type CredentialOption = 'deploy-key' | 'agent-confirm' | 'token'

/** A workspace request before resolution. */
export interface WorkspaceRuntimeRequest {
  /** The workspace. */
  readonly workspaceId: WorkspaceId
  /** The workspace root on the machine. */
  readonly root: string
  /** Where its commands run. */
  readonly kind: RuntimeKind
  /** The preset; resolves to {@link DEFAULT_PRESET} when omitted. */
  readonly preset?: PresetName
  /** Limits for the Advanced preset. */
  readonly limits?: ResourceLimits
  /** The egress mode; resolves to {@link DEFAULT_EGRESS} when omitted. */
  readonly egress?: EgressMode
  /** Hosts added to the allowlist. */
  readonly allowlistAdditions?: readonly string[]
  /** Credential forwarding; resolves to none when omitted. */
  readonly credentials?: CredentialOption
}

/** A complete workspace specification after `resolve`. */
export interface WorkspaceRuntimeSpec {
  /** The workspace. */
  readonly workspaceId: WorkspaceId
  /** The workspace root, resolved by the supervisor for Docker kinds. */
  readonly root: string
  /** Where its commands run. */
  readonly kind: RuntimeKind
  /** The preset. */
  readonly preset: PresetName
  /** The limits in effect. */
  readonly limits: ResourceLimits
  /** The egress mode. */
  readonly egress: EgressMode
  /** Hosts added to the allowlist. */
  readonly allowlistAdditions: readonly string[]
  /** Credential forwarding, or `none`. */
  readonly credentials: CredentialOption | 'none'
}

/** The runtime state of one workspace. */
export interface WorkspaceRuntimeState {
  /** Its status. */
  readonly status: 'stopped' | 'starting' | 'running' | 'stopping' | 'failed'
  /** The error code of a `failed` status. */
  readonly reason?: SupervisorErrorCode
}

/** A limit entry of the capability report. */
export type DockerLimit =
  | 'cpu'
  | 'memory'
  | 'pids'
  | 'disk'
  | 'cap-drop'
  | 'no-new-privileges'
  | 'read-only-root'
  | 'seccomp'
  | 'user-namespace'
  | 'network-isolation'
  | 'host-gateway-block'
  | 'host-loopback-block'
  | 'egress-allowlist'

/**
 * Limits a shape requires to be offered: the container carries each of them, and one the machine cannot show refuses it.
 * `host-gateway-block` is among them: a network the machine leaves its gateway reachable on gives the workspace the
 * machine's own services, and no other limit of the container stands in for that.
 */
export const REQUIRED_LIMITS: readonly DockerLimit[] = ['cap-drop', 'no-new-privileges', 'seccomp', 'read-only-root', 'network-isolation', 'host-gateway-block', 'cpu', 'memory', 'pids']

/** One inspected limit. */
export interface LimitFinding {
  /** Whether inspection showed it. */
  readonly status: 'enforced' | 'not-enforced' | 'unknown'
  /** The inspected field and its value. */
  readonly evidence: string
}

/** Why a shape is not available. */
export type ShapeReason = 'docker-unavailable' | 'docker-endpoint-network' | 's2-transport-unsupported' | 'image-unverified' | 'limits-missing'

/** The availability of one shape. */
export interface ShapeAvailability {
  /** Whether the shape is offered. */
  readonly available: boolean
  /** Present when it is not. */
  readonly reason?: ShapeReason
  /** Whether file watching works for this shape on this engine. */
  readonly fileWatching: 'supported' | 'unsupported'
}

/** The Docker part of the capability report, built by inspection. */
export interface DockerCapabilities {
  /** The engine kind. */
  readonly engine: 'docker-engine' | 'docker-desktop' | 'other'
  /** The engine version. */
  readonly version: string
  /** Whether the engine is rootless. */
  readonly rootless: boolean
  /** The active context's name. */
  readonly context: string
  /** The active context's endpoint. */
  readonly endpoint: { readonly kind: 'unix' | 'npipe' | 'tcp' | 'ssh', readonly path?: string }
  /** The storage driver. */
  readonly storageDriver: string
  /** One finding per limit. */
  readonly limits: Readonly<Record<DockerLimit, LimitFinding>>
}

/** The capability report. */
export interface CapabilityReport {
  /** Report version. */
  readonly v: typeof SUPERVISOR_PROTOCOL_VERSION
  /** RFC 3339 UTC time of the inspection. */
  readonly checkedAt: string
  /** The machine. */
  readonly machine: { readonly os: 'linux' | 'darwin' | 'win32', readonly arch: 'x64' | 'arm64' }
  /** C1's rule states for native workspaces. */
  readonly confinement: ConfinementReport
  /** Absent when no Docker engine answers. */
  readonly docker?: DockerCapabilities
  /** Availability per shape. */
  readonly shapes: Readonly<Record<DockerShape, ShapeAvailability>>
}

/**
 * The runtime provider's operations, which the `delorunRuntime` Service
 * Definition declares. Docker kinds perform every Docker operation through the
 * supervisor.
 */
export interface RuntimeProvider {
  /** The kind this provider runs. */
  readonly kind: RuntimeKind
  /**
   * Report what this machine runs and enforces.
   * @returns the capability report.
   */
  report(): Promise<CapabilityReport>
  /**
   * Fill a request's defaults explicitly and check it against the report.
   * @param request - the workspace request.
   * @returns the complete specification.
   */
  resolve(request: WorkspaceRuntimeRequest): WorkspaceRuntimeSpec
  /**
   * Start a workspace's runtime.
   * @param spec - a specification `resolve` returned.
   * @returns the state after starting.
   */
  start(spec: WorkspaceRuntimeSpec): Promise<WorkspaceRuntimeState>
  /**
   * Stop a workspace's runtime.
   * @param workspaceId - the workspace.
   * @param mode - `graceful` waits up to {@link GRACEFUL_STOP_MS} before it kills.
   * @returns when the runtime has stopped.
   */
  stop(workspaceId: WorkspaceId, mode: 'graceful' | 'kill'): Promise<void>
  /**
   * Read a workspace's runtime state.
   * @param workspaceId - the workspace.
   * @returns its state.
   */
  state(workspaceId: WorkspaceId): WorkspaceRuntimeState
}

/** Largest supervisor request line, in bytes. */
export const SUPERVISOR_REQUEST_MAX_BYTES = 65_536

/** Time from connect to the request line, in milliseconds. */
export const SUPERVISOR_REQUEST_DEADLINE_MS = 5_000

/** Open supervisor connections. */
export const SUPERVISOR_MAX_CONNECTIONS = 32

/** Longest workspace id, in characters. */
export const WORKSPACE_ID_MAX_LENGTH = 128

/** Longest workspace root, in bytes. */
export const ROOT_MAX_BYTES = 4_096

/** Wait of a `graceful` stop before it kills, in milliseconds. */
export const GRACEFUL_STOP_MS = 10_000

/** Fields every supervisor request carries. */
interface SupervisorRequestBase {
  /** The protocol version. */
  readonly v: typeof SUPERVISOR_PROTOCOL_VERSION
  /** The current start's token. */
  readonly token: StartToken
}

/** Arguments naming one workspace. */
interface WorkspaceArgs {
  /** The workspace. */
  readonly workspaceId: WorkspaceId
}

/**
 * Every request the supervisor accepts. No field names an image, a Docker
 * flag, a mount, an environment variable, a command, a device, a capability or
 * a network.
 */
export type SupervisorRequest = SupervisorRequestBase & (
  | { readonly op: 'capabilities', readonly args: { readonly refresh: boolean } }
  | {
    readonly op: 'workspace.create'
    readonly args: WorkspaceArgs & {
      readonly root: string
      readonly preset: PresetName
      readonly limits?: ResourceLimits
      readonly egress: EgressMode
      readonly allowlistAdditions: readonly string[]
      readonly credentials: CredentialOption | 'none'
    }
  }
  | { readonly op: 'workspace.start', readonly args: WorkspaceArgs }
  | { readonly op: 'workspace.stop', readonly args: WorkspaceArgs & { readonly mode: 'graceful' | 'kill' } }
  | { readonly op: 'workspace.remove', readonly args: WorkspaceArgs }
  | { readonly op: 'workspace.inspect', readonly args: WorkspaceArgs }
  | { readonly op: 'workspace.list' }
  | { readonly op: 'workspace.egress', readonly args: WorkspaceArgs & { readonly egress: EgressMode, readonly allowlistAdditions: readonly string[] } }
  | { readonly op: 'helper.start', readonly args: WorkspaceArgs }
  | { readonly op: 's3.create' }
  | { readonly op: 's3.start' }
  | { readonly op: 's3.stop', readonly args: { readonly mode: 'graceful' | 'kill' } }
  | { readonly op: 's3.inspect' }
)

/** Error codes of this contract. */
export type SupervisorErrorCode =
  | 'UNAUTHENTICATED'
  | 'SCHEMA_VIOLATION'
  | 'REQUEST_TIMEOUT'
  | 'BUSY'
  | 'ROOT_REFUSED'
  | 'ROOT_NOT_UNDER_PARENT'
  | 'IMAGE_NOT_IN_MANIFEST'
  | 'IMAGE_PULL_FAILED'
  | 'DOCKER_UNAVAILABLE'
  | 'ENGINE_REFUSED'
  | 'WORKSPACE_EXISTS'
  | 'LIMITS_MISSING'
  | 'PRESET_OUT_OF_RANGE'
  | 'ADDITIONAL_ROOTS_UNSUPPORTED'
  | 'SHAPE_UNAVAILABLE'
  | 'NOT_FOUND'

/** A failed supervisor response line. */
export interface SupervisorFailure {
  /** Always false. */
  readonly ok: false
  /** The error code. */
  readonly error: SupervisorErrorCode
  /** The refused value, never a secret. */
  readonly detail?: string
}

/** Contents of `supervisor/roots.json`. */
export interface SupervisorRoots {
  /** Record version. */
  readonly v: 1
  /** Canonical absolute parent directories. */
  readonly parents: readonly string[]
}

/** Most parent directories in the roots file. */
export const MAX_ROOT_PARENTS = 16

/** Bytes of the S2 helper's channel key and of its challenge. */
export const HELPER_KEY_BYTES = 32

/** The string the helper challenge's HMAC-SHA-256 covers after the challenge. */
export const HELPER_CHALLENGE_LABEL = 'delorun-helper-v1'

/** Time the helper waits for a challenge answer, in milliseconds. */
export const HELPER_CHALLENGE_TIMEOUT_MS = 5_000

/**
 * Mount point of the S2 helper's directory inside the container. It is mounted read-only, so nothing the workspace runs
 * can add to it, rename anything in it or replace it.
 */
export const HELPER_SOCKET_DIR = '/run/delorun-helper'

/** The one writable part of {@link HELPER_SOCKET_DIR}: the subdirectory the helper creates its sockets in. */
export const HELPER_CHANNEL_DIR = `${HELPER_SOCKET_DIR}/channel`

/** The name of {@link HELPER_CHANNEL_DIR} inside the helper's directory on the machine, which is mounted there. */
export const HELPER_CHANNEL_NAME = 'channel'

/** Mount point of a forwarded agent's socket inside the container. */
export const AGENT_SOCKET_PATH = '/run/delorun-agent/agent.sock'

/** Container user ids of the S3 shape. */
export const S3_USERS = {
  /** The harness and the home process. */
  harness: { name: 'delorun-harness', uid: 1_001 },
  /** Workspace commands. */
  workspace: { name: 'delorun', uid: 1_000 },
} as const

/** The images and where they are pulled from, by digest only. */
export const IMAGES = {
  /** The S2 workspace image. */
  s2: 'ghcr.io/twickas/delorun-workspace-s2',
  /** The S3 harness image. */
  s3: 'ghcr.io/twickas/delorun-harness-s3',
} as const

/** The base image both images are built from, pinned by digest in each build recipe. */
export const IMAGE_BASE = 'docker.io/library/debian:bookworm-slim'

/** The only hosts an image pull reaches. */
export const IMAGE_PULL_HOSTS = ['ghcr.io', 'pkg-containers.githubusercontent.com'] as const

/** Labels on every container and network the supervisor manages. */
export const LABELS = {
  /** C1's `homeId`. */
  home: 'run.delo.home',
  /** The CLI profile. */
  profile: 'run.delo.profile',
  /** The workspace id. */
  workspace: 'run.delo.workspace',
  /** The shape. */
  shape: 'run.delo.shape',
} as const

/** Hexadecimal digits of the workspace id's SHA-256 digest in container and network names. */
export const NAME_HASH_HEX_DIGITS = 12

/** The environment's denial signatures a Docker shape's sandbox wrap declares. */
export const ENVIRONMENT_DENIAL_SIGNATURES = ['read-only file system'] as const

/** The exact model-facing line of an environment denial; no escalation hint follows it. */
export const ENVIRONMENT_DENIAL_MARKER = '[sandbox: file access denied by the environment the sandbox runs in; no sandbox mode allows it]'
