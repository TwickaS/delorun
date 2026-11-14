/**
 * The `doctor` profile's app: once startup commits, it runs every registered
 * check, prints one line per check and a summary on stdout, and exits 0 when
 * none failed, 1 otherwise. Its command line answers `--help` with the usage
 * and runs no check.
 * @module @deepseek-ai/dsh-doctor/app
 */
import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import z from '@deepseek-ai/schemastery'
import type { DoctorResult, DoctorStatus } from './index.ts'

/** Required services. `cmdlineArgs` is the invocation the app parses; `doctor` holds the checks. */
export const inject = ['doctor', 'cmdlineArgs']

/** The app's switch. */
export interface Config {
  /**
   * Run the checks once startup commits. This is Delorun's C16 switch `doctor`, off in the parity composition. The
   * shipped `doctor` profile sets it on. With it off the app runs no check: it writes one line to stderr and exits 1.
   */
  doctor?: boolean
}

/** Validates the app's switch; it defaults to off. */
export const Config: z<Config> = z.object({
  doctor: z.boolean().default(false),
})

const MARK: Record<DoctorStatus, string> = { pass: 'ok  ', warn: 'warn', fail: 'FAIL' }

/**
 * The report a run prints.
 * @param results - the run's results.
 * @returns one line per check, then the counts.
 */
export function report(results: readonly DoctorResult[]): string {
  const count = (status: DoctorStatus) => results.filter(result => result.status === status).length
  const lines = results.map(result => `${MARK[result.status]}  ${result.title}: ${result.detail}`)
  lines.push('', `${String(count('pass'))} passed, ${String(count('warn'))} warned, ${String(count('fail'))} failed`)
  return `${lines.join('\n')}\n`
}

/**
 * Parse the app's command line, then run the checks after startup and exit with their verdict. `--help` prints the
 * usage and exits 0 without running a check; with the `doctor` switch off, the run exits 1 without running a check.
 * @param ctx - context carrying the registry, the invocation and the launcher's exit and readiness.
 * @param config - the app's switch.
 * @throws when the launcher provided no exit request, readiness signal or invocation.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const exit = ctx.get('appExit')
  const ready = ctx.get('appReady')
  if (exit === undefined || ready === undefined) throw new Error('doctor app: the launcher must provide ctx.appExit and ctx.appReady before the tree mounts')
  const lifetime = new AbortController()
  ctx.effect(() => () => { lifetime.abort() })
  const program = new Command()
    .name('dsh --profile doctor')
    .description('Check the machine and composition dsh runs on: print one line per check, and exit 0 when none failed, 1 otherwise.')
    .helpOption('-h, --help', 'show this help')
    .action(() => {
      if (config.doctor !== true) {
        ctx.effect(() => ready.onReady(() => {
          process.stderr.write('dsh doctor: the doctor is switched off in this composition; set the doctor-app switch `doctor` to true to run the checks\n')
          exit(1)
        }))
        return
      }
      ctx.effect(() => ready.onReady(() => {
        void ctx.doctor.run(lifetime.signal).then((results) => {
          process.stdout.write(report(results))
          exit(results.some(result => result.status === 'fail') ? 1 : 0)
        }, (error: unknown) => {
          if (lifetime.signal.aborted) return
          process.stderr.write(`dsh doctor: the checks could not run: ${error instanceof Error ? error.message : String(error)}\n`)
          exit(1)
        })
      }))
    })
  parseCmdline(ctx, program)
}
