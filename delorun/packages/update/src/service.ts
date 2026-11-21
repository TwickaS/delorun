/**
 * The report as a service of a Delorun process: `ctx.updateReport` reads the profile, the staged target and both
 * installations' status records from {@link ReportSources} and returns C3's report with the plugin ids the health check
 * holds the target to. It is the `UpdateReporter` the runtime store's `prepare` and `reportRollback` call
 * (`delorun/packages/runtime-store/src/seam.ts`), whose seam passes a version and the report's purpose and receives
 * `{ report, health, dataDiffers }`.
 *
 * The service owns no reader and no clock: the caller passes the sources, so a spec answers from fixtures and the
 * launcher's real reads stay behind their owner. One report is built at a time, and a second request for the version
 * already building joins it. The build is an effect of the context, so a disposed context returns no report: a caller
 * still waiting is refused with `REPORT_DISPOSED` rather than handed a report from a context that no longer exists.
 *
 * @module @delorun/update/service
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import semver from 'semver'
import type { UtcTimestamp } from '@delorun/contract-release-manifest'
import type { Installation, ReportVersions, UpdateReport } from '@delorun/contract-update-report'
import { UpdateReportError } from './errors.ts'
import type { DataFacts } from './data-formats.ts'
import type { InstallationStatusFacts, ProfileFacts, ReportInput, TargetFacts } from './facts.ts'
import type { HarnessFact } from './harness-items.ts'
import { predictBundleList } from './items.ts'
import { buildUpdateReport, disabledPluginNames } from './report.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Delorun's pre-update report; present while a process mounts {@link UpdateReportService}. */
    updateReport: UpdateReportService
  }
}

/**
 * What a report is for: `update` for an update's prepare, `rollback` for the report of a rollback to the runtime the
 * update replaced, which runs that runtime's own approved harness files and carries none.
 */
export type ReportPurpose = 'update' | 'rollback'

/** Where one report's facts come from: the profile, the staged target and both status records. */
export interface ReportSources {
  /**
   * The release the installation being updated runs.
   * @returns its Delorun, DSH and channel.
   */
  running(): Promise<ReportVersions>
  /**
   * Both installations' status records, as each writes them.
   * @returns the records; a record that is absent or unreadable is left out, and the report shows it as `unknown`.
   */
  statuses(): Promise<InstallationStatusFacts>
  /**
   * The profile as it is installed, before anything changes.
   * @returns its plugins, bundle list, layers and exemptions.
   */
  profile(): Promise<ProfileFacts>
  /**
   * The staged target release, after its files are installed and verified.
   * @param version - the installed target's version.
   * @returns its versions, checks, bundle facts and revocation list.
   */
  target(version: string): Promise<TargetFacts>
  /**
   * Both releases' data facts and the size of the session-data copy (C3, "Data formats").
   * @param version - the installed target's version.
   * @returns the facts.
   */
  data(version: string): Promise<DataFacts>
  /**
   * Each approved harness file of the running runtime and how it meets the staged target's verified file; read only
   * for an update's report.
   * @param version - the installed target's version.
   * @returns the files, in path order; none when the running runtime has no approved harness file.
   */
  harness(version: string): Promise<readonly HarnessFact[]>
  /**
   * The current time.
   * @returns the time the report is stamped with.
   */
  now(): UtcTimestamp
}

/** What C3's health check holds a target to, as one report predicts it. */
export interface ReportHealth {
  /** H3: the plugins the report names as disabled at boot. */
  readonly disabledPlugins: readonly string[]
  /** H3, H4: the rows the report names, by id or name. */
  readonly namedRows: readonly string[]
  /** H3, H4: the rows a bundle patch of the target disables, by id only. */
  readonly bundleRows: readonly string[]
  /** H5: the bundle list the report predicts. */
  readonly bundles: readonly string[]
}

/** A built report, with what the health check holds the target to and whether the data differs. */
export interface BuiltUpdateReport {
  /** C3's report, returned to the caller as it is. */
  readonly report: UpdateReport
  /** What the health check holds the target to. */
  readonly health: ReportHealth
  /** Whether the report holds a `data` item. */
  readonly dataDiffers: boolean
}

/**
 * Build one report from its sources: the reads run together, and the report is built from what they return.
 * @param installation - the installation being updated.
 * @param sources - where the facts come from.
 * @param version - the installed target's version.
 * @param purpose - whether the report is an update's or a rollback's.
 * @returns the report, what the health check holds the target to, and whether the data differs.
 * @throws {UpdateReportError} `REPORT_TARGET_UNVERIFIED` when the target did not pass every check.
 */
export async function buildFromSources(installation: Installation, sources: ReportSources, version: string, purpose: ReportPurpose): Promise<BuiltUpdateReport> {
  return builtReport(await readReportInput(installation, sources, version, purpose))
}

/**
 * Read every fact one report is built from; the reads run together. A rollback's report reads no harness facts.
 * @param installation - the installation being updated.
 * @param sources - where the facts come from.
 * @param version - the installed target's version.
 * @param purpose - whether the report is an update's or a rollback's.
 * @returns the report's input.
 */
export async function readReportInput(installation: Installation, sources: ReportSources, version: string, purpose: ReportPurpose): Promise<ReportInput> {
  const [from, statuses, profile, target, data, harness] = await Promise.all([
    sources.running(), sources.statuses(), sources.profile(), sources.target(version), sources.data(version),
    purpose === 'update' ? sources.harness(version) : [],
  ])
  return { installation, from, profile, target, statuses, data, harness, generated: sources.now() }
}

/**
 * Build one report from its input, with what the health check holds the target to.
 * @param input - the report's input.
 * @returns the report, what the health check holds the target to, and whether the data differs.
 * @throws {UpdateReportError} `REPORT_TARGET_UNVERIFIED` when the target did not pass every check.
 */
export function builtReport(input: ReportInput): BuiltUpdateReport {
  const report = buildUpdateReport(input)
  const { profile, target } = input
  return {
    report,
    health: {
      disabledPlugins: disabledPluginNames(report),
      // A row whose settings the target's bundle changes or adds is not named: H3 derives that change itself and holds the
      // row to exactly it. A row the target's bundle drops is named by its id, because nothing is left to compare.
      namedRows: report.items.flatMap(item => item.kind === 'row' && item.detail.bundlePatch !== true && item.detail.settings === undefined ? [item.subject.id ?? item.subject.name] : []),
      bundleRows: report.items.flatMap(item => item.kind === 'row' && (item.detail.bundlePatch === true || item.detail.settings?.change === 'removed') ? [item.subject.id ?? item.subject.name] : []),
      bundles: predictBundleList(profile.bundles, target.bundles),
    },
    dataDiffers: report.items.some(item => item.kind === 'data'),
  }
}

/** What the service needs. */
export interface UpdateReportOptions {
  /** The installation this process updates; the other one is shown beside it and never switches. */
  readonly installation: Installation
  /** Where the facts come from. */
  readonly sources: ReportSources
}

/** The report being built, so a second request for the same version and purpose joins it. */
interface Building {
  readonly version: string
  readonly purpose: ReportPurpose
  readonly done: Promise<BuiltUpdateReport>
}

/** The planner of contract C3's pre-update report. */
export class UpdateReportService extends Service {
  private queue: Promise<unknown> = Promise.resolve()

  private building: Building | undefined

  private disposed = false

  /** The installation and the sources. */
  private readonly options: UpdateReportOptions

  /**
   * @param ctx - the context that owns the service and the build.
   * @param options - the installation and the sources.
   */
  constructor(ctx: Context, options: UpdateReportOptions) {
    super(ctx, 'updateReport')
    this.options = options
    this.ctx.effect(() => () => this.dispose(), 'update: the pre-update report')
  }

  /**
   * Build the report for an installed, verified target.
   * @param version - the target's installed version.
   * @param purpose - whether the report is an update's or a rollback's.
   * @returns the report and the plugin ids it disables.
   * @throws {UpdateReportError} `REPORT_VERSION_INVALID` when the version is not a semantic version;
   *   `REPORT_DISPOSED` when the context is disposed before the report is returned; `REPORT_TARGET_UNVERIFIED` when
   *   the target did not pass every check.
   */
  async build(version: string, purpose: ReportPurpose): Promise<BuiltUpdateReport> {
    if (semver.valid(version) === null) throw new UpdateReportError('REPORT_VERSION_INVALID', `${JSON.stringify(version)} is not a semantic version`)
    this.assertLive()
    if (this.building?.version === version && this.building.purpose === purpose) return this.building.done
    const done = this.queue.then(async () => this.compute(version, purpose))
    this.queue = done.then(() => undefined, () => undefined)
    const building: Building = { version, purpose, done }
    this.building = building
    try {
      return await done
    } finally {
      if (this.building === building) this.building = undefined
    }
  }

  /**
   * Stop reporting, as the context's disposal does: a build that has not returned is refused, and the next request is
   * refused at once.
   * @returns nothing.
   */
  dispose(): void {
    this.disposed = true
    this.building = undefined
  }

  /**
   * Read every fact and build the report.
   * @param version - the installed target's version.
   * @param purpose - whether the report is an update's or a rollback's.
   * @returns the report and the plugin ids it disables.
   * @throws {UpdateReportError} `REPORT_DISPOSED` when the context was disposed while a fact was read.
   */
  private async compute(version: string, purpose: ReportPurpose): Promise<BuiltUpdateReport> {
    const input = await readReportInput(this.options.installation, this.options.sources, version, purpose)
    // The reads may have outlived the context that asked for them, and a report from it is not this context's answer.
    this.assertLive()
    return builtReport(input)
  }

  /**
   * Refuse a request from a disposed context.
   * @throws {UpdateReportError} `REPORT_DISPOSED` when the context is disposed.
   */
  private assertLive(): void {
    if (this.disposed) throw new UpdateReportError('REPORT_DISPOSED', 'the context that owns the report was disposed')
  }
}
