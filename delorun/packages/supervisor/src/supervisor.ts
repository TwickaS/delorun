/**
 * The Docker supervisor (contract C9, "The Docker supervisor"): it reads the setup-time roots, resolves the active
 * Docker context, builds the capability report by inspection and serves the fixed-schema API on
 * `run/<profile>/supervisor.sock`, accepting only the current home-process start's token. Operations on one
 * workspace run one at a time, and one inspection runs at a time.
 *
 * @module @delorun/supervisor/supervisor
 */
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { RUN_ENTRIES, type StartToken } from '@delorun/contract-home-layout'
import type { SupervisorRequest } from '@delorun/contract-runtime-supervisor'
import { checkPrivateDirectory, runDirectory, StartTokenCheck } from '@delorun/home'
import type { DelorunLogger } from '@delorun/logs'
import { inspectDocker, shapesOf, type Inspection } from './capabilities.ts'
import { homeIdOf, type Owner } from './container.ts'
import { resolveDockerContext, type DockerContext } from './docker/endpoint.ts'
import { engineAt, EngineError, type Engine } from './docker/engine.ts'
import { SupervisorError } from './errors.ts'
import type { ImagePull } from './images.ts'
import type { VerifiedManifest } from './manifest.ts'
import { loadRootRules } from './roots.ts'
import { listenSupervisor, type SupervisorListener } from './server.ts'
import { Workspaces } from './workspaces.ts'

/** How long the supervisor waits on the engine and on its callers, from the launch line's validated values. */
export interface SupervisorTiming {
  /** The longest one Engine API call may take, in milliseconds. */
  readonly engineCallMs: number
  /** The longest one image pull may take, in milliseconds. */
  readonly pullMs: number
  /** The time from connect to a request's first byte, in milliseconds. */
  readonly firstByteMs: number
  /** The shortest time between two records of refused authentications, in milliseconds. */
  readonly refusalLogIntervalMs: number
}

/** What a supervisor starts with; the home process supplies every value at launch. */
export interface SupervisorOptions {
  /** The resolved Delorun home. */
  readonly home: string
  /** The CLI profile. */
  readonly profile: string
  /** The current home-process start's token. */
  readonly token: StartToken
  /** The verified release manifest's image entries. */
  readonly manifest: VerifiedManifest
  /** Whether absent listed images are pulled from the registry. */
  readonly pull: ImagePull
  /** The supervisor's logger. */
  readonly logger: DelorunLogger
  /** The environment the Docker context is resolved from. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** The OS home directory, which no workspace root may be. */
  readonly osHome: string
  /** The directory holding the seccomp profile files the manifest lists. */
  readonly seccompDirectory: string
  /** The deadlines. */
  readonly timing: SupervisorTiming
}

/**
 * The socket path of a profile's supervisor.
 * @param home - the resolved Delorun home.
 * @param profile - the CLI profile.
 * @returns `<home>/run/<profile>/supervisor.sock`.
 */
export function supervisorSocketPath(home: string, profile: string): string {
  return join(runDirectory(home, profile), RUN_ENTRIES.supervisorSocket)
}

/** A running supervisor. */
export class Supervisor {
  private inspection: Inspection
  private inspecting: Promise<Inspection> | undefined
  private readonly queues = new Map<string, Promise<unknown>>()
  private listener: SupervisorListener | undefined

  private readonly options: SupervisorOptions
  private readonly home: string
  private readonly owner: Owner
  private readonly context: DockerContext | undefined
  private readonly engine: Engine | undefined
  private readonly workspaces: Workspaces

  private constructor(
    options: SupervisorOptions,
    home: string,
    owner: Owner,
    context: DockerContext | undefined,
    engine: Engine | undefined,
    workspaces: Workspaces,
  ) {
    this.options = options
    this.home = home
    this.owner = owner
    this.context = context
    this.engine = engine
    this.workspaces = workspaces
    this.inspection = { shapes: shapesOf(undefined, 'docker-unavailable', {}) }
  }

  /**
   * Start a supervisor: check the run directory, read the roots, inspect the engine and listen.
   * @param options - the launch values.
   * @returns the running supervisor.
   * @throws {HomeLayoutError} when the run directory, the roots file or the socket path breaks C1's rules.
   * @throws {Error} when the roots file is not C9's record.
   */
  static async start(options: SupervisorOptions): Promise<Supervisor> {
    // The canonical home names everything the supervisor derives from it: the run and helper directories, the
    // labels' homeId and the mount sources, so a home reached through a symbolic link behaves as the home itself.
    const home = await realpath(options.home)
    const runDir = runDirectory(home, options.profile)
    await checkPrivateDirectory(runDir)
    const rules = await loadRootRules(home, options.osHome)
    const owner: Owner = { homeId: homeIdOf(home), profile: options.profile }
    let context: DockerContext | undefined
    try {
      context = await resolveDockerContext(options.env)
    } catch (error) {
      options.logger.warn('no usable Docker context', { err: error })
    }
    const path = context?.endpoint.path
    const engine = path !== undefined && (context?.endpoint.kind === 'unix' || context?.endpoint.kind === 'npipe') ? engineAt(path, { callMs: options.timing.engineCallMs, pullMs: options.timing.pullMs }) : undefined
    let supervisor: Supervisor | undefined
    const workspaces = new Workspaces({ engine, owner, rules, manifest: options.manifest, pull: options.pull, seccompDirectory: options.seccompDirectory, inspection: () => supervisor?.inspection ?? { shapes: shapesOf(undefined, 'docker-unavailable', {}) } })
    supervisor = new Supervisor(options, home, owner, context, engine, workspaces)
    await supervisor.refresh()
    supervisor.listener = await listenSupervisor({
      socketPath: supervisorSocketPath(home, options.profile),
      check: new StartTokenCheck(options.token),
      handle: async request => supervisor.dispatch(request),
      logger: options.logger,
      firstByteMs: options.timing.firstByteMs,
      refusalLogIntervalMs: options.timing.refusalLogIntervalMs,
    })
    options.logger.info('supervisor listening', { data: { context: context?.name ?? 'none', s2: supervisor.inspection.shapes.s2.reason ?? 'available', s3: supervisor.inspection.shapes.s3.reason ?? 'available' } })
    return supervisor
  }

  /** The socket the supervisor listens on. */
  get socketPath(): string {
    return supervisorSocketPath(this.home, this.options.profile)
  }

  /** The latest inspection. */
  get current(): Inspection {
    return this.inspection
  }

  /**
   * Inspect the engine again; a call while one runs waits for that one.
   * @returns the new inspection.
   */
  async refresh(): Promise<Inspection> {
    if (this.inspecting !== undefined) return this.inspecting
    const run = async (): Promise<Inspection> => {
      if (this.context === undefined || this.engine === undefined) {
        return { shapes: shapesOf(undefined, this.context === undefined ? 'docker-unavailable' : 'docker-endpoint-network', {}) }
      }
      try {
        return await inspectDocker({ engine: this.engine, context: this.context, manifest: this.options.manifest, pull: this.options.pull, owner: this.owner, seccompDirectory: this.options.seccompDirectory })
      } catch (error) {
        if (!(error instanceof EngineError)) throw error
        this.options.logger.warn('the Docker engine failed during inspection', { err: error })
        return { shapes: shapesOf(undefined, 'docker-unavailable', {}) }
      }
    }
    this.inspecting = run()
    try {
      this.inspection = await this.inspecting
      return this.inspection
    } finally {
      this.inspecting = undefined
    }
  }

  /**
   * Run one authenticated request; operations on one workspace run in arrival order.
   * @param request - the request.
   * @returns the response line's fields after `ok`.
   * @throws {SupervisorError} with C9's code.
   */
  async dispatch(request: SupervisorRequest): Promise<Record<string, unknown>> {
    switch (request.op) {
      case 'capabilities': {
        const inspection = request.args.refresh ? await this.refresh() : this.inspection
        return { docker: inspection.docker ?? null, shapes: inspection.shapes }
      }
      case 'workspace.create':
      case 'workspace.start':
      case 'workspace.stop':
      case 'workspace.remove':
      case 'workspace.inspect':
      case 'workspace.egress':
        return this.queued(request.args.workspaceId, async () => this.workspaces.handle(request))
      case 'workspace.list':
        return this.workspaces.handle(request)
      case 'helper.start':
      case 's3.create':
      case 's3.start':
      case 's3.stop':
      case 's3.inspect':
        throw new SupervisorError('SHAPE_UNAVAILABLE', `${request.op} is not provided by this supervisor`)
      default: {
        const unknown: never = request
        throw new SupervisorError('SCHEMA_VIOLATION', `unknown op ${String((unknown as { readonly op: unknown }).op)}`)
      }
    }
  }

  private async queued<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve()
    const next = previous.then(operation, operation)
    const settled = next.then(() => undefined, () => undefined)
    this.queues.set(key, settled)
    try {
      return await next
    } finally {
      if (this.queues.get(key) === settled) this.queues.delete(key)
    }
  }

  /**
   * Stop listening and remove the socket. Containers keep running.
   * @returns when the listener has closed.
   */
  async close(): Promise<void> {
    await this.listener?.close()
    this.listener = undefined
  }
}
