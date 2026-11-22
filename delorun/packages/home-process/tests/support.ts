/**
 * Helpers of the home process's specs: a temporary Delorun home, a fixture runtime store with C1's pointer files, a
 * fixture profile history, a fixture Host whose chats the spec starts and ends, an in-process home process, and a
 * client that sends raw request lines.
 *
 * The runtime store's real implementation is `delorun/packages/runtime-store`; the fixture keeps C1's pointer files and
 * switch order and starts successors from this package's fixture entry, whose Host behaves as the target version's
 * `fixture.json` says.
 */
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { RuntimeVersion, StartId } from '@delorun/contract-home-layout'
import type { ChangesReloadOutcome, UpdateJournal } from '@delorun/contract-home-process'
import { ensureHomeTree, newStartId, processExists, readHomeLock, runDirectory, writeProtectedFile } from '@delorun/home'
import { Redactor, type DelorunLogger } from '@delorun/logs'
import {
  CountingChatGate,
  HomeProcess,
  HomeProcessError,
  type BootRow,
  type HarnessCarry,
  type HealthExpectations,
  type HealthVerdict,
  type HomeCommand,
  type InstallEvent,
  type HomeCommandMode,
  type HomeProcessOptions,
  type HostProtection,
  type HomeSignal,
  type HostRunner,
  type PreparedRuntime,
  type ProfileSnapshots,
  type RestartSupport,
  type RollbackSteps,
  type RunningHost,
  type StudioLinkResult,
  type RuntimePointers,
  type RuntimeStore,
  type SessionDataCopies,
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

/** A version older than both, kept as `previous` before an update. */
export const V0 = brandString<RuntimeVersion>('0.9.0')

/** How a fixture version's Host behaves, from `runtimes/<version>/fixture.json`. */
export interface FixtureBehaviour {
  /** Whether its studio listener answers the health request. */
  readonly healthy: boolean
  /** The plugins it disables at boot. */
  readonly disabled: readonly string[]
  /** The plugins the update report names as disabled. */
  readonly reportDisabled: readonly string[]
  /** A file whose creation lets its boot finish, so a spec can hold the phase that waits for the boot; none by default. */
  readonly bootGate?: string
  /** How long its successor process works toward `ready` before it reports `failed` itself, in milliseconds; the product's deadline by default. */
  readonly successorDeadlineMs?: number
  /** Whether the update report to this version names a data change. */
  readonly dataDiffers?: boolean
  /** The rows its Host has at boot. */
  readonly rows?: readonly string[]
  /** The sandbox protection its Host boots with; none by default. */
  readonly protection?: HostProtection
  /** Whether the store's check before a start refuses this version. */
  readonly launchRefused?: boolean
  /** Whether its Host fails its health check only in a successor's process, so the predecessor's own Host boots again. */
  readonly unhealthySuccessor?: boolean
  /** The plugins its Host disables at boot in a successor's process, in place of {@link FixtureBehaviour.disabled}. */
  readonly successorDisabled?: readonly string[]
  /** A file its runner's `abandon` creates, which a successor's failed health check runs; none by default. */
  readonly abandonMarker?: string
  /** Whether its runner's `abandon` throws after creating the marker, as a runner that cannot undo its changes does. */
  readonly abandonFails?: boolean
  /** Whether its runner reports that its boot changed no profile file, so there is nothing for `abandon` to undo. */
  readonly nothingAdvanced?: boolean
  /** The sentences its health check returns as the protected-row changes its release brought; none by default. */
  readonly rowChanges?: readonly string[]
  /** A file its health check writes the expectation's `previousVersion` to, or `none` when the expectation names none; none by default. */
  readonly previousMarker?: string
  /**
   * Its teardown for a switch, which resolves at once by default.
   * @returns when the teardown has finished.
   */
  readonly suspend?: () => Promise<void>
}

/** A temporary Delorun home with C1's tree. */
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
 * @param home - the Delorun home.
 * @param version - the version.
 * @param behaviour - how its Host behaves.
 */
export function installFixture(home: string, version: RuntimeVersion, behaviour: Partial<FixtureBehaviour> = {}): void {
  const directory = join(home, 'runtimes', version)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const whole: FixtureBehaviour = { healthy: true, disabled: [], reportDisabled: [], ...behaviour }
  writeFileSync(join(directory, 'fixture.json'), JSON.stringify(whole))
}

/**
 * Read a fixture version's behaviour.
 * @param home - the Delorun home.
 * @param version - the version.
 * @returns the behaviour.
 */
export function behaviourOf(home: string, version: RuntimeVersion): FixtureBehaviour {
  return JSON.parse(readFileSync(join(home, 'runtimes', version, 'fixture.json'), 'utf8')) as FixtureBehaviour
}

/**
 * Write a pointer file as C1 states it: one version and one newline, replaced atomically.
 * @param home - the Delorun home.
 * @param name - `current` or `previous`.
 * @param version - the version.
 */
async function writePointer(home: string, name: 'current' | 'previous', version: RuntimeVersion): Promise<void> {
  await writeProtectedFile(join(home, 'runtimes', name), `${version}\n`)
}

/**
 * Read a pointer file.
 * @param home - the Delorun home.
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

  private readonly home: string
  private readonly profile: string

  /**
   * @param home - the Delorun home.
   * @param profile - the CLI profile.
   */
  constructor(home: string, profile: string) {
    this.home = home
    this.profile = profile
  }

  /**
   * Point `current`, and `previous` when given, at installed versions.
   * @param home - the Delorun home.
   * @param current - the version `current` names.
   * @param previous - the version `previous` names.
   */
  static async seed(home: string, current: RuntimeVersion, previous?: RuntimeVersion): Promise<void> {
    mkdirSync(join(home, 'runtimes'), { recursive: true, mode: 0o700 })
    await writePointer(home, 'current', current)
    if (previous !== undefined) await writePointer(home, 'previous', previous)
  }

  async pointers(): Promise<RuntimePointers> {
    const current = readPointer(this.home, 'current')
    if (current === undefined) throw new Error('NO_ACTIVE_RUNTIME')
    const previous = readPointer(this.home, 'previous')
    return previous === undefined ? { current } : { current, previous }
  }

  async prepare(target: RuntimeVersion | undefined, phase: (phase: 'checking' | 'installing' | 'reporting') => void, report: (event: InstallEvent) => void): Promise<PreparedRuntime> {
    phase('checking')
    if (target === undefined || !existsSync(join(this.home, 'runtimes', target, 'fixture.json'))) throw new HomeProcessError('VERIFY_FAILED', `no fixture release ${String(target)}`)
    phase('installing')
    report({ step: 'installing', version: target })
    phase('reporting')
    return Promise.resolve(preparedFor(this.home, target))
  }

  async reportRollback(target: RuntimeVersion): Promise<PreparedRuntime> {
    return Promise.resolve(preparedFor(this.home, target))
  }

  async switchTo(from: RuntimeVersion, to: RuntimeVersion): Promise<void> {
    this.switches.push(`${from}>${to}`)
    await writePointer(this.home, 'previous', from)
    await writePointer(this.home, 'current', to)
  }

  async restore(before: RuntimePointers): Promise<void> {
    this.switches.push(`restore:${before.current}`)
    await writePointer(this.home, 'current', before.current)
    if (before.previous !== undefined) await writePointer(this.home, 'previous', before.previous)
    else rmSync(join(this.home, 'runtimes', 'previous'), { force: true })
  }

  /** Every home command asked for, as `<mode>:<version>`: a start again after a rollback asks for `start`. */
  readonly commands: string[] = []

  homeCommand(version: RuntimeVersion, mode: HomeCommandMode): HomeCommand {
    this.commands.push(`${mode}:${version}`)
    return { command: process.execPath, args: ['--import', 'tsx/esm', ENTRY, mode, this.home, this.profile, version], cwd: REPOSITORY }
  }

  /** A version whose check before a start refuses, besides one whose fixture says so. */
  launchRefused: RuntimeVersion | undefined

  async checkLaunch(version: RuntimeVersion): Promise<void> {
    if (version === this.launchRefused || behaviourOf(this.home, version).launchRefused === true) throw new HomeProcessError('VERIFY_FAILED', `release ${version} failed its check before a start`)
    return Promise.resolve()
  }

  /** Records each retention in `runtimes/retained.log`, which a successor in another process writes too. */
  async retain(): Promise<unknown> {
    appendFileSync(join(this.home, 'runtimes', 'retained.log'), `${readPointer(this.home, 'current') ?? ''}\n`)
    return Promise.resolve({ removed: [], failed: [] })
  }
}

/**
 * A fixture version's prepared runtime.
 * @param home - the Delorun home.
 * @param target - the version.
 * @returns what the store's prepare returns for it.
 */
function preparedFor(home: string, target: RuntimeVersion): PreparedRuntime {
  const behaviour = behaviourOf(home, target)
  return { version: target, report: { fixture: true, to: target }, health: { disabledPlugins: behaviour.reportDisabled, namedRows: [] }, dataDiffers: behaviour.dataDiffers ?? false }
}

/** A profile history that records its calls. */
export class FixtureSnapshots implements ProfileSnapshots {
  /** Every call, as `save:<from>>to`, `committed:<from>>to` or `restore:<from>>to`. */
  readonly calls: string[] = []
  /** Whether {@link FixtureSnapshots.committed} fails. */
  committedFails = false

  async save(from: RuntimeVersion, to: RuntimeVersion): Promise<string> {
    this.calls.push(`save:${from}>${to}`)
    return Promise.resolve(`snapshot-${from}-${to}`)
  }

  async committed(from: RuntimeVersion, to: RuntimeVersion): Promise<void> {
    this.calls.push(`committed:${from}>${to}`)
    if (this.committedFails) throw new Error('the profile record could not be written')
    return Promise.resolve()
  }
}

/**
 * A harness carry that records its calls: `check:<from>`, `carry:<from>>to` and `switched` once the switch it runs
 * returned. A spec makes a change wait for review or the carry fail before the switch.
 */
export class FixtureHarness implements HarnessCarry {
  /** Every call, in order. */
  readonly calls: string[] = []
  /** Whether a change waits for review, which `check` and `carry` refuse. */
  pending = false
  /** Whether the carry fails before it runs the switch. */
  failCarry = false
  /** The report each carry was given. */
  readonly reports: unknown[] = []

  async check(from: RuntimeVersion): Promise<void> {
    this.calls.push(`check:${from}`)
    if (this.pending) throw new HomeProcessError('HARNESS_CHANGES_PENDING', 'app/a.js waits for review')
    return Promise.resolve()
  }

  async carry(from: RuntimeVersion, to: RuntimeVersion, report: unknown, switchRuntime: () => Promise<void>): Promise<void> {
    this.calls.push(`carry:${from}>${to}`)
    this.reports.push(report)
    if (this.pending) throw new HomeProcessError('HARNESS_CHANGES_PENDING', 'app/a.js waits for review')
    if (this.failCarry) throw new Error('the carry failed')
    await switchRuntime()
    this.calls.push('switched')
  }
}

/** A rollback step a spec makes fail. */
export type RollbackStep = 'data' | 'profile' | 'switch'

/**
 * Session-data copies that record their calls and apply C3's rollback table to the copies they took: a copy exists
 * for a target once {@link FixtureCopies.save} ran for it. A rollback runs the preflight, the caller's mark, the
 * data, the profile and the switch in that order, and the spec can make a step fail.
 */
export class FixtureCopies implements SessionDataCopies {
  /** Every call, as `recover`, `plan`, `save:<from>>to`, `discard:<to>`, `commit:<to>` or `rollback:<from>>to`. */
  readonly calls: string[] = []
  /** The targets a copy was taken for. */
  readonly copies = new Set<string>()
  /** Whether {@link FixtureCopies.plan} refuses for want of space. */
  noSpace = false
  /** Whether the preflight finds the version rolled back to unusable. */
  unusable = false
  /** Whether the preflight finds that git, which restores the profile, cannot run. */
  gitMissing = false
  /** The step that fails, after the steps before it ran. */
  failAt: RollbackStep | undefined
  /** Runs at the start of each rollback, before the preflight. */
  beforeRollback: ((record: UpdateJournal) => void) | undefined

  private readonly snapshots: FixtureSnapshots

  /** @param snapshots - the profile history the rollback restores through. */
  constructor(snapshots: FixtureSnapshots) {
    this.snapshots = snapshots
  }

  /**
   * Record the home process's pre-start steps, which finish an interrupted restore before any Host starts.
   * @returns at once.
   */
  async recover(): Promise<void> {
    this.calls.push('recover')
    return Promise.resolve()
  }

  /** Whether another process uses the chat data, which refuses an update and a rollback. */
  othersRunning = false

  async plan(copy: boolean): Promise<void> {
    if (this.othersRunning) throw new HomeProcessError('CHATS_RUNNING', 'the home process of the profile other (process 1) uses the chat data')
    if (!copy) return Promise.resolve()
    this.calls.push('plan')
    if (this.noSpace) throw new HomeProcessError('DATA_COPY_NO_SPACE', 'the fixture has no room')
    return Promise.resolve()
  }

  /** Runs when the handshake checks again, before {@link FixtureCopies.othersRunning} is read. */
  beforeConfirm: (() => Promise<void>) | undefined

  async confirmSoleUser(): Promise<void> {
    await this.beforeConfirm?.()
    if (this.othersRunning) throw new HomeProcessError('CHATS_RUNNING', 'the home process of the profile other (process 1) uses the chat data')
  }

  async save(from: RuntimeVersion, to: RuntimeVersion): Promise<void> {
    this.calls.push(`save:${from}>${to}`)
    this.copies.add(to)
    return Promise.resolve()
  }

  async discard(to: RuntimeVersion): Promise<void> {
    this.calls.push(`discard:${to}`)
    this.copies.delete(to)
    return Promise.resolve()
  }

  async commit(to: RuntimeVersion): Promise<void> {
    this.calls.push(`commit:${to}`)
    for (const target of this.copies) if (target !== to) this.copies.delete(target)
    return Promise.resolve()
  }

  async rollback(record: UpdateJournal, steps: RollbackSteps): Promise<readonly string[]> {
    this.calls.push(`rollback:${record.from}>${record.to}${steps.profileOnly ? ':profile-only' : ''}`)
    this.beforeRollback?.(record)
    const restoresCopy = !steps.profileOnly && record.dataDiffers && record.targetStarted
    if (this.gitMissing) throw new HomeProcessError('GIT_UNAVAILABLE', 'no git command is on PATH')
    if (!steps.profileOnly && this.unusable) throw new HomeProcessError('ROLLBACK_TARGET_UNUSABLE', `${record.from} does not start`)
    if (!steps.profileOnly && this.othersRunning) throw new HomeProcessError('CHATS_RUNNING', 'the home process of the profile other (process 1) uses the chat data')
    if (restoresCopy && !this.copies.has(record.to)) throw new HomeProcessError('ROLLBACK_NEEDS_DATA_COPY', 'no copy')
    await steps.markRollingBack()
    if (this.failAt === 'data') throw new Error('the data step failed')
    if (restoresCopy) this.copies.delete(record.to)
    this.snapshots.calls.push(`restore:${record.from}>${record.to}`)
    if (this.failAt === 'profile') throw new Error('the profile step failed')
    if (steps.profileOnly) return [`Went back on the profile alone to ${record.from}.`]
    if (this.failAt === 'switch') throw new Error('the switch step failed')
    await steps.switchRuntime()
    return restoresCopy ? [`Went back to ${record.from}; 1 chat(s) set aside.`] : [`Went back to ${record.from}.`]
  }
}

/** A fixture Host: its chats are a {@link CountingChatGate} the spec drives. */
export class FixtureHost implements RunningHost {
  readonly chats = new CountingChatGate()
  closed = false
  /** What the next `reload` answers. */
  reloadOutcome: ChangesReloadOutcome = { ok: true }
  /** How often `reload` was called. */
  reloads = 0

  /** How it was asked to stop, in order: `close` as the process stops, `suspend` through its own teardown. */
  readonly stops: ('close' | 'suspend')[] = []

  private readonly behaviour: FixtureBehaviour
  readonly access: UpdateChannelAccess

  /**
   * @param behaviour - how it behaves.
   * @param access - its way to the update channel.
   */
  constructor(behaviour: FixtureBehaviour, access: UpdateChannelAccess) {
    this.behaviour = behaviour
    this.access = access
  }

  studio(): string | undefined {
    return 'http://127.0.0.1:1/'
  }

  /** Links minted so far. */
  links = 0

  /** The ports the links were asked for. */
  readonly linkPorts: (number | undefined)[] = []

  studioLink(port: number | undefined): StudioLinkResult {
    this.links += 1
    this.linkPorts.push(port)
    return { kind: 'link', link: { url: `http://127.0.0.1:${String(port ?? 1)}/?token=fixture-link-${String(this.links)}`, oneTime: true } }
  }

  failedRows(): readonly BootRow[] {
    return this.behaviour.disabled.map(name => ({ id: name, name, generated: false }))
  }

  rows(): readonly BootRow[] {
    return (this.behaviour.rows ?? []).map(id => ({ id, name: `plugin-${id}`, generated: false }))
  }

  protection(): HostProtection | undefined {
    return this.behaviour.protection
  }

  async check(expect: HealthExpectations | undefined): Promise<HealthVerdict> {
    if (!this.behaviour.healthy) return Promise.resolve({ passed: false, criterion: 'H2-host-ready', detail: 'the fixture is unhealthy' })
    if (expect === undefined) return Promise.resolve({ passed: true })
    const { previousMarker, rowChanges } = this.behaviour
    if (previousMarker !== undefined) writeFileSync(previousMarker, expect.previousVersion ?? 'none')
    const allowed = new Set([...expect.disabledPlugins, ...expect.previousFailures.map(row => row.id)])
    const unexpected = this.behaviour.disabled.filter(plugin => !allowed.has(plugin))
    if (unexpected.length > 0) return Promise.resolve({ passed: false, criterion: 'H3-only-named-disabled', detail: unexpected.join(',') })
    const denied = this.behaviour.protection?.deniedSockets ?? []
    const lost = expect.previousProtection?.deniedSockets.filter(socket => !denied.includes(socket)) ?? []
    if (lost.length > 0) return Promise.resolve({ passed: false, criterion: 'H3-only-named-disabled', detail: `no longer denies ${lost.join(',')}` })
    const present = this.rows().map(row => row.id)
    const gone = expect.previousRows.filter(row => !present.includes(row.id) && !expect.namedRows.includes(row.id)).map(row => row.id)
    return Promise.resolve(gone.length === 0 ? { passed: true, ...rowChanges === undefined ? {} : { rowChanges } } : { passed: false, criterion: 'H3-rows-kept', detail: gone.join(',') })
  }

  async reload(): Promise<ChangesReloadOutcome> {
    this.reloads += 1
    return Promise.resolve(this.reloadOutcome)
  }

  async close(): Promise<void> {
    this.stops.push('close')
    this.closed = true
    return Promise.resolve()
  }

  async suspend(): Promise<void> {
    this.stops.push('suspend')
    await this.behaviour.suspend?.()
    this.closed = true
  }
}

/** Boots fixture Hosts and keeps the latest. */
export class FixtureHostRunner implements HostRunner {
  /** Every Host booted, latest last. */
  readonly booted: FixtureHost[] = []

  private readonly behaviour: () => FixtureBehaviour

  /** @param behaviour - how each booted Host behaves. */
  constructor(behaviour: () => FixtureBehaviour) {
    this.behaviour = behaviour
  }

  /** The latest Host. */
  get latest(): FixtureHost {
    const host = this.booted.at(-1)
    if (host === undefined) throw new Error('no Host was booted')
    return host
  }

  async boot(access: UpdateChannelAccess): Promise<RunningHost> {
    const behaviour = this.behaviour()
    const gate = behaviour.bootGate
    if (gate !== undefined) await until(() => existsSync(gate), 60_000, `the spec to create ${gate}`)
    const host = new FixtureHost(behaviour, access)
    this.booted.push(host)
    return host
  }

  advanced(): Promise<boolean> {
    return Promise.resolve(this.behaviour().nothingAdvanced !== true)
  }

  abandon(): Promise<void> {
    const { abandonMarker, abandonFails } = this.behaviour()
    if (abandonMarker !== undefined) writeFileSync(abandonMarker, 'abandoned')
    return abandonFails === true ? Promise.reject(new Error('the records cannot be put back')) : Promise.resolve()
  }
}

/** A logger that keeps every record's message. */
export class MemoryLogger implements DelorunLogger {
  readonly records: string[] = []
  error(msg: string, details?: { readonly data?: Readonly<Record<string, unknown>> }): void { this.records.push(`error ${msg} ${JSON.stringify(details?.data ?? {})}`) }
  warn(msg: string, details?: { readonly data?: Readonly<Record<string, unknown>> }): void { this.records.push(`warn ${msg} ${JSON.stringify(details?.data ?? {})}`) }
  info(msg: string, details?: { readonly data?: Readonly<Record<string, unknown>> }): void { this.records.push(`info ${msg} ${JSON.stringify(details?.data ?? {})}`) }
  debug(msg: string, details?: { readonly data?: Readonly<Record<string, unknown>> }): void { this.records.push(`debug ${msg} ${JSON.stringify(details?.data ?? {})}`) }
}

/** The signal listeners a fixture home process registered through `onSignal`, to which a spec sends signals. */
export class FixtureSignals {
  private readonly listeners = new Set<(signal: HomeSignal) => void>()

  /** The number of listeners registered now. */
  get count(): number {
    return this.listeners.size
  }

  /**
   * The `onSignal` option.
   * @param listener - the home process's listener.
   * @returns the disposer.
   */
  readonly listen = (listener: (signal: HomeSignal) => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Deliver a signal to every registered listener, as the operating system delivers it.
   * @param signal - the signal.
   */
  send(signal: HomeSignal): void {
    for (const listener of [...this.listeners]) listener(signal)
  }
}

/** An in-process home process and what the spec observes of it. */
export interface InProcessHome {
  readonly process: HomeProcess
  readonly hosts: FixtureHostRunner
  readonly store: FixtureStore | undefined
  readonly snapshots: FixtureSnapshots
  readonly copies: FixtureCopies
  readonly harness: FixtureHarness
  readonly logger: MemoryLogger
  /** The signals the process listens for. */
  readonly signals: FixtureSignals
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
  readonly logger?: DelorunLogger
  /** The supervisor it launches. */
  readonly supervisor?: SupervisorSetup
  /** Its log's redactor and start id, when it logs to a real surface. */
  readonly log?: { readonly redactor: Redactor, readonly startId: StartId }
  /**
   * The teardown of each Host this process boots, for a switch; it resolves at once by default.
   * @returns when the teardown has finished.
   */
  readonly hostSuspend?: () => Promise<void>
  /** What a restart needs beyond the home process; none by default, so no restart begins. */
  readonly restart?: RestartSupport
  /** Runs before the start with the fixture parts and the start id, so a spec can watch a start that fails. */
  readonly configure?: (parts: StartParts) => void
  /** The clock of the hourly log age check. */
  readonly now?: () => number
}

/** The fixture parts of a start, which {@link StartHomeOptions.configure} receives before the start runs. */
export interface StartParts {
  readonly copies: FixtureCopies
  readonly snapshots: FixtureSnapshots
  readonly harness: FixtureHarness
  readonly hosts: FixtureHostRunner
  readonly store: FixtureStore | undefined
  readonly startId: StartId
  /** The signals the process listens for. */
  readonly signals: FixtureSignals
  /** The exit codes the process asked for. */
  readonly exits: readonly number[]
}

/**
 * Start a home process in this process with fixture parts.
 * @param home - the Delorun home.
 * @param options - whether it has a store, the version it runs and its logger.
 * @returns the process and its parts.
 */
export async function startHome(home: string, options: StartHomeOptions = {}): Promise<InProcessHome> {
  const running = options.running ?? V1
  const updates = options.updates ?? true
  const store = updates ? new FixtureStore(home, PROFILE) : undefined
  const snapshots = new FixtureSnapshots()
  const copies = new FixtureCopies(snapshots)
  const harness = new FixtureHarness()
  const hostSuspend = options.hostSuspend
  const hosts = new FixtureHostRunner(() => ({ ...behaviourOf(home, running), ...hostSuspend === undefined ? {} : { suspend: hostSuspend } }))
  const logger = new MemoryLogger()
  const exits: number[] = []
  const listeners: (() => void)[] = []
  const startId = options.log?.startId ?? newStartId()
  const signals = new FixtureSignals()
  options.configure?.({ copies, snapshots, harness, hosts, store, startId, signals, exits })
  const homeOptions: HomeProcessOptions = {
    home, profile: PROFILE, running, startId, host: hosts, preStart: () => copies.recover(), probe: updateChannelProbe(home, PROFILE), logger: options.logger ?? logger, redactor: options.log?.redactor ?? new Redactor(),
    updates: store === undefined ? undefined : { store, snapshots, copies, harness }, supervisor: options.supervisor,
    onExit: (listener) => { listeners.push(listener) },
    onSignal: signals.listen,
    exit: (code) => { exits.push(code) },
    ...options.now === undefined ? {} : { now: options.now },
    ...options.restart === undefined ? {} : { restart: options.restart },
  }
  const started = await HomeProcess.start(homeOptions)
  return { process: started, hosts, store, snapshots, copies, harness, logger, signals, exits, exit: () => { for (const listener of listeners.splice(0)) listener() } }
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
 * @param home - the Delorun home.
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
