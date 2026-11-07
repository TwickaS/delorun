/**
 * The `workspace.*` operations of the supervisor API (contract C9, "The supervisor API"): an S2 workspace's
 * container, its internal network, its egress proxy and the proxy's way out, each created from the S2 image's
 * listed digest under the owner's labels and checked against its inspect record before it may start. Every value
 * that reaches the engine is derived from the contract, the setup-time roots and the verified manifest; the request
 * supplies only the workspace id, the root to resolve, the preset, the egress mode and its additions.
 *
 * @module @delo/supervisor/workspaces
 */
import { mkdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ADVANCED_BOUNDS,
  DEFAULT_EGRESS_HOSTS,
  EGRESS_PROXY_ENTRY,
  HELPER_SOCKET_DIR,
  LABELS,
  PRESETS,
  type CredentialOption,
  type EgressMode,
  type PresetName,
  type ResourceLimits,
  type SupervisorRequest,
  type WorkspaceId,
} from '@delo/contract-runtime-supervisor'
import { PRIVATE_DIR_MODE } from '@delo/contract-home-layout'
import { checkPrivateDirectory, runDirectory } from '@delo/home'
import type { EngineMachine, Inspection } from './capabilities.ts'
import {
  createBody,
  hardeningDifferences,
  labelsOf,
  networkBody,
  workspaceBinds,
  workspaceEnv,
  workspaceHash,
  workspaceNames,
  workspaceUser,
  type CreateBody,
  type InspectRecord,
  type Owner,
} from './container.ts'
import { EngineError, isNotFound, type Engine } from './docker/engine.ts'
import { SupervisorError } from './errors.ts'
import { ensureListedImage, type ImagePull } from './images.ts'
import { listedImage, type VerifiedManifest } from './manifest.ts'
import { recheckMountedRoot, resolveWorkspaceRoot, type RootRules } from './roots.ts'
import { loadSeccompProfile } from './seccomp.ts'

/** What the workspace operations need. */
export interface WorkspaceContext {
  /** The engine of the active context, or `undefined` when there is none. */
  readonly engine: Engine | undefined
  /** The home and profile whose labels every object carries. */
  readonly owner: Owner
  /** The setup-time roots. */
  readonly rules: RootRules
  /** The verified manifest. */
  readonly manifest: VerifiedManifest
  /** Whether absent images are pulled. */
  readonly pull: ImagePull
  /** The latest capability inspection. */
  readonly inspection: () => Inspection
  /** The directory holding the seccomp profile files the manifest lists. */
  readonly seccompDirectory: string
}

/** A workspace as `workspace.inspect` and `workspace.list` report it. */
export interface WorkspaceView {
  /** The workspace. */
  readonly workspaceId: WorkspaceId
  /** The container's name. */
  readonly container: string
  /** The container's engine state, such as `created`, `running` or `exited`. */
  readonly state: string
  /** The limits in effect, from the container's inspect record. */
  readonly limits: ResourceLimits
  /** The egress mode the proxy runs with; `none` when no proxy exists. */
  readonly egress: EgressMode
  /** The hosts the proxy allows, under `allowlist`. */
  readonly allowlist: readonly string[]
}

/**
 * The limits of a preset on this machine.
 * @param preset - the preset.
 * @param advanced - the Advanced preset's values, given exactly when the preset is `advanced`.
 * @param machine - the engine's machine.
 * @returns the limits.
 * @throws {SupervisorError} `PRESET_OUT_OF_RANGE` naming the first value outside its bound, or a preset whose CPU or
 *   memory exceeds the machine.
 */
export function presetLimits(preset: PresetName, advanced: ResourceLimits | undefined, machine: EngineMachine): ResourceLimits {
  if (preset !== 'advanced') {
    const limits = PRESETS[preset]
    if (limits.cpus > machine.cpus || limits.memoryBytes > machine.memoryBytes) throw new SupervisorError('PRESET_OUT_OF_RANGE', `the ${preset} preset exceeds this machine (${String(machine.cpus)} CPUs, ${String(machine.memoryBytes)} bytes of memory)`)
    return limits
  }
  if (advanced === undefined) throw new SupervisorError('PRESET_OUT_OF_RANGE', 'the advanced preset needs its limits')
  const bounds: readonly (readonly [keyof ResourceLimits, number, number])[] = [
    ['cpus', ADVANCED_BOUNDS.minCpus, machine.cpus],
    ['memoryBytes', ADVANCED_BOUNDS.minMemoryBytes, machine.memoryBytes - ADVANCED_BOUNDS.reservedMemoryBytes],
    ['diskBytes', ADVANCED_BOUNDS.minDiskBytes, ADVANCED_BOUNDS.maxDiskBytes],
    ['pids', ADVANCED_BOUNDS.minPids, ADVANCED_BOUNDS.maxPids],
    ['tmpBytes', ADVANCED_BOUNDS.minTmpBytes, Math.floor(advanced.memoryBytes / 2)],
  ]
  for (const [field, low, high] of bounds) {
    const value = advanced[field]
    if (value < low || value > high) throw new SupervisorError('PRESET_OUT_OF_RANGE', `limits.${field} ${String(value)} is outside ${String(low)}..${String(high)}`)
  }
  return advanced
}

/**
 * The hosts the proxy allows under a mode.
 * @param egress - the mode.
 * @param additions - the workspace's additions.
 * @returns the hosts; empty under `open` and `none`.
 */
export function allowedHosts(egress: EgressMode, additions: readonly string[]): string[] {
  return egress === 'allowlist' ? [...new Set([...DEFAULT_EGRESS_HOSTS, ...additions])] : []
}

/**
 * The limits a container runs with, from its inspect record.
 * @param record - the container's inspect record.
 * @returns the limits.
 */
function limitsOf(record: InspectRecord): ResourceLimits {
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
 * The egress mode and hosts a proxy container runs with, from its environment.
 * @param proxy - the proxy's inspect record.
 * @returns the mode, `none` when the record names neither `allowlist` nor `open`, and the hosts.
 */
function egressOfRecord(proxy: InspectRecord): { readonly egress: EgressMode, readonly allowlist: readonly string[] } {
  const env = proxy.Config?.Env ?? []
  const value = (name: string): string => env.find(entry => entry.startsWith(`${name}=`))?.slice(name.length + 1) ?? ''
  const mode = value(EGRESS_PROXY_ENTRY.modeVariable)
  const hosts = value(EGRESS_PROXY_ENTRY.hostsVariable)
  return { egress: mode === 'open' || mode === 'allowlist' ? mode : 'none', allowlist: hosts === '' ? [] : hosts.split(',') }
}

/**
 * Refuse a container whose inspect record differs from the body it must match.
 * @param name - the container's name.
 * @param record - its inspect record.
 * @param body - the body.
 * @throws {SupervisorError} `ROOT_REFUSED` for a mount that differs, `LIMITS_MISSING` for any other setting.
 */
function requireMatch(name: string, record: InspectRecord, body: CreateBody): void {
  const { mounts, settings } = hardeningDifferences(record, body)
  if (mounts.length > 0) throw new SupervisorError('ROOT_REFUSED', `${name}'s mounts differ from the resolved paths: ${mounts.join(', ')}`)
  if (settings.length > 0) throw new SupervisorError('LIMITS_MISSING', `${name} does not carry ${settings.join(', ')}`)
}

/**
 * The engine's failure as a supervisor refusal: an engine that does not answer is `DOCKER_UNAVAILABLE`, and a call it
 * refused is `ENGINE_REFUSED`, with the engine's message as the detail.
 * @param error - the thrown value.
 * @returns the refusal, or the value itself when it is not an engine failure.
 */
export function engineRefusal(error: unknown): unknown {
  if (!(error instanceof EngineError)) return error
  return new SupervisorError(error.status === 0 ? 'DOCKER_UNAVAILABLE' : 'ENGINE_REFUSED', error.message)
}

/** The `workspace.*` operations over one engine. */
export class Workspaces {
  /** @param context - the engine, owner, roots, manifest and inspection. */
  constructor(private readonly context: WorkspaceContext) {}

  /**
   * Run one workspace operation.
   * @param request - an authenticated request whose `op` starts with `workspace.`.
   * @returns the response line's fields after `ok`.
   * @throws {SupervisorError} with C9's code.
   */
  async handle(request: Extract<SupervisorRequest, { readonly op: `workspace.${string}` }>): Promise<Record<string, unknown>> {
    try {
      switch (request.op) {
        case 'workspace.create': return { workspace: await this.create(request.args) }
        case 'workspace.start': return { workspace: await this.start(request.args.workspaceId) }
        case 'workspace.stop': return { workspace: await this.stop(request.args.workspaceId, request.args.mode) }
        case 'workspace.remove': await this.remove(request.args.workspaceId); return {}
        case 'workspace.inspect': return { workspace: await this.inspect(request.args.workspaceId) }
        case 'workspace.list': return { workspaces: await this.list() }
        case 'workspace.egress': return { workspace: await this.egress(request.args.workspaceId, request.args.egress, request.args.allowlistAdditions) }
        default: {
          const unknown: never = request
          throw new SupervisorError('SCHEMA_VIOLATION', `unknown op ${String((unknown as { readonly op: unknown }).op)}`)
        }
      }
    } catch (error) {
      throw engineRefusal(error)
    }
  }

  private get engine(): Engine {
    if (this.context.engine === undefined) throw new SupervisorError('DOCKER_UNAVAILABLE', this.context.inspection().shapes.s2.reason ?? 'no Docker engine')
    return this.context.engine
  }

  private machineOrRefuse(): EngineMachine {
    const inspection = this.context.inspection()
    if (inspection.docker === undefined || inspection.machine === undefined) throw new SupervisorError('DOCKER_UNAVAILABLE', inspection.shapes.s2.reason)
    return inspection.machine
  }

  private requireS2(): void {
    const s2 = this.context.inspection().shapes.s2
    if (s2.available) return
    if (s2.reason === 'limits-missing') throw new SupervisorError('LIMITS_MISSING', 'a limit S2 requires is not enforced on this machine')
    throw new SupervisorError('SHAPE_UNAVAILABLE', `s2: ${s2.reason ?? 'unavailable'}`)
  }

  /**
   * The S2 image's reference, present in the engine, and its listed seccomp profile.
   * @returns the reference and the profile's text, if the manifest lists one.
   */
  private async s2Image(): Promise<{ readonly image: string, readonly seccomp?: string }> {
    const listed = listedImage(this.context.manifest, 's2', this.context.inspection().platform)
    const seccomp = listed.seccomp === undefined ? undefined : await loadSeccompProfile(this.context.seccompDirectory, listed.seccomp)
    const image = await ensureListedImage(this.engine, listed, this.context.pull)
    return seccomp === undefined ? { image } : { image, seccomp }
  }

  private helperDirectory(workspaceId: WorkspaceId): string {
    return join(runDirectory(this.context.rules.deloHome, this.context.owner.profile), 's2', workspaceHash(workspaceId))
  }

  /**
   * The canonical roots of the workspaces this supervisor manages, other than one: the source of each workspace
   * container's root mount, which lies at the same path inside the container.
   * @param except - the workspace whose root is left out, if any.
   * @returns the roots.
   */
  private async otherRoots(except: WorkspaceId | undefined): Promise<string[]> {
    const { owner } = this.context
    // Every Delo container on the engine, of any home and any profile: a root may not nest with any of them.
    const filters = JSON.stringify({ label: [LABELS.home] })
    const rows = await this.engine.call('GET', `/containers/json?all=true&filters=${encodeURIComponent(filters)}`) as readonly {
      readonly Labels?: Readonly<Record<string, string>>
      readonly Mounts?: readonly { readonly Type?: string, readonly Source?: string, readonly Destination?: string }[]
    }[]
    return rows
      .filter(row => !(row.Labels?.[LABELS.home] === owner.homeId && row.Labels[LABELS.profile] === owner.profile && row.Labels[LABELS.workspace] === except))
      .flatMap(row => (row.Mounts ?? []).filter(mount => mount.Type === 'bind' && mount.Source !== undefined && mount.Source === mount.Destination).map(mount => mount.Source ?? ''))
  }

  /**
   * The body a workspace's container must match: the one `workspace.create` builds from the contract, the root and
   * the limits the container was created with.
   * @param workspaceId - the workspace.
   * @param root - its canonical root.
   * @param limits - its limits.
   * @param diskQuota - whether the disk size is set.
   * @param image - the S2 image's reference and listed seccomp profile.
   * @returns the body.
   */
  private workspaceBody(workspaceId: WorkspaceId, root: string, limits: ResourceLimits, diskQuota: boolean, image: { readonly image: string, readonly seccomp?: string }): CreateBody {
    const names = workspaceNames(workspaceId)
    return createBody({
      name: names.container, image: image.image, labels: labelsOf(this.context.owner, workspaceId), user: workspaceUser(this.context.inspection().docker?.rootless ?? false),
      limits, diskQuota, networks: [names.network], binds: workspaceBinds(root, this.helperDirectory(workspaceId)), env: workspaceEnv(names.proxy), workingDir: root,
      ...image.seccomp === undefined ? {} : { seccomp: image.seccomp },
    })
  }

  /**
   * The body a workspace's egress proxy must match.
   * @param workspaceId - the workspace.
   * @param egress - the proxy's mode.
   * @param hosts - the hosts it allows.
   * @param limits - the workspace's limits.
   * @param diskQuota - whether the disk size is set.
   * @param image - the S2 image's reference and listed seccomp profile.
   * @returns the body.
   */
  private proxyBody(workspaceId: WorkspaceId, egress: Exclude<EgressMode, 'none'>, hosts: readonly string[], limits: ResourceLimits, diskQuota: boolean, image: { readonly image: string, readonly seccomp?: string }): CreateBody {
    const names = workspaceNames(workspaceId)
    return createBody({
      name: names.proxy, image: image.image, labels: labelsOf(this.context.owner, workspaceId), user: workspaceUser(this.context.inspection().docker?.rootless ?? false),
      limits, diskQuota, networks: [names.outNetwork], binds: [], command: [...EGRESS_PROXY_ENTRY.command],
      env: [`${EGRESS_PROXY_ENTRY.modeVariable}=${egress}`, `${EGRESS_PROXY_ENTRY.hostsVariable}=${hosts.join(',')}`],
      ...image.seccomp === undefined ? {} : { seccomp: image.seccomp },
    })
  }

  private async create(args: {
    readonly workspaceId: WorkspaceId
    readonly root: string
    readonly preset: PresetName
    readonly limits?: ResourceLimits
    readonly egress: EgressMode
    readonly allowlistAdditions: readonly string[]
    readonly credentials: CredentialOption | 'none'
  }): Promise<WorkspaceView> {
    const engine = this.engine
    this.requireS2()
    if (args.credentials !== 'none') throw new SupervisorError('SHAPE_UNAVAILABLE', `credential forwarding (${args.credentials}) is not provided by this supervisor`)
    const root = await resolveWorkspaceRoot(args.root, this.context.rules, await this.otherRoots(args.workspaceId))
    const limits = presetLimits(args.preset, args.limits, this.machineOrRefuse())
    const names = workspaceNames(args.workspaceId)
    try {
      if (await this.find(names.container) !== undefined) throw new SupervisorError('WORKSPACE_EXISTS', `${names.container} already exists`)
    } catch (error) {
      if (error instanceof SupervisorError && error.code === 'NOT_FOUND') throw new SupervisorError('WORKSPACE_EXISTS', `${names.container} already exists and is not this supervisor's`)
      throw error
    }
    const image = await this.s2Image()
    const diskQuota = this.context.inspection().docker?.limits.disk.status === 'enforced'
    const helperDir = this.helperDirectory(args.workspaceId)
    await mkdir(helperDir, { recursive: true, mode: PRIVATE_DIR_MODE })
    await checkPrivateDirectory(helperDir)
    const created: string[] = []
    const networks: string[] = []
    try {
      await engine.call('POST', '/networks/create', networkBody(names.network, true, labelsOf(this.context.owner, args.workspaceId)))
      networks.push(names.network)
      await this.createChecked(names.container, this.workspaceBody(args.workspaceId, root, limits, diskQuota, image), created)
      if (args.egress !== 'none') await this.createProxy(args.workspaceId, args.egress, args.allowlistAdditions, limits, diskQuota, created, networks)
    } catch (error) {
      await this.removeObjects(created, networks)
      await rm(helperDir, { recursive: true, force: true })
      throw error
    }
    return this.inspect(args.workspaceId)
  }

  /**
   * Create one container, then compare its inspect record with its body; a container the engine changed is removed.
   * @param name - the container's name.
   * @param body - the create body.
   * @param created - receives the name once the container exists, for the caller's cleanup.
   */
  private async createChecked(name: string, body: CreateBody, created: string[]): Promise<void> {
    try {
      await this.engine.call('POST', `/containers/create?name=${encodeURIComponent(name)}`, body)
    } catch (error) {
      if (error instanceof EngineError && error.status === 409) throw new SupervisorError('WORKSPACE_EXISTS', `${name} already exists`)
      throw error
    }
    created.push(name)
    requireMatch(name, await this.engine.call('GET', `/containers/${encodeURIComponent(name)}/json`) as InspectRecord, body)
  }

  private async createProxy(workspaceId: WorkspaceId, egress: Exclude<EgressMode, 'none'>, additions: readonly string[], limits: ResourceLimits, diskQuota: boolean, created: string[], networks: string[]): Promise<void> {
    const engine = this.engine
    const names = workspaceNames(workspaceId)
    const image = await this.s2Image()
    if (!networks.includes(names.outNetwork)) {
      try {
        await engine.call('POST', '/networks/create', networkBody(names.outNetwork, false, labelsOf(this.context.owner, workspaceId)))
      } catch (error) {
        // The way-out network survives a change of egress mode; any other refusal is the caller's.
        if (!(error instanceof EngineError) || error.status !== 409) throw error
      }
      networks.push(names.outNetwork)
    }
    await this.createChecked(names.proxy, this.proxyBody(workspaceId, egress, allowedHosts(egress, additions), limits, diskQuota, image), created)
    await engine.call('POST', `/networks/${encodeURIComponent(names.network)}/connect`, { Container: names.proxy })
  }

  private async removeObjects(containers: readonly string[], networks: readonly string[]): Promise<void> {
    for (const name of containers) await this.removeIfPresent(`/containers/${encodeURIComponent(name)}?force=true&v=true`)
    for (const name of networks) await this.removeIfPresent(`/networks/${encodeURIComponent(name)}`)
  }

  private async removeIfPresent(path: string): Promise<void> {
    try {
      await this.engine.call('DELETE', path)
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
  }

  /**
   * The inspect record of a container this supervisor manages, or `undefined` when no container has the name.
   * @param name - the container's name.
   * @param workspaceId - the workspace it must belong to, when known.
   * @returns the record.
   * @throws {SupervisorError} `NOT_FOUND` when a container has the name but not this home's and profile's labels.
   */
  private async find(name: string, workspaceId?: WorkspaceId): Promise<InspectRecord | undefined> {
    let record: InspectRecord
    try {
      record = await this.engine.call('GET', `/containers/${encodeURIComponent(name)}/json`) as InspectRecord
    } catch (error) {
      if (isNotFound(error)) return undefined
      throw error
    }
    const labels = record.Config?.Labels ?? {}
    const owner = this.context.owner
    if (labels[LABELS.home] !== owner.homeId || labels[LABELS.profile] !== owner.profile || (workspaceId !== undefined && labels[LABELS.workspace] !== workspaceId)) {
      throw new SupervisorError('NOT_FOUND', `${name} is not a container this supervisor manages`)
    }
    return record
  }

  private async owned(workspaceId: WorkspaceId): Promise<InspectRecord> {
    const record = await this.find(workspaceNames(workspaceId).container, workspaceId)
    if (record === undefined) throw new SupervisorError('NOT_FOUND', `no workspace container for ${workspaceId}`)
    return record
  }

  /**
   * Check a workspace's containers before they start: the owner labels, the root mount's source, which must still
   * resolve to itself and pass every root rule, the helper directory, and every setting `workspace.create` asked for.
   * @param workspaceId - the workspace.
   * @throws {SupervisorError} `NOT_FOUND`, `ROOT_REFUSED`, `LIMITS_MISSING` or an image refusal.
   */
  private async verifyBeforeStart(workspaceId: WorkspaceId): Promise<void> {
    const record = await this.owned(workspaceId)
    const names = workspaceNames(workspaceId)
    const helperDir = this.helperDirectory(workspaceId)
    const binds = (record.Mounts ?? []).filter(mount => mount.Type === 'bind')
    const rootMount = binds.find(mount => mount.Destination !== HELPER_SOCKET_DIR)
    const root = rootMount?.Source
    if (root === undefined || rootMount?.Destination !== root) throw new SupervisorError('ROOT_REFUSED', `${names.container} has no root mount at its own path`)
    await recheckMountedRoot(root, this.context.rules, await this.otherRoots(workspaceId))
    if (await realpath(helperDir) !== helperDir) throw new SupervisorError('ROOT_REFUSED', `${helperDir} does not resolve to itself`)
    await checkPrivateDirectory(helperDir)
    const image = await this.s2Image()
    const limits = limitsOf(record)
    const diskQuota = record.HostConfig?.StorageOpt?.size !== undefined
    requireMatch(names.container, record, this.workspaceBody(workspaceId, root, limits, diskQuota, image))
    const proxy = await this.find(names.proxy, workspaceId)
    if (proxy === undefined) return
    const { egress, allowlist } = egressOfRecord(proxy)
    if (egress === 'none') throw new SupervisorError('LIMITS_MISSING', `${names.proxy} has no egress mode`)
    requireMatch(names.proxy, proxy, this.proxyBody(workspaceId, egress, allowlist, limits, diskQuota, image))
  }

  private async start(workspaceId: WorkspaceId): Promise<WorkspaceView> {
    await this.verifyBeforeStart(workspaceId)
    const names = workspaceNames(workspaceId)
    if (await this.find(names.proxy, workspaceId) !== undefined) await this.engine.call('POST', `/containers/${encodeURIComponent(names.proxy)}/start`)
    await this.engine.call('POST', `/containers/${encodeURIComponent(names.container)}/start`)
    return this.inspect(workspaceId)
  }

  private async stop(workspaceId: WorkspaceId, mode: 'graceful' | 'kill'): Promise<WorkspaceView> {
    await this.owned(workspaceId)
    const names = workspaceNames(workspaceId)
    const proxy = await this.find(names.proxy, workspaceId)
    for (const name of proxy === undefined ? [names.container] : [names.container, names.proxy]) {
      try {
        await this.engine.call('POST', mode === 'graceful' ? `/containers/${encodeURIComponent(name)}/stop?t=10` : `/containers/${encodeURIComponent(name)}/kill`)
      } catch (error) {
        // Killing a container that is not running is a stopped container.
        if (!(error instanceof EngineError) || error.status !== 409) throw error
      }
    }
    return this.inspect(workspaceId)
  }

  private async remove(workspaceId: WorkspaceId): Promise<void> {
    await this.owned(workspaceId)
    const names = workspaceNames(workspaceId)
    await this.find(names.proxy, workspaceId)
    await this.removeObjects([names.container, names.proxy], [names.network, names.outNetwork])
    await rm(this.helperDirectory(workspaceId), { recursive: true, force: true })
  }

  private async egressOf(workspaceId: WorkspaceId): Promise<{ readonly egress: EgressMode, readonly allowlist: readonly string[] }> {
    const proxy = await this.find(workspaceNames(workspaceId).proxy, workspaceId)
    return proxy === undefined ? { egress: 'none', allowlist: [] } : egressOfRecord(proxy)
  }

  private async inspect(workspaceId: WorkspaceId): Promise<WorkspaceView> {
    const record = await this.owned(workspaceId)
    return {
      workspaceId,
      container: workspaceNames(workspaceId).container,
      state: record.State?.Status ?? 'unknown',
      limits: limitsOf(record),
      ...await this.egressOf(workspaceId),
    }
  }

  private async list(): Promise<WorkspaceView[]> {
    const { owner } = this.context
    const filters = JSON.stringify({ label: [`${LABELS.home}=${owner.homeId}`, `${LABELS.profile}=${owner.profile}`, `${LABELS.shape}=s2`] })
    const rows = await this.engine.call('GET', `/containers/json?all=true&filters=${encodeURIComponent(filters)}`) as readonly { readonly Names?: readonly string[], readonly Labels?: Readonly<Record<string, string>> }[]
    const views: WorkspaceView[] = []
    for (const row of rows) {
      const id = row.Labels?.[LABELS.workspace]
      if (id === undefined) continue
      const workspaceId = id as WorkspaceId
      if (!(row.Names ?? []).includes(`/${workspaceNames(workspaceId).container}`)) continue
      views.push(await this.inspect(workspaceId))
    }
    return views
  }

  private async egress(workspaceId: WorkspaceId, egress: EgressMode, additions: readonly string[]): Promise<WorkspaceView> {
    const record = await this.owned(workspaceId)
    const names = workspaceNames(workspaceId)
    await this.find(names.proxy, workspaceId)
    await this.removeIfPresent(`/containers/${encodeURIComponent(names.proxy)}?force=true&v=true`)
    if (egress !== 'none') {
      const created: string[] = []
      try {
        await this.createProxy(workspaceId, egress, additions, limitsOf(record), record.HostConfig?.StorageOpt?.size !== undefined, created, [])
        if (record.State?.Running === true) await this.engine.call('POST', `/containers/${encodeURIComponent(names.proxy)}/start`)
      } catch (error) {
        await this.removeObjects(created, [])
        throw error
      }
    }
    return this.inspect(workspaceId)
  }
}
