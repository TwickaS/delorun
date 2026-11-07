/**
 * Helpers of the home process's specs: a temporary Delo home, a fixture runtime store with C1's pointer files, a
 * fixture profile history, a fixture Host whose chats the spec starts and ends, an in-process home process, and a
 * client that sends raw request lines.
 *
 * The runtime store's real implementation is `delo/packages/runtime-store`; the fixture keeps C1's pointer files and
 * switch order and starts successors from this package's fixture entry, whose Host behaves as the target version's
 * `fixture.json` says.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { RuntimeVersion, StartId } from '@delo/contract-home-layout'
import { ensureHomeTree, newStartId, processExists, readHomeLock, runDirectory, writeProtectedFile } from '@delo/home'
import { Redactor, type DeloLogger } from '@delo/logs'
import {
  CountingChatGate,
  HomeProcess,
  HomeProcessError,
  type HomeCommand,
  type HomeCommandMode,
  type HomeProcessOptions,
  type HostRunner,
  type PreparedRuntime,
  type ProfileSnapshots,
  type RunningHost,
  type RuntimePointers,
  type RuntimeStore,
  type SupervisorSetup,
  type UpdateChannelAccess,
  updateChannelProbe,
} from '../src/index.ts'

/** The CLI profile the specs use. */
export const PROFILE = 'default'

/** The repository root. */
export const REPOSITORY = fileURLToPath(new URL('../../../../', import.meta.url))

/** The fixture entry that runs a successor or a fresh start in its own process. */
export const ENTRY = fileURLToPath(new URL('./fixtures/home-entry.ts', import.meta.url))

/** The two versions the specs move between. */
export const V1 = brandString<RuntimeVersion>('1.0.0')
export const V2 = brandString<RuntimeVersion>('1.1.0')

/** How a fixture version's Host behaves, from `runtimes/<version>/fixture.json`. */
export interface FixtureBehaviour {
  /** Whether its studio listener answers the health request. */
  readonly healthy: boolean
  /** The plugins it disables at boot. */
  readonly disabled: readonly string[]
  /** The plugins the update report names as disabled. */
  readonly reportDisabled: readonly string[]
  /** How long its boot takes, in milliseconds. */
  readonly bootMs: number
}

/** A temporary Delo home with C1's tree. */
export interface TempHome {
  /** The canonical home. */
  readonly home: string
  /** A directory beside the home, outside it. */
  readonly outside: string
  /** Remove both. */
  remove(): void
}

/**
 * Create a temporary home and a sibling directory, with short paths so the socket path fits C1's limit.
 * @param parent - where to create them; the OS temporary directory when omitted.
 * @returns the home.
 */
export async function tempHome(parent: string = tmpdir()): Promise<TempHome> {
  mkdirSync(parent, { recursive: true })
  const base = realpathSync(mkdtempSync(join(parent, 'dhp-')))
  const home = join(base, 'h')
  const outside = join(base, 'o')
  await ensureHomeTree(home, PROFILE)
  mkdirSync(outside, { mode: 0o700 })
  return { home, outside, remove: () => { rmSync(base, { recursive: true, force: true }) } }
}

/**
 * Install a fixture version: its directory and its behaviour.
 * @param home - the Delo home.
 * @param version - the version.
 * @param behaviour - how its Host behaves.
 */
export function installFixture(home: string, version: RuntimeVersion, behaviour: Partial<FixtureBehaviour> = {}): void {
  const directory = join(home, 'runtimes', version)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const whole: FixtureBehaviour = { healthy: true, disabled: [], reportDisabled: [], bootMs: 0, ...behaviour }
  writeFileSync(join(directory, 'fixture.json'), JSON.stringify(whole))
}

/**
 * Read a fixture version's behaviour.
 * @param home - the Delo home.
 * @param version - the version.
 * @returns the behaviour.
 */
export function behaviourOf(home: string, version: RuntimeVersion): FixtureBehaviour {
  return JSON.parse(readFileSync(join(home, 'runtimes', version, 'fixture.json'), 'utf8')) as FixtureBehaviour
}

/**
 * Write a pointer file as C1 states it: one version and one newline, replaced atomically.
 * @param home - the Delo home.
 * @param name - `current` or `previous`.
 * @param version - the version.
 */
async function writePointer(home: string, name: 'current' | 'previous', version: RuntimeVersion): Promise<void> {
  await writeProtectedFile(join(home, 'runtimes', name), `${version}\n`)
}

/**
 * Read a pointer file.
 * @param home - the Delo home.
 * @param name - `current` or `previous`.
 * @returns the version, or `undefined` when the pointer is absent.
 */
export function readPointer(home: string, name: 'current' | 'previous'): RuntimeVersion | undefined {
  const path = join(home, 'runtimes', name)
  return existsSync(path) ? brandString<RuntimeVersion>(readFileSync(path, 'utf8').trim()) : undefined
}

/** The fixture runtime store: C1's pointer files and switch order over fixture versions. */
export class FixtureStore implements RuntimeStore {
  /** Every switch, as `from>to`, and every restore, as `restore:<current>`. */
  readonly switches: string[] = []

  /**
   * @param home - the Delo home.
   * @param profile - the CLI profile.
   */
  constructor(private readonly home: string, private readonly profile: string) {}

  /**
   * Install the versions and point `current` at the first.
   * @param home - the Delo home.
   * @param current - the version `current` names.
   */
  static async seed(home: string, current: RuntimeVersion): Promise<void> {
    mkdirSync(join(home, 'runtimes'), { recursive: true, mode: 0o700 })
    await writePointer(home, 'current', current)
  }

  async pointers(): Promise<RuntimePointers> {
    const current = readPointer(this.home, 'current')
    if (current === undefined) throw new Error('NO_ACTIVE_RUNTIME')
    const previous = readPointer(this.home, 'previous')
    return previous === undefined ? { current } : { current, previous }
  }

  async prepare(target: RuntimeVersion | undefined, phase: (phase: 'checking' | 'installing' | 'reporting') => void): Promise<PreparedRuntime> {
    phase('checking')
    if (target === undefined || !existsSync(join(this.home, 'runtimes', target, 'fixture.json'))) throw new HomeProcessError('VERIFY_FAILED', `no fixture release ${String(target)}`)
    phase('installing')
    phase('reporting')
    return Promise.resolve({ version: target, report: { fixture: true, to: target }, disabledPlugins: behaviourOf(this.home, target).reportDisabled })
  }

  async reportRollback(target: RuntimeVersion): Promise<PreparedRuntime> {
    return Promise.resolve({ version: target, report: { fixture: true, to: target }, disabledPlugins: behaviourOf(this.home, target).reportDisabled })
  }

  async switchTo(from: RuntimeVersion, to: RuntimeVersion): Promise<void> {
    this.switches.push(`${from}>${to}`)
    await writePointer(this.home, 'previous', from)
    await writePointer(this.home, 'current', to)
  }

  async restore(before: RuntimePointers): Promise<void> {
    this.switches.push(`restore:${before.current}`)
    if (before.previous !== undefined) await writePointer(this.home, 'previous', before.previous)
    await writePointer(this.home, 'current', before.current)
  }

  homeCommand(version: RuntimeVersion, mode: HomeCommandMode): HomeCommand {
    return { command: process.execPath, args: ['--import', 'tsx/esm', ENTRY, mode, this.home, this.profile, version], cwd: REPOSITORY }
  }
}

/** A profile history that records its calls. */
export class FixtureSnapshots implements ProfileSnapshots {
  /** Every call, as `save:<from>>to` or `restore:<from>>to`. */
  readonly calls: string[] = []

  async save(from: RuntimeVersion, to: RuntimeVersion): Promise<void> {
    this.calls.push(`save:${from}>${to}`)
    return Promise.resolve()
  }

  async restore(from: RuntimeVersion, to: RuntimeVersion): Promise<void> {
    this.calls.push(`restore:${from}>${to}`)
    return Promise.resolve()
  }
}

/** A fixture Host: its chats are a {@link CountingChatGate} the spec drives. */
export class FixtureHost implements RunningHost {
  readonly chats = new CountingChatGate()
  closed = false

  /**
   * @param behaviour - how it behaves.
   * @param access - its way to the update channel.
   */
  constructor(private readonly behaviour: FixtureBehaviour, readonly access: UpdateChannelAccess) {}

  disabledPlugins(): readonly string[] {
    return this.behaviour.disabled
  }

  async healthy(): Promise<boolean> {
    return Promise.resolve(this.behaviour.healthy)
  }

  async close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }
}

/** Boots fixture Hosts and keeps the latest. */
export class FixtureHostRunner implements HostRunner {
  /** Every Host booted, latest last. */
  readonly booted: FixtureHost[] = []

  /** @param behaviour - how each booted Host behaves. */
  constructor(private readonly behaviour: () => FixtureBehaviour) {}

  /** The latest Host. */
  get latest(): FixtureHost {
    const host = this.booted.at(-1)
    if (host === undefined) throw new Error('no Host was booted')
    return host
  }

  async boot(access: UpdateChannelAccess): Promise<RunningHost> {
    const behaviour = this.behaviour()
    if (behaviour.bootMs > 0) await new Promise(resolve => setTimeout(resolve, behaviour.bootMs))
    const host = new FixtureHost(behaviour, access)
    this.booted.push(host)
    return host
  }
}

/** A logger that keeps every record's message. */
export class MemoryLogger implements DeloLogger {
  readonly records: string[] = []
  error(msg: string, details?: { readonly data?: Readonly<Record<string, unknown>> }): void { this.records.push(`error ${msg} ${JSON.stringify(details?.data ?? {})}`) }
  warn(msg: string, details?: { readonly data?: Readonly<Record<string, unknown>> }): void { this.records.push(`warn ${msg} ${JSON.stringify(details?.data ?? {})}`) }
  info(msg: string, details?: { readonly data?: Readonly<Record<string, unknown>> }): void { this.records.push(`info ${msg} ${JSON.stringify(details?.data ?? {})}`) }
  debug(msg: string, details?: { readonly data?: Readonly<Record<string, unknown>> }): void { this.records.push(`debug ${msg} ${JSON.stringify(details?.data ?? {})}`) }
}

/** An in-process home process and what the spec observes of it. */
export interface InProcessHome {
  readonly process: HomeProcess
  readonly hosts: FixtureHostRunner
  readonly store: FixtureStore | undefined
  readonly snapshots: FixtureSnapshots
  readonly logger: MemoryLogger
  /** The exit codes the process asked for. */
  readonly exits: number[]
  /** Run the exit listeners, as the process's exit would. */
  exit(): void
}

/** The options of {@link startHome}. */
export interface StartHomeOptions {
  /** Whether the home process has the fixture store; true by default in these specs. */
  readonly updates?: boolean
  /** The version it runs. */
  readonly running?: RuntimeVersion
  /** Its logger. */
  readonly logger?: DeloLogger
  /** The supervisor it launches. */
  readonly supervisor?: SupervisorSetup
  /** Its log's redactor and start id, when it logs to a real surface. */
  readonly log?: { readonly redactor: Redactor, readonly startId: StartId }
}

/**
 * Start a home process in this process with fixture parts.
 * @param home - the Delo home.
 * @param options - whether it has a store, the version it runs and its logger.
 * @returns the process and its parts.
 */
export async function startHome(home: string, options: StartHomeOptions = {}): Promise<InProcessHome> {
  const running = options.running ?? V1
  const updates = options.updates ?? true
  const store = updates ? new FixtureStore(home, PROFILE) : undefined
  const snapshots = new FixtureSnapshots()
  const hosts = new FixtureHostRunner(() => behaviourOf(home, running))
  const logger = new MemoryLogger()
  const exits: number[] = []
  const listeners: (() => void)[] = []
  const homeOptions: HomeProcessOptions = {
    home, profile: PROFILE, running, startId: options.log?.startId ?? newStartId(), host: hosts, probe: updateChannelProbe(home, PROFILE), logger: options.logger ?? logger, redactor: options.log?.redactor ?? new Redactor(),
    updates: store === undefined ? undefined : { store, snapshots }, supervisor: options.supervisor,
    onExit: (listener) => { listeners.push(listener) },
    exit: (code) => { exits.push(code) },
  }
  const started = await HomeProcess.start(homeOptions)
  return { process: started, hosts, store, snapshots, logger, exits, exit: () => { for (const listener of listeners.splice(0)) listener() } }
}

/**
 * Wait until a condition holds.
 * @param condition - the condition.
 * @param timeoutMs - the longest wait.
 * @param what - what is waited for, for the failure message.
 */
export async function until(condition: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!await condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/**
 * Kill the process holding a profile's lock, if it is not this one, and wait for it to exit.
 * @param home - the Delo home.
 */
export async function killLockHolder(home: string): Promise<void> {
  const record = readHomeLock(runDirectory(home, PROFILE))
  if (record === undefined || record.pid === process.pid || !processExists(record.pid)) return
  process.kill(record.pid, 'SIGKILL')
  await until(() => !processExists(record.pid), 10_000, 'the lock holder to exit')
}

/**
 * A random start id.
 * @returns the start id.
 */
export function randomStartId(): StartId {
  return brandString<StartId>(randomBytes(16).toString('hex'))
}

/**
 * Read a text file.
 * @param path - the file.
 * @returns its text.
 */
export async function text(path: string): Promise<string> {
  return readFile(path, 'utf8')
}
