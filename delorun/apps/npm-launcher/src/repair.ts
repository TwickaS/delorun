/**
 * `delorun repair`: reset the program, keep the data (update design H2). It runs only in the launcher, from a terminal,
 * so it works when the installed runtime cannot start or cannot read a newer format. It installs a release that passes
 * the same verification as a channel install into a fresh runtime store, sets the old store aside as
 * `runtimes.set-aside-<time>/` and never deletes it, and carries `trust/` forward unchanged. The home process's update
 * socket, the Connection routes and a remote device have no way to reach it: nothing in this module is imported by them
 * and no home-process request names it.
 *
 * A concurrent `delorun` start cannot launch the program being set aside. The repair writes `run/repair.json` (see
 * `repair-record.ts`) before it changes anything and removes it last, and every launcher start refuses while the process
 * it names runs, which covers a profile that has no run directory yet. It also holds the home lock of every profile it
 * can name from before the set-aside until the rename back or the fresh store's start check, and a start that finds the
 * lock held is refused by the runtime it launched. The fresh store's install takes that store's own lock.
 *
 * Order: record the repair; refuse a running home process; hold the home locks; resolve and verify the release; apply the downgrade floor; ask the person;
 * set the store aside; install; run the data guard and the start check; put the session-data copy back last. A failure
 * before the last step renames the old store back.
 *
 * @module @delorun/npm-launcher/repair
 */
import { appendFile, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { DELORUN_HOME_ENTRIES, type RuntimeVersion } from '@delorun/contract-home-layout'
import type { ReleaseChannel, RootMetadata } from '@delorun/contract-release-manifest'
import { HOME_DATA_FORMAT_SCHEMA } from '@delorun/contract-update-report'
import { acquireHomeLock, holderAlive, newStartId, profileOption, readHomeLock, runDirectory, type HomeLock, type Refusal } from '@delorun/home'
import { isInstallError, messageOf, type InstallerProgress, newestManifestVersion, readStoredRootBytes, readStoredRootChain, readStoredTimestamp, verifyStoredRoot, type UnconfirmedInstall } from '@delorun/install'
import { Redactor } from '@delorun/logs'
import { readRoot, verifySignedManifest } from '@delorun/release-formats/sign/verify'
import { parseRuntimeVersion, type ChannelRelease, type StorePaths, type VerifiedRuntime, type InstallRequest } from '@delorun/runtime-store'
import { readCopyRecord, readDataFormats, readHomeDataFormat, relateHomeData, restoreDataCopy, runtimesSetAsideName, writeHomeDataFormat } from '@delorun/update/home-data'
import semver from 'semver'
import type { LauncherOutput } from './launcher.ts'
import { beginRepairRecord, REPAIR_RECORD_FILE, stamp, staleRepairText, trustSetAsideName, type resolveRepairMarkGraceSeconds } from './repair-record.ts'
import { LAUNCHER_EXIT, refusalFor, renderLauncherRefusal } from './refusals.ts'

/** The flags `delorun repair` reads, beside `--profile`. */
export interface RepairLine {
  /** `--release`: the release to install; the channel's current one by default. */
  readonly release?: RuntimeVersion
  /** `--from`: a folder or `https:` address that holds the release page's files. */
  readonly from?: string
  /** `--restore-copy`: put back the session-data copy taken before the release that wrote the home's data. */
  readonly restoreCopy: boolean
  /** `--reset-trust`: re-verify from the roots this launcher ships. */
  readonly resetTrust: boolean
}

/** The store operations a repair drives; `RuntimeStore` satisfies it. */
export interface RepairStore {
  /** The store's paths. */
  readonly paths: StorePaths
  /**
   * Install a verified runtime closure into the (fresh) store.
   * @param request - the version, the root and the fill step.
   * @returns the installed runtime.
   */
  install(request: InstallRequest): Promise<VerifiedRuntime>
  /**
   * Read `current`.
   * @returns the pointers; rejects when the store names no usable `current`.
   */
  pointers(): Promise<{ readonly current: RuntimeVersion }>
}

/** The release channel a repair resolves through; `LauncherChannel` satisfies it. */
export interface RepairChannel {
  /**
   * Verify the release.
   * @param target - the release a person named.
   * @returns the release and the root it verified with.
   */
  resolve(target?: RuntimeVersion): Promise<ChannelRelease>
  /**
   * Download and extract the resolved release.
   * @param release - the resolved release.
   * @param directory - the store's staging directory.
   * @returns the files to keep beside the installation.
   */
  fill(release: ChannelRelease, directory: string): ReturnType<InstallRequest['fill']>
  /**
   * Record the release-log check state of the installed release.
   * @param release - the installed release.
   */
  recordInstalled(release: ChannelRelease): Promise<void>
}

/** What one repair is given. */
export interface RepairOptions {
  /** The resolved Delorun home. */
  readonly home: string
  /** The CLI profile, which a remedy names. */
  readonly profile: string
  /** The parsed flags. */
  readonly line: RepairLine
  /** The root files this launcher ships, oldest first. */
  readonly roots: readonly Uint8Array[]
  /** The release channel of this home, as {@link installedChannel} reads it. */
  readonly releaseChannel: ReleaseChannel
  /** The store of this home. */
  readonly store: RepairStore
  /** The channel to resolve through: the production channel, or the source `--from` names. */
  readonly channel: RepairChannel
  /**
   * Ask the person a yes/no question.
   * @param question - the question, ending in `[y/N]`.
   * @returns the answer, or `undefined` when there is no terminal to ask.
   */
  readonly confirm: (question: string) => Promise<boolean | undefined>
  /**
   * Run the start check of the installed release: the store's check of its files and contract C18's release-log check.
   * @param version - the installed release.
   * @param root - the root it verified with.
   * @throws when the release may not start.
   */
  readonly startCheck: (version: RuntimeVersion, root: RootMetadata) => Promise<void>
  /** Where the launcher writes. */
  readonly output: LauncherOutput
  /** The clock. */
  readonly now: () => Date
  /** The seconds a repair mark that does not parse still counts as a running repair; see {@link resolveRepairMarkGraceSeconds}. */
  readonly repairMarkGraceSeconds: number
  /** Whether the channel already asked the person about a release below the floor; {@link repairUnconfirmed}'s `asked`. */
  readonly belowFloorAsked?: () => boolean
  /**
   * The install's progress display: told of `installing` and `installed`, ended with the line that says what to do next
   * when the repair finishes, and marked failed when it does not. Nothing is shown by default.
   */
  readonly progress?: RepairProgress
}

/** The part of the install renderer a repair drives. */
export interface RepairProgress {
  /**
   * Show a step the repair itself reports.
   * @param event - the step.
   */
  handle(event: InstallerProgress): void
  /**
   * End the display after the last line of a repair that succeeded.
   * @param next - what to do next, without its `Next:`.
   */
  finish(next: string): void
  /** End the display of a repair that stopped; the refusal's own text follows. */
  fail(): void
}

/**
 * What `--from` may relax in a repair, and the question that gates it: the timestamp's freshness, and a `--release` the
 * person names below the floor. Both need the person's yes at a terminal; neither is relaxed for the channel's current
 * release, and no signature, release-log or root check is.
 * @param line - the parsed flags.
 * @param confirm - asks the person; `undefined` when there is no terminal.
 * @returns the channel's option and whether it asked about the floor; `undefined` without `--from`.
 */
export async function repairUnconfirmed(line: RepairLine, confirm: RepairOptions['confirm']): Promise<{ readonly install: UnconfirmedInstall, readonly asked: () => boolean } | undefined> {
  if (line.from === undefined) return undefined
  let askedFloor = false
  const version = await newestManifestVersion(line.from)
  const install: UnconfirmedInstall = {
    ...version === undefined ? {} : { version },
    belowFloor: line.release !== undefined,
    allow: async ({ version: release, reason, belowFloor }) => {
      if (belowFloor !== undefined) askedFloor = true
      const answer = await confirm(`The release channel cannot confirm that ${release} is current (${reason}).${belowFloor === undefined ? '' : ` Release ${release} is older than release ${belowFloor}, which this home has installed or seen the channel offer.`} Install ${release} from ${line.from} on its signature and release-log entry alone? [y/N]`)
      assertAnswered(answer)
      return true
    },
  }
  return { install, asked: () => askedFloor }
}

/** A refusal that stops a repair before it changes anything it cannot put back. */
class RepairRefusal extends Error {
  /** What the launcher prints. */
  readonly refusal: Refusal

  /** @param refusal - the refusal. */
  constructor(refusal: Refusal) {
    super(refusal.lead)
    this.refusal = refusal
    this.name = 'RepairRefusal'
  }
}

const REDACTOR = new Redactor()

/**
 * Refuse while a home process runs, naming `delorun stop`.
 * @param home - the resolved Delorun home.
 * @param entries - the names under the home's `run/`.
 * @throws {RepairRefusal} `HOME_RUNNING`.
 */
function refuseWhileRunning(home: string, entries: readonly string[]): void {
  for (const name of entries) {
    let record
    try {
      record = readHomeLock(join(home, DELORUN_HOME_ENTRIES.run, name))
    } catch (_notALock) {
      // A directory under run/ that holds no lock record of a home process, such as the data users' registrations.
      continue
    }
    if (record !== undefined && holderAlive(record)) {
      throw new RepairRefusal({
        lead: `Delorun did not repair: the home process of the profile ${name} is running (process ${String(record.pid)}), so the program cannot be replaced.`,
        reason: 'HOME_RUNNING',
        remedies: [`Stop it, then run the repair again: delorun stop${profileOption({ profile: name })}`],
      })
    }
  }
}

/**
 * Take the home lock of the launcher's profile and of every other profile whose run directory holds a lock record, so
 * no runtime starts while the program store is set aside. A profile whose lock a live process holds is refused as
 * running; a stale lock is replaced.
 * @param options - the repair's inputs.
 * @param entries - the names under the home's `run/`.
 * @returns the held locks, which the caller releases.
 * @throws {RepairRefusal} `HOME_RUNNING` when a start took a lock after the check above.
 */
async function holdHomeLocks(options: RepairOptions, entries: readonly string[]): Promise<HomeLock[]> {
  const profiles = new Set([options.profile])
  for (const name of entries) {
    try {
      if (readHomeLock(join(options.home, DELORUN_HOME_ENTRIES.run, name)) !== undefined) profiles.add(name)
    } catch (_notALock) {
      // A directory under run/ that is not a profile's run directory.
    }
  }
  const held: HomeLock[] = []
  const runtime = await options.store.pointers().then(pointers => pointers.current, () => parseRuntimeVersion('0.0.0')!)
  try {
    for (const profile of profiles) {
      const directory = runDirectory(options.home, profile)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      held.push(await acquireHomeLock({ runDirectory: directory, runtime, probe: () => Promise.resolve('silent'), startId: newStartId() }))
    }
  } catch (error) {
    for (const lock of held) lock.release()
    throw new RepairRefusal({
      lead: 'Delorun did not repair: a Delorun process started for a profile while the repair began, so the program cannot be replaced.',
      reason: `HOME_RUNNING: ${messageOf(error)}`,
      remedies: ['Stop it, then run the repair again: delorun stop'],
    })
  }
  return held
}

/**
 * The release channel this home updates from: the channel its installed release's signed manifest names. A home whose
 * installed manifest is missing or does not verify has no readable channel and repairs from `stable`.
 * @param home - the resolved Delorun home.
 * @param store - the home's store.
 * @param roots - the root files this launcher ships, which verify the manifest when the home stores no root.
 * @returns the channel.
 */
export async function installedChannel(home: string, store: Pick<RepairStore, 'paths' | 'pointers'>, roots: readonly Uint8Array[]): Promise<ReleaseChannel> {
  try {
    const current = (await store.pointers()).current
    const root = readRoot(await readStoredRootBytes(home) ?? roots.at(-1)!).metadata
    return verifySignedManifest(root, await readFile(store.paths.releaseFiles(current).manifest)).channel
  } catch (_unreadable) {
    // No installed release, or its manifest does not verify: the home has no readable channel.
    return 'stable'
  }
}

/** The release the stored timestamp names for the home's channel, which is the lowest a repair installs. */
async function storedFloor(home: string, channel: ReleaseChannel): Promise<string | undefined> {
  const stored = await readStoredTimestamp(home)
  if (stored === undefined) return undefined
  const envelope = JSON.parse(Buffer.from(stored.bytes).toString('utf8')) as { signed?: { channels?: Record<string, { release?: unknown }> } }
  const release = envelope.signed?.channels?.[channel]?.release
  return typeof release === 'string' ? release : undefined
}

/**
 * Whether `--reset-trust` may run: the stored root does not chain from the roots this launcher ships and the newest
 * shipped root is newer than the stored one.
 * @param options - the repair's inputs.
 * @throws {RepairRefusal} `RESET_TRUST_REFUSED` when the shipped chain is not newer or the stored root still chains.
 */
async function assertResetTrustAllowed(options: RepairOptions): Promise<void> {
  const stored = await readStoredRootBytes(options.home)
  const refuse = (why: string): RepairRefusal => new RepairRefusal({
    lead: 'Delorun did not reset the trust records: this launcher has no newer release keys than the ones this home already trusts.',
    reason: `RESET_TRUST_REFUSED: ${why}`,
    remedies: ['Run npx delorun@latest repair --reset-trust again after installing a newer launcher from npm, or follow the steps by hand in the troubleshooting guide.'],
  })
  if (stored === undefined) throw refuse('this home stores no root, so there is nothing to reset')
  const shipped = options.roots.map(bytes => readRoot(bytes).metadata.version)
  const newestShipped = Math.max(...shipped)
  if (newestShipped <= readRoot(stored).metadata.version) throw refuse(`this launcher ships root ${String(newestShipped)}, and the home's stored root is root ${String(readRoot(stored).metadata.version)}`)
  let walked: readonly Uint8Array[]
  try {
    walked = await readStoredRootChain(options.home)
    for (const bytes of walked) readRoot(bytes)
  } catch (error) {
    // A chain that cannot be read says nothing about whether the stored root chains, so the gate stays shut.
    throw new RepairRefusal({
      lead: 'Delorun did not reset the trust records: the chain of release keys stored in this home cannot be read.',
      reason: `RESET_TRUST_REFUSED: ${messageOf(error)}`,
      remedies: ['Follow the steps by hand in the troubleshooting guide to move trust/ aside.'],
    })
  }
  try {
    verifyStoredRoot({ stored, shipped: options.roots, walked, source: 'trust/root.json' })
  } catch (error) {
    // Only the stored root's failure to chain from a shipped root opens the gate; any other failure leaves it shut.
    if (isInstallError(error, 'INSTALL_VERIFY_FAILED')) return
    throw error
  }
  throw refuse('the stored root chains from a root this launcher ships, so the home still trusts the same keys')
}

/** The steps to undo, newest first, when a later step fails. */
type Undo = () => Promise<void>

/**
 * Run `delorun repair`.
 * @param options - the home, the flags, the store, the channel, the prompt and the output.
 * @returns the launcher's exit code: `0` when the program was replaced, `1` for a refusal.
 */
export async function runRepair(options: RepairOptions): Promise<number> {
  const log: Record<string, unknown> = { time: options.now().toISOString(), command: ['repair', ...options.line.release === undefined ? [] : ['--release', options.line.release], ...options.line.from === undefined ? [] : ['--from', options.line.from], ...options.line.restoreCopy ? ['--restore-copy'] : [], ...options.line.resetTrust ? ['--reset-trust'] : []].join(' '), moved: [] as string[], checks: [] as string[] }
  let outcome = 'refused'
  const undo: Undo[] = []
  const holds: HomeLock[] = []
  let endRecord: (() => Promise<void>) | undefined
  try {
    const recorded = await recordRepair(options, log)
    endRecord = recorded.end
    await repair(options, log, undo, holds, recorded)
    outcome = 'repaired'
    options.progress?.finish('start Delorun with: delorun')
    return LAUNCHER_EXIT.ok
  } catch (error) {
    for (const step of undo.reverse()) await step().catch((undoError: unknown) => options.output.stderr(`Delorun could not put a step back: ${messageOf(undoError)}\n`))
    options.progress?.fail()
    const refusal = error instanceof RepairRefusal ? { text: renderLauncherRefusal(error.refusal), exit: LAUNCHER_EXIT.failed } : refusalFor(error, { home: options.home, profile: options.profile })
    log.reason = error instanceof RepairRefusal ? error.refusal.lead : messageOf(error)
    options.output.stderr(refusal.text)
    return refusal.exit
  } finally {
    for (const hold of holds) hold.release()
    await endRecord?.().catch((error: unknown) => options.output.stderr(`Delorun could not remove run/${REPAIR_RECORD_FILE}, which makes every start refuse until it is removed: ${messageOf(error)}\n`))
    log.outcome = outcome
    await writeLog(options.home, log).catch((error: unknown) => options.output.stderr(`Delorun could not write logs/repair.log: ${messageOf(error)}\n`))
  }
}

/**
 * Mark the home as being repaired, reporting a record a dead repair left.
 * @param options - the repair's inputs.
 * @param log - the run's record.
 * @returns the function that removes the mark and the one that records where the old store is set aside.
 * @throws {RepairRefusal} `REPAIR_RUNNING` when another repair of this home runs.
 */
async function recordRepair(options: RepairOptions, log: Record<string, unknown>): Promise<Pick<Awaited<ReturnType<typeof beginRepairRecord>>, 'end' | 'noteSetAside' | 'noteTrustSetAside'>> {
  let begun
  try {
    begun = await beginRepairRecord(options.home, options.now(), options.repairMarkGraceSeconds)
  } catch (error) {
    throw new RepairRefusal({
      lead: 'Delorun did not repair: another repair of this home is running.',
      reason: `REPAIR_RUNNING: ${messageOf(error)}`,
      remedies: ['Wait for it to finish, then run the repair again if it is still needed.'],
    })
  }
  if (begun.found.kind === 'stale') {
    const text = await staleRepairText(begun.found.record, options.home, options.now())
    options.output.stderr(`${text}\n`)
    log.staleRepair = text
  }
  return { end: begun.end, noteSetAside: begun.noteSetAside, noteTrustSetAside: begun.noteTrustSetAside }
}

/**
 * Append the run's one record to `logs/repair.log` at mode 0600, redacted.
 * @param home - the resolved Delorun home.
 * @param record - the record.
 */
async function writeLog(home: string, record: Record<string, unknown>): Promise<void> {
  const directory = join(home, 'logs')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await appendFile(join(directory, 'repair.log'), REDACTOR.text(`${JSON.stringify(record)}\n`), { mode: 0o600 })
}

/** Print a line to the person and keep it in the run's record. */
function say(options: RepairOptions, log: Record<string, unknown>, text: string): void {
  options.output.stdout(`${text}\n`)
  ;(log.checks as string[]).push(text)
}

/**
 * The repair's steps.
 * @param options - the repair's inputs.
 * @param log - the run's record.
 * @param undo - collects the steps that put a change back.
 * @param holds - collects the home locks, which the caller releases last.
 * @param marks - record in the repair mark the path the old program store, and with `--reset-trust` the old trust records, are set aside to, before each moves.
 * @throws {RepairRefusal} for every refusal the repair itself makes; the store's and install's own errors otherwise.
 */
async function repair(options: RepairOptions, log: Record<string, unknown>, undo: Undo[], holds: HomeLock[], marks: Pick<Awaited<ReturnType<typeof beginRepairRecord>>, 'noteSetAside' | 'noteTrustSetAside'>): Promise<void> {
  const { home, line, store } = options
  const entries = await readdir(join(home, DELORUN_HOME_ENTRIES.run)).catch(() => [] as string[])
  refuseWhileRunning(home, entries)
  holds.push(...await holdHomeLocks(options, entries))
  const runtimes = join(home, DELORUN_HOME_ENTRIES.runtimes)
  const trust = join(home, DELORUN_HOME_ENTRIES.trust)
  const stampNow = stamp(options.now())
  const installed = await store.pointers().then(pointers => pointers.current, () => undefined)
  const floorFromTimestamp = await storedFloor(home, options.releaseChannel)

  if (line.resetTrust) {
    await assertResetTrustAllowed(options)
    const answer = await options.confirm('This launcher trusts release keys that this home did not know. Continue only if you installed it with npx delorun@latest from npm yourself. Move the home\'s trust records aside and trust only this launcher\'s keys? [y/N]')
    assertAnswered(answer)
    const aside = join(home, trustSetAsideName(stampNow))
    await marks.noteTrustSetAside(aside)
    await rename(trust, aside)
    await mkdir(trust, { mode: 0o700 })
    undo.push(async () => { await rm(trust, { recursive: true, force: true }); await rename(aside, trust) })
    ;(log.moved as string[]).push(`trust -> ${aside}`)
  }

  const release = await options.channel.resolve(line.release)
  const floor = [installed, floorFromTimestamp].filter((value): value is string => value !== undefined && semver.valid(value) !== null).sort(semver.compare).at(-1)
  const below = floor !== undefined && semver.lt(release.version, floor)
  if (below && line.release !== undefined && line.from !== undefined) {
    if (options.belowFloorAsked?.() !== true) {
      const lower = await options.confirm(`Release ${release.version} is older than release ${floor}, which this home has installed or seen the channel offer, and you named it. Install ${release.version} from ${line.from} on its signature and release-log entry alone? [y/N]`)
      assertAnswered(lower)
    }
  } else if (below) {
    throw new RepairRefusal({
      lead: `Delorun did not repair: release ${release.version} is older than release ${floor}, which this home has already installed or seen the channel offer.`,
      reason: 'TARGET_LOWER',
      remedies: ['To go back to the release before the last update, use delorun recover rollback.'],
    })
  }
  log.versions = { installed: installed ?? null, target: release.version }

  const kept = `Your chats, settings and keys stay${line.restoreCopy ? '; today\'s chats are set aside and the chat-data copy taken before the release that wrote them is put back' : ''}.`
  const answer = await options.confirm(`Replace the installed program ${installed ?? '(none)'} with ${release.version}? ${kept} [y/N]`)
  assertAnswered(answer)

  const probe = await readdir(runtimes).then(() => true, () => false)
  const aside = join(home, runtimesSetAsideName(stampNow))
  if (probe) {
    await marks.noteSetAside(aside)
    await rename(runtimes, aside)
    undo.push(async () => { await rm(runtimes, { recursive: true, force: true }); await rename(aside, runtimes) })
    ;(log.moved as string[]).push(`runtimes -> ${aside}`)
  }
  await mkdir(runtimes, { mode: 0o700 })

  const runtime = await store.install({
    version: release.version,
    root: release.root,
    fill: async (directory) => {
      const files = await options.channel.fill(release, directory)
      options.progress?.handle({ step: 'installing', version: release.version })
      return files
    },
  })
  await options.channel.recordInstalled(release)
  options.progress?.handle({ step: 'installed', version: release.version })
  say(options, log, `Installed release ${release.version}, verified against its signed manifest and the release log.`)

  const copy = await dataGuard(options, release.version, runtime, below, log)
  await options.startCheck(release.version, release.root)
  say(options, log, `Release ${release.version} passed its start check.`)
  if (copy !== undefined) {
    const restored = await restoreDataCopy(home, copy, options.now())
    // The data guard accepted the copy, so its formats are readable; the home's record now names the copy's facts.
    if (copy.formats.from !== null) await writeHomeDataFormat(home, { schema: HOME_DATA_FORMAT_SCHEMA, delorun: copy.from, dsh: runtime.manifest.dsh, formats: copy.formats.from })
    ;(log.moved as string[]).push(`sessions and storages -> ${restored.setAside}`)
    say(options, log, `Put back the chat-data copy taken before Delorun ${copy.to}. Today's chats are kept in ${restored.setAside}.`)
  }
  say(options, log, probe
    ? `The old program is kept in ${aside}. delorun recover status lists it, and delorun recover discard ${aside.slice(home.length + 1)} removes it.`
    : 'The home held no program store, so nothing was set aside.')
}

/** Stop unless the person said yes. */
function assertAnswered(answer: boolean | undefined): void {
  if (answer === undefined) {
    throw new RepairRefusal({ lead: 'Delorun did not repair: it needs a terminal to ask you before it replaces the program, and there is none.', reason: 'NO_TERMINAL', remedies: ['Run npx delorun@latest repair in a terminal. There is no --yes for repair.'] })
  }
  if (!answer) throw new RepairRefusal({ lead: 'Delorun did not repair: you did not confirm, so nothing was changed.', remedies: [] })
}

/**
 * Compare the installed release's data formats with the home's record.
 * @param options - the repair's inputs.
 * @param version - the installed release.
 * @param runtime - the verified runtime.
 * @param log - the run's record.
 * @returns the session-data copy to put back, when `--restore-copy` was asked and the guard needs it.
 * @throws {RepairRefusal} `DATA_NEWER` when a newer or unordered format wrote the home's data and no restore was asked.
 */
async function dataGuard(options: RepairOptions, version: RuntimeVersion, runtime: VerifiedRuntime, below: boolean, log: Record<string, unknown>): Promise<Awaited<ReturnType<typeof readCopyRecord>>> {
  const record = await readHomeDataFormat(options.home)
  const formats = await readDataFormats(options.store.paths.version(version))
  const relation = relateHomeData(record, { dsh: runtime.manifest.dsh, formats })
  log.dataGuard = relation
  if (relation === 'same' || relation === 'older') {
    say(options, log, `The home's data was written by Delorun ${record?.delorun ?? 'unknown'}, which release ${version} reads.`)
    return undefined
  }
  if (record === undefined) {
    say(options, log, `This home has no data-format record, as a home made before the record existed has none, so Delorun cannot tell which release wrote its chats. It assumes they are in the formats release ${version} reads, and continued.`)
    return undefined
  }
  if (relation === 'unknown') {
    throw new RepairRefusal({
      lead: `Delorun did not repair: Delorun cannot tell whether release ${version} reads this home's chats, which Delorun ${record.delorun} wrote.`,
      reason: `DATA_UNREADABLE: ${unreadableFacts(record.dsh, runtime.manifest.dsh, formats, version)}`,
      remedies: [`Install ${record.delorun} or newer instead: npx delorun@latest repair`],
    })
  }
  const writer = record.delorun
  const copy = options.line.restoreCopy ? await readCopyRecord(options.home, writer) : undefined
  if (copy !== undefined) {
    // The copy records no DSH version, so only its data formats are ordered against the release's.
    const copyRelation = copy.formats.from === null ? 'unknown' : relateHomeData({ ...record, delorun: copy.from, formats: copy.formats.from }, { dsh: record.dsh, formats })
    if (copyRelation !== 'same' && copyRelation !== 'older') {
      throw new RepairRefusal({
        lead: `Delorun did not repair: the chat-data copy taken before Delorun ${writer} is not in a format release ${version} reads.`,
        reason: `DATA_COPY_NEWER: the copy's data formats are ${copyRelation === 'unknown' ? 'unreadable' : `${copyRelation} than release ${version} reads`}`,
        remedies: [`Install ${writer} or newer instead: npx delorun@latest repair`],
      })
    }
    log.dataGuard = `${relation}; restoring a copy that is ${copyRelation}`
    return copy
  }
  const fromFlag = below ? ` --from ${options.line.from ?? '<folder or https: address>'}` : ''
  throw new RepairRefusal({
    lead: `Delorun did not repair: release ${version} may not read this home's chats, which Delorun ${writer} wrote.`,
    reason: `DATA_NEWER: the home's data-format record shows ${relation} data than release ${version} reads${options.line.restoreCopy ? `, and the home keeps no chat-data copy for Delorun ${writer}` : ''}`,
    remedies: [
      `Install ${writer} or newer instead: npx delorun@latest repair`,
      `Put back the copy taken before ${writer} (data-copies/${writer}/) and keep today's chats aside: npx delorun@latest repair --release ${version} --restore-copy${fromFlag}`,
    ],
  })
}

/** What the data guard could not read, for its refusal. */
function unreadableFacts(homeDsh: string, releaseDsh: string, formats: unknown, version: RuntimeVersion): string {
  const missing: string[] = []
  if (formats === undefined) missing.push(`release ${version} has no readable data-formats.json`)
  if (semver.valid(homeDsh) === null) missing.push(`the home's record names DSH version ${homeDsh}, which is not a version`)
  if (semver.valid(releaseDsh) === null) missing.push(`release ${version} names DSH version ${releaseDsh}, which is not a version`)
  return missing.join('; ')
}

/**
 * Read `delorun repair`'s flags from the arguments the launcher did not take as its own.
 * @param runtimeArgs - the arguments the launcher keeps for the runtime, `repair` and any `--profile` included.
 * @param release - the `--release` value the launcher parsed.
 * @returns the flags.
 * @throws {Error} for an argument `repair` does not take, or a `--from` with no value.
 */
export function parseRepairLine(runtimeArgs: readonly string[], release: RuntimeVersion | undefined): RepairLine {
  let from: string | undefined
  let restoreCopy = false
  let resetTrust = false
  let seenCommand = false
  for (let at = 0; at < runtimeArgs.length; at++) {
    const argument = runtimeArgs[at]!
    if (argument === '--profile') at++
    else if (argument.startsWith('--profile=')) continue
    else if (argument === 'repair' && !seenCommand) seenCommand = true
    else if (argument === '--restore-copy') restoreCopy = true
    else if (argument === '--reset-trust') resetTrust = true
    else if (argument === '--from' || argument.startsWith('--from=')) {
      const value = argument === '--from' ? runtimeArgs[++at] : argument.slice('--from='.length)
      if (value === undefined || value === '') throw new Error('--from needs a folder or an https: address')
      from = value
    } else throw new Error(`delorun repair takes --release, --from, --restore-copy, --reset-trust and --profile, not ${argument}`)
  }
  return { restoreCopy, resetTrust, ...release === undefined ? {} : { release }, ...from === undefined ? {} : { from } }
}
