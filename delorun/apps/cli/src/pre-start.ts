/**
 * The one ordered list of steps that run before a Host boots over a Delorun home, for `delorun start --foreground` (the
 * home process, after it takes its profile's home lock and before it finishes an interrupted update) and for `delorun
 * headless` (after it registers as a shared user of the chat data and before it composes its profile). A feature that
 * needs "one call at the top of start" adds an entry here, so every start path runs it in the same place and order.
 *
 * Each step names the starts it applies to. A step throws to refuse the start; its error reaches the person through
 * the CLI's refusal renderer, so it should be a typed error with a describer or a `CliError`.
 *
 * @module @delorun/cli/pre-start
 */
import type { RuntimeVersion } from '@delorun/contract-home-layout'
import { changesPreStartStep } from './changes/start.ts'
import type { CommandOutput } from './command.ts'
import type { ComposeKind } from './compose.ts'
import { finishInterruptedRestore, startRegistration } from './home-exclusion.ts'
import { recordDataFormatStep } from './data-format-record.ts'
import { recoverInterruptedImport } from './import-home/recover.ts'
import { profilePacksStep, type FetchProfilePacks } from './profile-packs.ts'
import { runProfileMigrations, type ProfileMigration } from './profile-migrations.ts'

/** What a pre-start step is given. */
export interface PreStartContext {
  /** The prepared Delorun home. */
  readonly home: string
  /** The profile about to boot. */
  readonly profile: string
  /** Which start runs the steps. */
  readonly kind: ComposeKind
  /** Whether this start is an update's or a rollback's successor, which inherits a running home's state. */
  readonly successor: boolean
  /** Where a step writes what the person reads. */
  readonly output: CommandOutput
  /** The stored runtime a fresh start of the CLI profile runs from C1's store; absent outside the store and for headless. */
  readonly storedRuntime?: StoredRuntime
}

/** The installed version a fresh start runs from C1's runtime store, and the store's start check of its files. */
export interface StoredRuntime {
  /** The installed version this process runs. */
  readonly version: RuntimeVersion
  /**
   * C1's start check of the version's files against its signed file list.
   * @returns when the files match.
   * @throws {RuntimeStoreError} when they do not.
   */
  readonly check: () => Promise<void>
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
 * Withdraw a stock DeepSeek Harness home import a crash interrupted, so a profile never runs over half of an import:
 * the start's own registration is exclusive while it does ([import recovery](./import-home/recover.ts)). It reports
 * the files it withdrew.
 * @param context - the start.
 * @returns when no import is left interrupted.
 * @throws {CliError} while another process uses the shared stores or an update is unfinished; DshImportError when the
 *   import's journal cannot be trusted.
 */
export async function recoverStockImportStep(context: PreStartContext): Promise<void> {
  const recovered = await recoverInterruptedImport(context.home, startRegistration(context.kind, context.profile))
  if (recovered !== undefined && recovered.withdrawn.length > 0) {
    context.output.stdout(`Withdrew an interrupted import of a DeepSeek Harness home: ${String(recovered.withdrawn.length)} ${recovered.withdrawn.length === 1 ? 'file' : 'files'} it had placed.\n`)
  }
}

/**
 * The slot for the update notice's check, which `lane/update-notice` fills. Until then it does nothing.
 * @param _context - the start.
 * @returns at once.
 */
export const updateNoticeStep = (_context: PreStartContext): Promise<void> => Promise.resolve()

/** What the real list's steps call outside this module. */
export interface PreStartDependencies {
  /** The profile's one-time changes, run on a fresh start of the CLI profile and on every `delorun headless` run. */
  readonly migrations: (context: PreStartContext) => readonly ProfileMigration[]
  /** Compares the profile's installed plugins with their install records and prints what changed; never throws. */
  readonly pluginChanges: (context: PreStartContext) => Promise<void>
  /** Fetches the plugin packs the profile links but the home lacks; a start that has no pack to fetch needs none. */
  readonly fetchPacks?: FetchProfilePacks
}

/**
 * The ordered pre-start steps:
 *
 * 1. `stock-import-recovery`: both starts; {@link recoverStockImportStep}.
 * 2. `data-copy-recovery`: the CLI profile; an interrupted restore of a session-data copy finishes before any Host
 *    starts (contract C3, "Rollback"), while the home process's registration is exclusive
 *    ({@link finishInterruptedRestore}). `delorun headless` refuses while one is unfinished, when it registers.
 * 3. `data-format-record`: both starts; writes the home's `data-format.json` from the running release's
 *    `data-formats.json` ([record](./data-format-record.ts)), so a later `delorun repair` knows which release wrote the data.
 * 4. `profile-migrations`: the CLI profile on a fresh start, where an update's successor never runs them, so its boot
 *    stays within the health check's time; and the `headless` profile on every `delorun headless` run, whose one-time
 *    change links Delorun's headless bundle and so creates the profile on the first run.
 * 4. `profile-packs`: the CLI profile on a fresh start from the store; a plugin pack the profile links from the running
 *    release's pack folder, which is missing, is fetched and verified first, and the start is refused with the remedy
 *    when it cannot be ([profile packs](./profile-packs.ts)).
 * 4. `changes`: both starts, after the migrations so the links they add are judged too; a fresh start from the store
 *    first refuses a runtime whose files differ from the signed release, then each plugin the profile links from a
 *    folder is made to load the content Changes allows ([changes](./changes/start.ts)).
 * 5. `plugin-changes`: both starts; the quick check of the profile's installed plugins against their install records,
 *    which writes the profile's trust status and prints a warning for each plugin whose files changed since it was
 *    installed, before any plugin code loads ([install check](./plugin-install-check.ts)). It never stops the start.
 * 6. `update-notice`: both starts; {@link updateNoticeStep}.
 * @param dependencies - the migrations and the plugin change check.
 * @returns the steps, in the order they run.
 */
export function preStartSteps(dependencies: PreStartDependencies): readonly PreStartStep[] {
  return [
    { name: 'stock-import-recovery', kinds: ['cli', 'headless'], run: recoverStockImportStep },
    { name: 'data-copy-recovery', kinds: ['cli'], run: async (context) => { await finishInterruptedRestore(context.home, context.profile) } },
    { name: 'data-format-record', kinds: ['cli', 'headless'], run: recordDataFormatStep },
    {
      name: 'profile-migrations',
      kinds: ['cli', 'headless'],
      run: async (context) => {
        if (!context.successor) await runProfileMigrations(context.home, context.profile, dependencies.migrations(context), context.output)
      },
    },
    { name: 'profile-packs', kinds: ['cli'], run: profilePacksStep(dependencies.fetchPacks ?? (() => Promise.resolve())) },
    { name: 'changes', kinds: ['cli', 'headless'], run: changesPreStartStep },
    { name: 'plugin-changes', kinds: ['cli', 'headless'], run: dependencies.pluginChanges },
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
