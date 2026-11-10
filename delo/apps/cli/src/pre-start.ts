/**
 * The one ordered list of steps that run before a Host boots over a Delo home, for `delorun start --foreground` (the
 * home process, after it takes its profile's home lock and before it finishes an interrupted update) and for `delorun
 * headless` (after it registers as a shared user of the chat data and before it composes its profile). A feature that
 * needs "one call at the top of start" adds an entry here, so every start path runs it in the same place and order.
 *
 * Each step names the starts it applies to. A step throws to refuse the start; its error reaches the person through
 * the CLI's refusal renderer, so it should be a typed error with a describer or a `CliError`.
 *
 * @module @delo/cli/pre-start
 */
import { recoverDataCopies } from '@delo/update'
import type { CommandOutput } from './command.ts'
import type { ComposeKind } from './compose.ts'
import { runProfileMigrations, type ProfileMigration } from './profile-migrations.ts'

/** What a pre-start step is given. */
export interface PreStartContext {
  /** The prepared Delo home. */
  readonly home: string
  /** The profile about to boot. */
  readonly profile: string
  /** Which start runs the steps. */
  readonly kind: ComposeKind
  /** Whether this start is an update's or a rollback's successor, which inherits a running home's state. */
  readonly successor: boolean
  /** Where a step writes what the person reads. */
  readonly output: CommandOutput
}

/** One step before a Host boots. */
export interface PreStartStep {
  /** The step's name, for logs and specs. */
  readonly name: string
  /** The starts that run it. */
  readonly kinds: readonly ComposeKind[]
  /**
   * Run the step.
   * @param context - the start.
   * @returns when the step is done.
   * @throws to refuse the start, with what failed and the remedy.
   */
  readonly run: (context: PreStartContext) => Promise<void>
}

/**
 * The slot for withdrawing an interrupted import of a stock DeepSeek Harness home, which `lane/dsh-import` fills with
 * `recoverStockImport` from `@delo/archive/dsh-import`: it withdraws the import and refuses the start when the import's
 * journal cannot be trusted. Until then it does nothing.
 * @param _context - the start.
 * @returns at once.
 */
export const recoverStockImportStep = (_context: PreStartContext): Promise<void> => Promise.resolve()

/**
 * The slot for the update notice's check, which `lane/update-notice` fills. Until then it does nothing.
 * @param _context - the start.
 * @returns at once.
 */
export const updateNoticeStep = (_context: PreStartContext): Promise<void> => Promise.resolve()

/** What the real list's steps call outside this module. */
export interface PreStartDependencies {
  /** The profile's one-time changes, run on a fresh start of the CLI profile. */
  readonly migrations: (context: PreStartContext) => readonly ProfileMigration[]
}

/**
 * The ordered pre-start steps:
 *
 * 1. `stock-import-recovery`: both starts; {@link recoverStockImportStep}.
 * 2. `data-copy-recovery`: the CLI profile; an interrupted restore of a session-data copy finishes before any Host
 *    starts (contract C3, "Rollback"). `delorun headless` refuses while one is unfinished, when it registers.
 * 3. `profile-migrations`: the CLI profile on a fresh start; an update's successor never runs them, so its boot stays
 *    within the health check's time.
 * 4. `update-notice`: both starts; {@link updateNoticeStep}.
 * @param dependencies - the migrations.
 * @returns the steps, in the order they run.
 */
export function preStartSteps(dependencies: PreStartDependencies): readonly PreStartStep[] {
  return [
    { name: 'stock-import-recovery', kinds: ['cli', 'headless'], run: recoverStockImportStep },
    { name: 'data-copy-recovery', kinds: ['cli'], run: async (context) => { await recoverDataCopies(context.home) } },
    {
      name: 'profile-migrations',
      kinds: ['cli'],
      run: async (context) => {
        if (!context.successor) await runProfileMigrations(context.home, context.profile, dependencies.migrations(context))
      },
    },
    { name: 'update-notice', kinds: ['cli', 'headless'], run: updateNoticeStep },
  ]
}

/**
 * Run the steps that apply to a start, in order; the first that throws stops the rest.
 * @param steps - the steps.
 * @param context - the start.
 * @returns when every applicable step is done.
 * @throws the first step's refusal.
 */
export async function runPreStartSteps(steps: readonly PreStartStep[], context: PreStartContext): Promise<void> {
  for (const step of steps) {
    if (step.kinds.includes(context.kind)) await step.run(context)
  }
}
