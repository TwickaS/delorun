/**
 * Helpers of the supervisor's specs: a temporary Delorun home, the home process's half of the start token (writing the
 * token file as C1 states), a fixture verified manifest, an in-process supervisor and a client that sends one
 * request line.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StartToken } from '@delorun/contract-home-layout'
import { IMAGES, type SupervisorFailure } from '@delorun/contract-runtime-supervisor'
import type { FileRef, OciDigest } from '@delorun/contract-release-manifest'
import { ensureHomeTree, startTokenFile, writeProtectedFile } from '@delorun/home'
import type { DelorunLogger } from '@delorun/logs'
import { PRESETS, type DockerCapabilities, type DockerLimit, type LimitFinding } from '@delorun/contract-runtime-supervisor'
import {
  EngineError,
  homeIdOf,
  loadRootRules,
  openSupervisorLog,
  shapesOf,
  Supervisor,
  Workspaces,
  type CreateBody,
  type Engine,
  type ImagePull,
  type InspectRecord,
  type SupervisorLog,
  type SupervisorTiming,
  type VerifiedManifest,
} from '../src/index.ts'

/** The CLI profile the specs use. */
export const PROFILE = 'default'

/** A temporary Delorun home with C1's tree. */
export interface TempHome {
  /** The canonical home. */
  readonly home: string
  /** A directory beside the home, outside it, for workspace parents. */
  readonly outside: string
  /** Remove both. */
  remove(): void
}

/**
 * Create a temporary home and a sibling directory. The paths stay short, so the socket path fits C1's limit.
 * @param parent - where to create them; the OS temporary directory when omitted.
 * @returns the home.
 */
export async function tempHome(parent: string = tmpdir()): Promise<TempHome> {
  mkdirSync(parent, { recursive: true })
  const base = realpathSync(mkdtempSync(join(parent, 'dsv-')))
  const home = join(base, 'h')
  const outside = join(base, 'o')
  await ensureHomeTree(home, PROFILE)
  mkdirSync(outside, { mode: 0o700 })
  return { home, outside, remove: () => { rmSync(base, { recursive: true, force: true }) } }
}

/**
 * Write a new start token the way the home process does at each start.
 * @param home - the Delorun home.
 * @returns the token.
 */
export async function writeStartToken(home: string): Promise<StartToken> {
  const token = randomBytes(32).toString('base64url') as StartToken
  await writeProtectedFile(startTokenFile(home, PROFILE), `${token}\n`)
  return token
}

/** A digest that no image has. */
export const ABSENT_DIGEST = `sha256:${'0'.repeat(64)}` as OciDigest

/**
 * A verified manifest naming C9's repositories at the given digests.
 * @param s2 - the S2 image's digest, used for its index and both platforms.
 * @param s3 - the S3 image's digest.
 * @param s2Seccomp - the S2 image's listed seccomp profile file, if any.
 * @returns the manifest's image entries.
 */
export function fixtureManifest(s2: OciDigest = ABSENT_DIGEST, s3: OciDigest = ABSENT_DIGEST, s2Seccomp?: FileRef): Required<VerifiedManifest> {
  return {
    images: {
      s2: { repository: IMAGES.s2, index: s2, platforms: { 'linux/amd64': s2, 'linux/arm64': s2 }, ...s2Seccomp === undefined ? {} : { seccomp: s2Seccomp } },
      s3: { repository: IMAGES.s3, index: s3, platforms: { 'linux/amd64': s3, 'linux/arm64': s3 } },
    },
  }
}

/** The deadlines the specs run with. */
export const TIMING: SupervisorTiming = { engineCallMs: 30_000, pullMs: 600_000, firstByteMs: 1_000, refusalLogIntervalMs: 60_000 }

/** An environment whose Docker endpoint answers nothing. */
export function noDockerEnv(home: string): Record<string, string> {
  return { DOCKER_HOST: `unix://${join(home, 'no-docker.sock')}`, DOCKER_CONFIG: join(home, 'no-docker-config') }
}

/** An in-process supervisor and its log. */
export interface RunningSupervisor {
  readonly supervisor: Supervisor
  readonly log: SupervisorLog
  readonly token: StartToken
  stop(): Promise<void>
}

/** The options of {@link startSupervisor}. */
export interface StartOptions {
  /** The token; a new one is written when omitted. */
  readonly token?: StartToken
  /** The manifest; {@link fixtureManifest} when omitted. */
  readonly manifest?: VerifiedManifest
  /** The environment; {@link noDockerEnv} when omitted. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Pulling; `none` when omitted, so no spec reaches a registry. */
  readonly pull?: ImagePull
  /** The OS home; the real one when omitted. */
  readonly osHome?: string
  /** The seccomp profile directory; `<home>/seccomp` when omitted. */
  readonly seccompDirectory?: string
  /** The deadlines; {@link TIMING} when omitted. */
  readonly timing?: SupervisorTiming
}

/**
 * Start a supervisor in this process, logging to the home's supervisor surface.
 * @param home - the Delorun home.
 * @param options - the token, manifest, environment and pulling.
 * @returns the running supervisor.
 */
export async function startSupervisor(home: string, options: StartOptions = {}): Promise<RunningSupervisor> {
  const token = options.token ?? await writeStartToken(home)
  const log = openSupervisorLog({ home, profile: PROFILE, startId: randomBytes(16).toString('hex'), level: 'debug', onFailure: () => {} })
  log.redactor.register(token, 'start-token')
  const supervisor = await Supervisor.start({
    home, profile: PROFILE, token, manifest: options.manifest ?? fixtureManifest(), pull: options.pull ?? 'none',
    logger: log.logger, env: options.env ?? noDockerEnv(home), osHome: options.osHome ?? homedir(), seccompDirectory: options.seccompDirectory ?? join(home, 'seccomp'), timing: options.timing ?? TIMING,
  })
  return {
    supervisor, log, token,
    stop: async () => {
      await supervisor.close()
      log.log.close()
    },
  }
}

/** A response line. */
export type Response = ({ readonly ok: true } & Record<string, unknown>) | SupervisorFailure

/**
 * Send raw bytes on one connection and read the response line.
 * @param socketPath - the supervisor's socket.
 * @param bytes - what to write; the connection stays open until the supervisor ends it.
 * @returns the parsed response line.
 */
export function sendRaw(socketPath: string, bytes: string | Buffer): Promise<Response> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    let text = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => { text += chunk })
    socket.on('error', reject)
    socket.on('close', () => {
      try {
        resolve(JSON.parse(text.split('\n')[0] ?? '') as Response)
      } catch (error) {
        reject(new Error(`no response line: ${JSON.stringify(text)}`, { cause: error }))
      }
    })
    socket.write(bytes)
  })
}

/**
 * Send one request object as a line.
 * @param socketPath - the supervisor's socket.
 * @param request - the request; any value, so specs can send what the schema refuses.
 * @returns the parsed response line.
 */
export function send(socketPath: string, request: unknown): Promise<Response> {
  return sendRaw(socketPath, `${JSON.stringify(request)}\n`)
}

/** A logger that drops every record. */
export const SILENT: DelorunLogger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }

/** The Docker objects a {@link fakeEngine} holds, and the calls it received. */
export interface FakeEngineState {
  /** Containers by name, as their inspect records. */
  readonly containers: Map<string, InspectRecord>
  /** Every call, as `METHOD path`. */
  readonly calls: string[]
  /** The body of each `/networks/create` call, by the network's name, when the spec reads them. */
  readonly networks?: Map<string, Record<string, unknown>>
  /** Changes a created container's record, as an engine that does not apply a setting would. */
  alter?: (name: string, record: InspectRecord) => InspectRecord
  /**
   * Answers an exec inside a container with its exit code, as a container whose probes show something would; `0` when
   * omitted. It may change the container's record first, as a machine that alters a running container does.
   */
  exec?: (container: string, cmd: readonly string[], state: FakeEngineState) => Promise<number | undefined> | number | undefined
  /** The state a start leaves, as an engine that runs a container which exits at once does; `running` when omitted. */
  startState?: InspectRecord['State']
  /** Refuses one call, as an engine that failed or refused it would; no call is refused when omitted. */
  refuse?: (method: string, path: string) => Error | undefined
}

/** A digest the fake engine holds the S2 image at. */
export const FAKE_DIGEST = `sha256:${'d'.repeat(64)}` as OciDigest

/**
 * The inspect record an engine that applied every setting of a body returns.
 * @param body - the create body.
 * @returns the record.
 */
export function appliedRecord(body: CreateBody): InspectRecord {
  return {
    Id: 'c',
    Config: { Image: body.Image, User: body.User, Labels: body.Labels, Env: body.Env },
    State: { Status: 'created', Running: false },
    HostConfig: { ...body.HostConfig },
    Mounts: body.HostConfig.Mounts.map(mount => ({ Type: 'bind', Source: mount.Source, Destination: mount.Target, ReadOnly: mount.ReadOnly })),
    NetworkSettings: { Networks: { [body.HostConfig.NetworkMode]: {} } },
  }
}

/**
 * An engine in memory that holds the S2 image at {@link FAKE_DIGEST} and creates, inspects, lists, starts and
 * removes containers.
 * @param state - its objects and the calls it records.
 * @returns the engine.
 */
export function fakeEngine(state: FakeEngineState): Engine {
  return {
    call: (method, path, body) => {
      state.calls.push(`${method} ${path}`)
      const refused = state.refuse?.(method, path)
      if (refused !== undefined) return Promise.reject(refused)
      const name = decodeURIComponent(/^\/containers\/([^/?]+)/.exec(path)?.[1] ?? '')
      if (path.startsWith('/images/')) return Promise.resolve({ Id: 'sha256:i', RepoDigests: [`${IMAGES.s2}@${FAKE_DIGEST}`] })
      if (method === 'GET' && path.startsWith('/containers/json')) {
        // The engine's label filter: each entry is a key that must be present, or `key=value` that must match.
        const query = new URLSearchParams(path.slice(path.indexOf('?') + 1)).get('filters')
        const wanted = query === null ? [] : (JSON.parse(query) as { readonly label?: readonly string[] }).label ?? []
        const matches = (labels: Readonly<Record<string, string>>): boolean => wanted.every((entry) => {
          const [key = '', ...value] = entry.split('=')
          return value.length === 0 ? key in labels : labels[key] === value.join('=')
        })
        return Promise.resolve([...state.containers.entries()]
          .filter(([, record]) => matches(record.Config?.Labels ?? {}))
          .map(([key, record]) => ({ Names: [`/${key}`], Labels: record.Config?.Labels ?? {}, Mounts: (record.Mounts ?? []).map(mount => ({ ...mount })) })))
      }
      if (method === 'POST' && path === '/networks/create') {
        const created = body as { readonly Name: string }
        state.networks?.set(created.Name, body as Record<string, unknown>)
        return Promise.resolve({ Id: created.Name })
      }
      if (method === 'POST' && path.startsWith('/containers/create')) {
        const created = decodeURIComponent(/name=([^&]+)/.exec(path)?.[1] ?? '')
        if (state.containers.has(created)) return Promise.reject(new EngineError(409, `Conflict. The container name "/${created}" is already in use`))
        const record = appliedRecord(body as CreateBody)
        state.containers.set(created, state.alter?.(created, record) ?? record)
        return Promise.resolve({ Id: created })
      }
      const record = state.containers.get(name)
      if (method === 'GET' && path.startsWith('/containers/')) return record === undefined ? Promise.reject(new EngineError(404, `No such container: ${name}`)) : Promise.resolve(record)
      if (method === 'POST' && path.endsWith('/start') && record !== undefined) {
        state.containers.set(name, { ...record, State: state.startState ?? { Status: 'running', Running: true } })
        return Promise.resolve(null)
      }
      if (method === 'DELETE' && path.startsWith('/containers/')) {
        if (!state.containers.delete(name)) return Promise.reject(new EngineError(404, `No such container: ${name}`))
        return Promise.resolve(null)
      }
      return Promise.resolve(null)
    },
    pull: () => Promise.reject(new EngineError(500, 'the fake engine does not pull')),
    execExitCode: (container, cmd) => Promise.resolve(state.exec === undefined ? 0 : state.exec(container, cmd, state)),
  }
}

/** Every limit enforced, as a Linux engine that offers S2 reports them. */
export const ALL_ENFORCED = Object.fromEntries((['cpu', 'memory', 'pids', 'disk', 'cap-drop', 'no-new-privileges', 'read-only-root', 'seccomp', 'user-namespace', 'network-isolation', 'host-gateway-block', 'host-loopback-block', 'egress-allowlist'] as const)
  .map(limit => [limit, { status: 'enforced', evidence: 'fixture' }])) as Record<DockerLimit, LimitFinding>

/** The options of {@link fakeWorkspaces}. */
export interface FakeWorkspaceOptions {
  /**
   * The limits the machine does not enforce, which leaves S2 unoffered with `limits-missing` when one of them is a
   * limit S2 requires; none when omitted, as a machine that enforces every required limit.
   */
  readonly unenforced?: readonly DockerLimit[]
}

/**
 * The workspace operations over a {@link fakeEngine}, on a machine that offers S2 without a disk quota.
 * @param home - the Delorun home, whose roots file names the parents.
 * @param state - the fake engine's objects.
 * @param osHome - the OS home the rules compare with; the real one when omitted.
 * @param manifestDigest - the S2 digest the verified manifest lists; the one the fake engine holds when omitted.
 * @param profile - the CLI profile whose labels the workspaces carry.
 * @param options - the limits the machine does not enforce; every required one when omitted.
 * @returns the workspace operations.
 */
export async function fakeWorkspaces(home: string, state: FakeEngineState, osHome: string = homedir(), manifestDigest: OciDigest = FAKE_DIGEST, profile: string = PROFILE, options: FakeWorkspaceOptions = {}): Promise<Workspaces> {
  // As the supervisor derives them, so the fake reports S2 unoffered exactly where the real shapes do.
  const unenforced = { status: 'not-enforced' as const, evidence: 'fixture' }
  const limits = { ...ALL_ENFORCED, disk: unenforced, ...Object.fromEntries((options.unenforced ?? []).map(limit => [limit, unenforced])) }
  const docker: DockerCapabilities = { engine: 'docker-engine', version: '29', rootless: false, context: 'default', endpoint: { kind: 'unix', path: '/var/run/docker.sock' }, storageDriver: 'overlay2', limits }
  return new Workspaces({
    engine: fakeEngine(state), owner: { homeId: homeIdOf(home), profile }, rules: await loadRootRules(home, osHome),
    manifest: fixtureManifest(manifestDigest), pull: 'none', seccompDirectory: join(home, 'seccomp'),
    inspection: () => ({
      docker,
      shapes: shapesOf(docker, undefined, {}),
      machine: { cpus: PRESETS.large.cpus, memoryBytes: PRESETS.large.memoryBytes * 2 },
      platform: 'linux/amd64',
    }),
  })
}
