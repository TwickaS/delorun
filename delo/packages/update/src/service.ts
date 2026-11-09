/**
 * The report as a service of a Delo process: `ctx.updateReport` reads the profile, the staged target and both
 * installations' status records from {@link ReportSources} and returns C3's report with the plugin ids the health check
 * holds the target to. It is the `UpdateReporter` the runtime store's `prepare` and `reportRollback` call
 * (`delo/packages/runtime-store/src/seam.ts`), whose seam passes a version and receives `{ report, disabledPlugins }`.
 *
 * The service owns no reader and no clock: the caller passes the sources, so a spec answers from fixtures and the
 * launcher's real reads stay behind their owner. One report is built at a time, and a second request for the version
 * already building joins it. The build is an effect of the context, so a disposed context returns no report: a caller
 * still waiting is refused with `REPORT_DISPOSED` rather than handed a report from a context that no longer exists.
 *
 * @module @delo/update/service
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import semver from 'semver'
import type { UtcTimestamp } from '@delo/contract-release-manifest'
import type { Installation, ReportVersions, UpdateReport } from '@delo/contract-update-report'
import { UpdateReportError } from './errors.ts'
import type { InstallationStatusFacts, ProfileFacts, TargetFacts } from './facts.ts'
import { buildUpdateReport, disabledPluginNames } from './report.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Delo's pre-update report; present while a process mounts {@link UpdateReportService}. */
    updateReport: UpdateReportService
  }
}

/** Where one report's facts come from: the profile, the staged target and both status records. */
export interface ReportSources {
  /**
   * The release the installation being updated runs.
   * @returns its Delo, DSH and channel.
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
   * The current time.
   * @returns the time the report is stamped with.
   */
  now(): UtcTimestamp
}

/** A built report, with the plugin ids the health check holds the target to. */
export interface BuiltUpdateReport {
  /** C3's report, returned to the caller as it is. */
  readonly report: UpdateReport
  /** The plugin ids the report names as disabled at boot; the health check refuses any other. */
  readonly disabledPlugins: readonly string[]
}

/** What the service needs. */
export interface UpdateReportOptions {
  /** The installation this process updates; the other one is shown beside it and never switches. */
  readonly installation: Installation
  /** Where the facts come from. */
  readonly sources: ReportSources
}

/** The report being built, so a second request for the same version joins it. */
interface Building {
  readonly version: string
  readonly done: Promise<BuiltUpdateReport>
}

/** The planner of contract C3's pre-update report. */
export class UpdateReportService extends Service {
  private queue: Promise<unknown> = Promise.resolve()

  private building: Building | undefined

  private disposed = false

  /**
   * @param ctx - the context that owns the service and the build.
   * @param options - the installation and the sources.
   */
  constructor(ctx: Context, private readonly options: UpdateReportOptions) {
    super(ctx, 'updateReport')
    this.ctx.effect(() => () => this.dispose(), 'update: the pre-update report')
  }

  /**
   * Build the report for an installed, verified target.
   * @param version - the target's installed version.
   * @returns the report and the plugin ids it disables.
   * @throws {UpdateReportError} `REPORT_VERSION_INVALID` when the version is not a semantic version;
   *   `REPORT_DISPOSED` when the context is disposed before the report is returned; `REPORT_TARGET_UNVERIFIED` when
   *   the target did not pass every check.
   */
  async build(version: string): Promise<BuiltUpdateReport> {
    if (semver.valid(version) === null) throw new UpdateReportError('REPORT_VERSION_INVALID', `${JSON.stringify(version)} is not a semantic version`)
    this.assertLive()
    if (this.building?.version === version) return this.building.done
    const done = this.queue.then(async () => this.compute(version))
    this.queue = done.then(() => undefined, () => undefined)
    const building: Building = { version, done }
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
   * @returns the report and the plugin ids it disables.
   * @throws {UpdateReportError} `REPORT_DISPOSED` when the context was disposed while a fact was read.
   */
  private async compute(version: string): Promise<BuiltUpdateReport> {
    const [from, statuses, profile, target] = await Promise.all([this.options.sources.running(), this.options.sources.statuses(), this.options.sources.profile(), this.options.sources.target(version)])
    // The reads may have outlived the context that asked for them, and a report from it is not this context's answer.
    this.assertLive()
    const report = buildUpdateReport({ installation: this.options.installation, from, profile, target, statuses, generated: this.options.sources.now() })
    this.assertLive()
    return { report, disabledPlugins: disabledPluginNames(report) }
  }

  /**
   * Refuse a request from a disposed context.
   * @throws {UpdateReportError} `REPORT_DISPOSED` when the context is disposed.
   */
  private assertLive(): void {
    if (this.disposed) throw new UpdateReportError('REPORT_DISPOSED', 'the context that owns the report was disposed')
  }
}
