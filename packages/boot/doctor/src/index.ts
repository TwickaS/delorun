/**
 * The `doctor` check registry: packages register checks of the machine and
 * composition they run on, and a caller runs them all at once and reads one
 * outcome per check. Each check runs under its own deadline, so one hung
 * check reports a failure without holding the others.
 * @module @deepseek-ai/dsh-doctor
 */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

declare module '@deepseek-ai/cordis' {
  interface Context {
    doctor: DoctorRegistry
  }
}

/** A check's verdict: `pass`, `warn` for something that works with less than it should, `fail` for something that does not work. */
export type DoctorStatus = 'pass' | 'warn' | 'fail'

/** What one check found. */
export interface DoctorOutcome {
  readonly status: DoctorStatus
  /** One sentence for the person: what was found, and for `warn` or `fail` what to do. */
  readonly detail: string
}

/** One check a package contributes. */
export interface DoctorCheck {
  /** Stable id, unique in the registry, such as `sandbox-enforcement`. */
  readonly id: string
  /** What it checks, in the person's words. */
  readonly title: string
  /**
   * Run the check once.
   * @param signal - aborted at the check's deadline or when the run is cancelled.
   * @returns the check's outcome; a rejection is reported as a failure.
   */
  run(signal: AbortSignal): Promise<DoctorOutcome>
}

/** One check's result in a run, in registration order. */
export interface DoctorResult extends DoctorOutcome {
  readonly id: string
  readonly title: string
}

/** Registry configuration. */
export interface Config {
  /** How long one check may run before it is reported as failed. */
  checkTimeoutMs: number
}

/** Registers checks and runs them. */
export default class DoctorRegistry extends Service {
  static Config: z<Config> = z.object({
    checkTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(10_000),
  })

  private readonly checks = new Map<string, DoctorCheck>()

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'doctor')
  }

  /**
   * Add a check for the calling plugin's lifetime.
   * @param check - the check; its id must be unused.
   * @returns the disposer that removes it.
   * @throws when another check already has the id.
   */
  register(check: DoctorCheck): () => void {
    return this.ctx.effect(() => {
      if (this.checks.has(check.id)) throw new Error(`doctor: a check with id "${check.id}" is already registered`)
      this.checks.set(check.id, check)
      return () => { this.checks.delete(check.id) }
    })
  }

  /**
   * Run every registered check concurrently, each under the configured deadline.
   * @param signal - cancels every check still running.
   * @returns one result per check, in registration order.
   */
  async run(signal: AbortSignal): Promise<DoctorResult[]> {
    return Promise.all([...this.checks.values()].map(async (check) => {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(this.config.checkTimeoutMs)])
      try {
        const outcome = await check.run(deadline)
        return { id: check.id, title: check.title, status: outcome.status, detail: outcome.detail }
      } catch (error) {
        signal.throwIfAborted()
        const detail = deadline.aborted
          ? `it did not finish within ${String(this.config.checkTimeoutMs)} ms`
          : `it stopped with an error: ${error instanceof Error ? error.message : String(error)}`
        return { id: check.id, title: check.title, status: 'fail' as const, detail }
      }
    }))
  }
}
