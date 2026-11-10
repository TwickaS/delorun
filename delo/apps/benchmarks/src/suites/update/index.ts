/**
 * The update suite: how long a real `delorun update` takes, step by step, from one local release to the next, and how
 * long the ways back take. Each repetition copies a home the run's launcher installed from release `from`, starts its
 * home process with {@link ./home-driver.mjs}, and runs the commands a person runs through the launcher:
 * `delorun update --check` where the scenario measures it, `delorun update --yes`, and `delorun recover rollback`
 * where the scenario rolls back. The steps are timed from three sources and none changes the product's behaviour:
 * the driver's timing records around the update support's calls, the home log's records of the predecessor and the
 * successor, and the times the command's own lines arrived.
 *
 * @module @delo/benchmarks/suites/update
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readLines, resolveSurface } from '@delo/logs'
import { addPlugins } from '../../fixtures/data.ts'
import { copyHome, deloRequest, killLeftovers, PROFILE, startDriver, stopHome, type InstalledHome } from '../../fixtures/home.ts'
import { INSTALLED_VERSION, installedChannel, templateHome } from '../../fixtures/releases.ts'
import { expectSuccess, firstMatch, run, type Finished, type TimedLine } from '../../harness/processes.ts'
import { Samples, type ScenarioResult, type Skipped, type SuiteResult } from '../../harness/result.ts'
import type { BenchRoot } from '../../harness/roots.ts'
import type { Suite, SuiteContext } from '../../harness/suite.ts'

/** The driver module the home process runs. */
const DRIVER = fileURLToPath(new URL('./home-driver.mjs', import.meta.url))

/** The release a home starts on, and the two it updates to. */
export const VERSIONS = { from: INSTALLED_VERSION, same: '0.1.1', changed: '0.2.0' } as const

/** How long a home process may take to boot before a repetition fails. */
const BOOT_TIMEOUT_MS = 300_000

/** How long one command may take. */
const COMMAND_TIMEOUT_MS = 600_000

/** The measured items of an update, in report order, with what each spans. */
export const UPDATE_ITEMS: Readonly<Record<string, string>> = {
  'total': 'From the command starting to the update committing: the target runs and passed its health check',
  'command': 'From the command starting to the command exiting',
  'cli-start': 'The launcher\'s start check, the runtime\'s start and the CLI asking the home process to prepare',
  'running-check': 'The start check of the running release before the channel opens',
  'channel-index': 'Fetching the channel\'s timestamp and verifying it and the root chain',
  'release-verify': 'Fetching the manifest and its log bundle and verifying the signature',
  'log-verify': 'The release-log check: the checkpoint and the consistency proof from the log\'s tiles',
  'download': 'Downloading the runtime archive and checking it against the manifest',
  'unpack': 'Fetching and verifying the file list and unpacking the archive into staging',
  'store-install': 'The store checking the staged files and moving them into the runtime store',
  'report': 'Building the update report',
  'report-target': 'The report reading the target: its bundle tables, read by the target\'s own Node, and its bundles',
  'report-data': 'The report comparing data formats and sizing the copy',
  'report-profile': 'The report reading the profile\'s plugins, bundles and layers',
  'confirm': 'From the prepared report reaching the command to the command applying it',
  'snapshot': 'Saving the profile snapshot',
  'drain': 'Waiting for running chats with new turns refused',
  'stop-host': 'Stopping the running Host',
  'data-copy': 'Writing the session-data copy',
  'switch': 'Switching the runtime pointers',
  'target-boot': 'Starting the target\'s home process and booting its Host',
  'health-check': 'The target\'s health check, from its Host booting to the update committing',
  'handover': 'From the commit to the target taking over the lock and the update channel',
  'check': '`delorun update --check` from start to exit, which fetches, verifies and installs the target without applying it',
  'rollback': '`delorun recover rollback` from start to exit',
  'rollback-switch': 'The rollback from its switching phase to its health check: Host stop, data and profile restore, switch',
  'rollback-target': 'The rollback from its health check to the command exiting: the previous release starting and passing its check',
}

/** One scenario's workload. */
interface UpdateScenario {
  readonly id: string
  readonly description: string
  /** How many chats the home holds: the small or the large set. */
  readonly chats: 'small' | 'large'
  /** How many synthetic plugins the profile holds. */
  readonly plugins: 'none' | 'many'
  /** Whether the target's data format differs, which takes the session-data copy. */
  readonly format: 'same' | 'changed'
  /** Whether `update --check` runs first, so the update finds the target in the store. */
  readonly store: 'cold' | 'warm'
  /** Whether a rollback follows the update. */
  readonly rollback: boolean
}

/** The suite's scenarios. */
export const UPDATE_SCENARIOS: readonly UpdateScenario[] = [
  { id: 'same-format', description: 'Same data format, so no copy; small chat set; cold store; then a rollback with no copy to restore', chats: 'small', plugins: 'none', format: 'same', store: 'cold', rollback: true },
  { id: 'changed-format', description: 'Changed data format, so the copy is taken; small chat set; cold store; then a rollback that restores the copy', chats: 'small', plugins: 'none', format: 'changed', store: 'cold', rollback: true },
  { id: 'changed-format-large', description: 'Changed data format with the large chat set, so the copy dominates; cold store; then a rollback that restores the copy', chats: 'large', plugins: 'none', format: 'changed', store: 'cold', rollback: true },
  { id: 'many-plugins', description: 'Same data format with many installed plugins, so the report reads each; cold store', chats: 'small', plugins: 'many', format: 'same', store: 'cold', rollback: false },
  { id: 'warm-store', description: '`update --check` first (cold store), then the update finds the target already installed', chats: 'small', plugins: 'none', format: 'same', store: 'warm', rollback: false },
]

/** One driver timing record. */
interface Mark {
  readonly event: string
  readonly at: number
}

/** One home log record's time and message. */
interface LogMark {
  readonly at: number
  readonly msg: string
  readonly pid: number
  readonly phase: string | undefined
}

/**
 * Read the driver's timing records.
 * @param path - the file.
 * @returns the records.
 */
export function readMarks(path: string): readonly Mark[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Mark)
}

/**
 * Read the home log's records of a home.
 * @param deloHome - the Delo home.
 * @returns each record's time, message, process and update phase.
 */
export function readHomeLog(deloHome: string): readonly LogMark[] {
  return readLines(resolveSurface({ kind: 'home', home: deloHome, profile: PROFILE }), 100_000, line => line.record !== undefined).map(({ record }) => {
    const data = (record as { readonly data?: { readonly phase?: unknown } }).data
    return { at: Date.parse(record!.ts), msg: record!.msg, pid: record!.pid, phase: typeof data?.phase === 'string' ? data.phase : undefined }
  })
}

/** Reads the times of the update's steps. */
export class UpdateTimeline {
  /**
   * @param since - the command's start; earlier records belong to an earlier command.
   * @param marks - the driver's records.
   * @param logs - the home log's records.
   */
  constructor(private readonly since: number, private readonly marks: readonly Mark[], private readonly logs: readonly LogMark[]) {}

  /**
   * The first driver record of an event at or after the command's start.
   * @param event - the event.
   * @returns its time, or `undefined`.
   */
  mark(event: string): number | undefined {
    return this.marks.find(mark => mark.event === event && mark.at >= this.since)?.at
  }

  /**
   * The last driver record of an event at or after the command's start.
   * @param event - the event.
   * @returns its time, or `undefined`.
   */
  lastMark(event: string): number | undefined {
    return this.marks.filter(mark => mark.event === event && mark.at >= this.since).at(-1)?.at
  }

  /**
   * The first driver record whose event starts with a prefix and ends with a suffix.
   * @param prefix - the prefix.
   * @param suffix - the suffix.
   * @returns its time, or `undefined`.
   */
  firstOf(prefix: string, suffix: string): number | undefined {
    return this.marks.find(mark => mark.event.startsWith(prefix) && mark.event.endsWith(suffix) && mark.at >= this.since)?.at
  }

  /**
   * The duration between a call's first start and its last end.
   * @param call - the call's prefix, such as `copies.save`.
   * @returns the milliseconds, or `undefined`.
   */
  span(call: string): number | undefined {
    return difference(this.mark(`${call}:start`), this.lastMark(`${call}:end`))
  }

  /**
   * The first home log record of a message at or after the command's start.
   * @param message - the message.
   * @returns its time, or `undefined`.
   */
  log(message: string): number | undefined {
    return this.logs.find(log => log.msg === message && log.at >= this.since)?.at
  }

  /**
   * The first `update phase` record of a phase at or after the command's start.
   * @param phase - the phase.
   * @returns its time, or `undefined`.
   */
  phase(phase: string): number | undefined {
    return this.logs.find(log => log.msg === 'update phase' && log.phase === phase && log.at >= this.since)?.at
  }
}

/**
 * The milliseconds between two times when both are known and in order.
 * @param from - the earlier time.
 * @param to - the later time.
 * @returns the difference, or `undefined`.
 */
export function difference(from: number | undefined, to: number | undefined): number | undefined {
  return from === undefined || to === undefined || to < from ? undefined : to - from
}

/**
 * The items of one `update --yes`.
 * @param command - the finished command.
 * @param timeline - the step times.
 * @param copied - whether the scenario takes the copy.
 * @returns each item that could be measured.
 */
export function updateItems(command: Finished, timeline: UpdateTimeline, copied: boolean): Record<string, number> {
  const t0 = command.startedAt
  const committed = timeline.log('update committed')
  const prepared = timeline.lastMark('store.prepare:end')
  const filled = timeline.lastMark('channel.fill:end')
  const reportStart = timeline.firstOf('report.', ':start')
  const switching = timeline.phase('switching')
  const healthCheck = timeline.phase('health-check')
  const booted = timeline.log('the Host booted on the new runtime; checking its health')
  const applyStart = copied ? timeline.mark('copies.plan:start') : timeline.mark('snapshots.save:start')
  const archiveDownloaded = timeline.lastMark('download.file:end')
  const candidates: Record<string, number | undefined> = {
    'total': difference(t0, committed),
    'command': command.endedAt - t0,
    'cli-start': difference(t0, timeline.mark('store.prepare:start')),
    'running-check': timeline.span('channel.open'),
    'channel-index': difference(timeline.mark('channel.resolve:start'), timeline.mark('install.resolved')),
    'release-verify': difference(timeline.mark('install.resolved'), timeline.mark('install.signature-checked')),
    'log-verify': difference(timeline.mark('install.signature-checked'), timeline.mark('install.log-checked')),
    'download': difference(timeline.mark('download.file:start'), archiveDownloaded),
    'unpack': difference(archiveDownloaded, filled),
    'store-install': difference(filled, reportStart),
    'report': difference(reportStart, prepared),
    'report-target': timeline.span('report.target'),
    'report-data': timeline.span('report.data'),
    'report-profile': timeline.span('report.profile'),
    'confirm': difference(prepared, applyStart),
    'snapshot': timeline.span('snapshots.save'),
    'drain': difference(timeline.phase('waiting'), switching),
    'stop-host': difference(switching, copied ? timeline.mark('copies.save:start') : timeline.mark('store.switchTo:start')),
    'data-copy': copied ? timeline.span('copies.save') : undefined,
    'switch': timeline.span('store.switchTo'),
    'target-boot': difference(healthCheck, booted),
    'health-check': difference(booted, committed),
    'handover': difference(committed, timeline.log('took over from the previous runtime')),
  }
  return Object.fromEntries(Object.entries(candidates).filter((entry): entry is [string, number] => entry[1] !== undefined))
}

/**
 * The items of one `recover rollback`.
 * @param command - the finished command.
 * @returns each item that could be measured from its lines.
 */
export function rollbackItems(command: Finished): Record<string, number> {
  const at = (pattern: RegExp): number | undefined => firstMatch(command.lines, pattern)?.at
  const switching = at(/^… switching$/u)
  const health = at(/^… health-check$/u)
  const items: Record<string, number | undefined> = {
    'rollback': command.endedAt - command.startedAt,
    'rollback-switch': difference(switching, health),
    'rollback-target': difference(health, command.endedAt),
  }
  return Object.fromEntries(Object.entries(items).filter((entry): entry is [string, number] => entry[1] !== undefined))
}

/** What a scenario's repetitions share: the template home and the channel naming the target. */
interface Prepared {
  readonly template: BenchRoot
  readonly target: string
  readonly parameters: Readonly<Record<string, string | number | boolean>>
}

/** The suite. */
export const updateSuite: Suite = {
  id: 'update',
  title: 'Update and rollback',
  items: UPDATE_ITEMS,
  scenarios: UPDATE_SCENARIOS.map(({ id, description }) => ({ id, description })),
  async run(context: SuiteContext, selected: readonly string[]): Promise<SuiteResult> {
    const skipped: Skipped[] = []
    const fixtures = await context.fixtures()
    const from = await installedChannel(fixtures)
    const channels = {
      same: await fixtures.channel.publish('update-same', [await fixtures.closure(VERSIONS.same, 'base')], from),
      changed: await fixtures.channel.publish('update-changed', [await fixtures.closure(VERSIONS.changed, 'changed')], from),
    }
    if (!context.machine.clone) skipped.push({ item: 'file-system clone', reason: `the roots' file system (${context.machine.fileSystem}) does not clone files, so every copy is a full copy; rerun with --root-base on a file system that clones (Btrfs, XFS with reflink, APFS) to measure clones` })
    const chats = (scenario: UpdateScenario): number => scenario.chats === 'small' ? context.options.chatsSmall : context.options.chatsLarge
    const template = (scenario: UpdateScenario): Promise<BenchRoot> => templateHome(context, `chats-${String(chats(scenario))}-plugins-${scenario.plugins}`, chats(scenario), (root) => {
      if (scenario.plugins === 'many') addPlugins(root.deloHome, context.options.plugins)
    })
    const results: ScenarioResult[] = []
    for (const scenario of UPDATE_SCENARIOS.filter(candidate => selected.includes(candidate.id))) {
      const prepared: Prepared = {
        template: await template(scenario),
        target: scenario.format === 'same' ? channels.same : channels.changed,
        parameters: {
          chats: chats(scenario),
          plugins: scenario.plugins === 'many' ? context.options.plugins : 0,
          dataCopy: scenario.format === 'changed',
          store: scenario.store,
          clone: context.machine.clone,
          from: VERSIONS.from,
          to: scenario.format === 'same' ? VERSIONS.same : VERSIONS.changed,
        },
      }
      results.push(await runScenario(context, scenario, prepared, fixtures.channel))
    }
    return { suite: 'update', scenarios: results, skipped }
  },
}

/**
 * Run one scenario's repetitions.
 * @param context - the suite context.
 * @param scenario - the scenario.
 * @param prepared - its template home and target channel.
 * @param channel - the run's channel.
 * @returns the scenario's result.
 */
async function runScenario(context: SuiteContext, scenario: UpdateScenario, prepared: Prepared, channel: Awaited<ReturnType<SuiteContext['fixtures']>>['channel']): Promise<ScenarioResult> {
  const samples = new Samples()
  const failures: string[] = []
  let completed = 0
  for (let repetition = 0; repetition < context.options.repeat; repetition++) {
    context.log(`update/${scenario.id}: repetition ${String(repetition + 1)} of ${String(context.options.repeat)}`)
    const root = context.newRoot()
    const home: InstalledHome = { root, launcher: channel.launcher }
    try {
      copyHome(prepared.template, root)
      channel.serve(prepared.target)
      samples.addAll(await repetitionItems(home, scenario, channel))
      completed++
    } catch (error) {
      failures.push(context.scrubber.scrub(error instanceof Error ? error.message : String(error)))
    } finally {
      await stopHome(home).catch(() => killLeftovers(root))
      root.dispose()
    }
  }
  return { scenario: scenario.id, description: scenario.description, parameters: prepared.parameters, completed, phases: samples.results(Object.keys(UPDATE_ITEMS)), failures }
}

/**
 * Wait until the driver reports the home process running.
 * @param timings - the driver's timing file.
 * @param exited - settles when the driver exits.
 * @throws {Error} when it exits first or the deadline passes.
 */
async function waitReady(timings: string, exited: Promise<Finished>): Promise<void> {
  let ended: Finished | undefined
  void exited.then((finished) => { ended = finished })
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (readMarks(timings).some(mark => mark.event === 'driver.ready')) return
    if (ended !== undefined) throw new Error(`the home process exited before it ran:\n${ended.lines.slice(-30).map((line: TimedLine) => line.text).join('\n')}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('the home process did not report running in time')
}

/**
 * One repetition: start the home process, update, and roll back where the scenario does.
 * @param home - the home copied from the template.
 * @param scenario - the scenario.
 * @param channel - the run's channel.
 * @returns the repetition's items.
 */
async function repetitionItems(home: InstalledHome, scenario: UpdateScenario, channel: Awaited<ReturnType<SuiteContext['fixtures']>>['channel']): Promise<Record<string, number>> {
  const timings = join(home.root.path, 'timings.jsonl')
  const driver = startDriver(home, VERSIONS.from, DRIVER, [channel.origin, channel.logOrigin, timings], 3_600_000)
  await waitReady(timings, driver.finished)
  const items: Record<string, number> = {}
  if (scenario.store === 'warm') {
    const check = expectSuccess(await run(deloRequest(home, ['update', '--check'], COMMAND_TIMEOUT_MS)), '`delorun update --check`')
    items.check = check.endedAt - check.startedAt
  }
  const update = expectSuccess(await run(deloRequest(home, ['update', '--yes'], COMMAND_TIMEOUT_MS)), '`delorun update --yes`')
  if (!update.lines.some(line => / runs now\./u.test(line.text))) throw new Error(`\`delorun update --yes\` did not commit:\n${update.lines.map(line => line.text).join('\n')}`)
  Object.assign(items, updateItems(update, new UpdateTimeline(update.startedAt, readMarks(timings), readHomeLog(home.root.deloHome)), scenario.format === 'changed'))
  if (scenario.rollback) {
    const rollback = expectSuccess(await run(deloRequest(home, ['recover', 'rollback'], COMMAND_TIMEOUT_MS)), '`delorun recover rollback`')
    Object.assign(items, rollbackItems(rollback))
  }
  return items
}
