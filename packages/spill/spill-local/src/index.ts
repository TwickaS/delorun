/**
 * `LocalSpillStore`: the host-filesystem implementation of the
 * `@deepseek-ai/dsh-spill` storage seam. Persists oversized text to a
 * private, session-scoped file (see `./store.ts` for the traversal-safe naming
 * and exclusive owner-only write) and returns a path locator plus local
 * read/grep retrieval guidance. After activation it runs one best-effort
 * startup sweep that reclaims spill files older than `cleanupPeriodDays`.
 *
 * @module @deepseek-ai/dsh-spill-local
 */

import { Context } from '@deepseek-ai/cordis'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import z from '@deepseek-ai/schemastery'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-sandbox'
import { SpillLocator, SpillStore } from '@deepseek-ai/dsh-spill'
import type { SaveTextSpill, SpillRef } from '@deepseek-ai/dsh-spill'
import { gatherSweepRoots, sweepSpillRoots } from './cleanup.ts'
import type { SweepRoot, WarnFn } from './cleanup.ts'
import { privateRoot, privateRootFallbackCause, saveTextFile } from './store.ts'

export { discoverDefaultRoots, sweepSpillRoots } from './cleanup.ts'
export type { SweepOptions, SweepRoot, WarnFn } from './cleanup.ts'
export { DEFAULT_ROOT_DIR_NAME, DEFAULT_ROOT_PREFIX, encodeSegment, isErrno, privateRoot, privateRootFallbackCause, saveTextFile, sessionDir } from './store.ts'
export type { SavedText, SaveTextOptions } from './store.ts'

/**
 * The default spill root is a temp directory confined commands can read, while the sandbox provider protects the home
 * that should have held it.
 */
export class SpillRootUnprotectedError extends HarnessError {
  constructor(root: string, home: string, cause: unknown) {
    super(
      `spill-local: not saving tool output to ${root}: the protected home ${home} could not hold its spill directory `
        + `(${String(cause)}), and confined commands can read the temporary directory; make ${home} writable or set the spill row's root`,
      'SPILL_ROOT_UNPROTECTED',
      { cause },
    )
    this.name = 'SpillRootUnprotectedError'
  }
}

/** Milliseconds in one day — converts the `cleanupPeriodDays` config to the sweep cutoff. */
const MS_PER_DAY = 24 * 60 * 60 * 1000

/** Plugin config (all optional — `static Config` supplies the defaults). */
export interface Config {
  /**
   * Root directory for spill files. Omitted uses the lazily-created private
   * (0700) `<home>/spill` directory of the resolved Harness home
   * (`$DSH_HOME`, else `~/.dsh`) — the safe default for a local deployment,
   * because a deployment's protected home already keeps confined commands from
   * reading it. A home that cannot host it (a read-only home) falls back to a
   * private (0700) `dsh-spill-*` directory under the OS temp dir, which is
   * outside that protected set. Set it to keep spill files under a known
   * location.
   */
  root?: string
  /**
   * Age in days after which a spill file is eligible for the one-shot startup
   * cleanup sweep. Defaults to `30`; `0` disables cleanup entirely. Files whose
   * `mtime` is strictly older than the cutoff are deleted and emptied
   * directories are pruned; fresh files, symlinks, and unrelated entries are
   * left untouched. On POSIX, cleanup skips roots and session directories that
   * another local user could modify or replace. Retention is deliberate — a
   * resumed or forked session may still reference an older locator until it
   * ages out.
   */
  cleanupPeriodDays?: number
}

/** The shape after schemastery applied the defaults. */
type ResolvedConfig = Required<Omit<Config, 'root'>> & Pick<Config, 'root'>

/**
 * Local-filesystem spill backend. Files land under `<root>/session-<hash>/…`
 * with unpredictable names, an exclusive owner-only (0600) write, and a private
 * (0700) root — a spilled tool result must not be readable by other local users
 * or redirectable via a planted symlink.
 *
 * After activation it launches ONE best-effort cleanup sweep (see
 * {@link cleanupPeriodDays}) that reclaims expired spill files without delaying
 * service availability; the sweep is owned by the plugin fiber and awaited
 * during disposal, so a fiber unload never returns before it quiesces.
 */
export class LocalSpillStore extends SpillStore {
  static Config: z<Config> = z.object({
    root: z.string(),
    cleanupPeriodDays: z.number().step(1).min(0).default(30),
  })

  /** Resolved absolute spill root (config `root`, else the private default), fixed at construction. */
  readonly root: string

  /** Why the default root fell back to a `dsh-spill-*` temp directory; `undefined` for a home or configured root. */
  private readonly homeFailure: unknown

  /** Validated config (schemastery applied the `cleanupPeriodDays` default before construction). */
  readonly config: ResolvedConfig

  /**
   * The in-flight (or settled) startup cleanup sweep. Held so disposal can await
   * it; `undefined` when cleanup is disabled (`cleanupPeriodDays === 0`).
   */
  private cleanup: Promise<void> | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx)
    // schemastery (static Config) has already filled `cleanupPeriodDays`; the
    // cast records that runtime fact for exactOptionalPropertyTypes.
    this.config = config as ResolvedConfig
    this.root = config.root !== undefined ? resolve(config.root) : privateRoot()
    this.homeFailure = config.root !== undefined ? undefined : privateRootFallbackCause()

    // One best-effort startup sweep, owned by the fiber. The generator body runs
    // at activation but does NOT await the sweep — it launches it and yields an
    // async disposer that awaits the SAME promise, so service availability is
    // never delayed yet a fiber unload reaches quiescence (no sweep I/O outlives
    // the fiber). Disabled (`cleanupPeriodDays === 0`) yields a no-op disposer.
    ctx.effect(function* (this: LocalSpillStore) {
      if (this.config.cleanupPeriodDays > 0) {
        const warn: WarnFn = (message) => { this.ctx.logger.warn(message) }
        this.cleanup = this.runCleanup(warn)
      }
      yield async () => { await this.cleanup }
    }.bind(this), 'spill-local cleanup sweep')
  }

  /**
   * Run the one-shot cleanup: gather the roots to sweep (see {@link gatherRoots})
   * and sweep all of them at the age cutoff. Best-effort —
   * {@link sweepSpillRoots} contains every filesystem failure, so this never
   * rejects and cannot fail activation or a concurrent spill write.
   *
   * @param warn - sink for a contained filesystem failure.
   * @returns Resolves when the sweep finishes (never rejects).
   */
  private async runCleanup(warn: WarnFn): Promise<void> {
    const cutoffMs = Date.now() - this.config.cleanupPeriodDays * MS_PER_DAY
    const roots = await this.gatherRoots(warn)
    await sweepSpillRoots({ roots, cutoffMs, warn })
  }

  /**
   * The roots the startup sweep covers: each discovered prior-default
   * `dsh-spill-*` temp root (see {@link discoverDefaultRoots}), pruned when
   * emptied, plus the active/configured root, which is never itself pruned while
   * the live process may write into it. Empty session directories are pruned in
   * every root. Filesystem identity de-duplicates aliases before the active root
   * overrides a discovered match as non-prunable. A test overrides this to
   * inject an isolated root set — and, being the sweep's one async gather point,
   * to hold the sweep open across a disposal for the quiescence check; it is a
   * test seam, not a deployment knob.
   *
   * @param warn - sink for a contained discovery failure.
   * @returns The roots to sweep, each flagged for prune-when-empty.
   */
  protected async gatherRoots(warn: WarnFn): Promise<SweepRoot[]> {
    return gatherSweepRoots(this.root, warn, this.defaultRootsBase())
  }

  /**
   * The directory scanned for prior default `dsh-spill-*` roots — the OS tmpdir,
   * where {@link privateRoot} creates the fallback root of a home that cannot host
   * `<home>/spill` (accumulation only happens there). A
   * test overrides this to point discovery at an isolated fixture instead of the
   * real tmpdir; it is a test seam, not a deployment knob.
   *
   * @returns The base directory to scan for default spill roots.
   */
  protected defaultRootsBase(): string {
    return tmpdir()
  }

  /**
   * Save one spill file. A default root that fell back to the OS temp directory is refused while the mounted sandbox
   * provider protects a home, because confined commands can read the temp directory: the call rejects with
   * {@link SpillRootUnprotectedError}, and the caller keeps the output inline as for any failed save.
   * @param input - the spill request.
   * @returns the saved file's locator, size and retrieval hint.
   * @throws {SpillRootUnprotectedError} for the temp fallback under a protected home.
   */
  async saveText(input: SaveTextSpill): Promise<SpillRef> {
    const protectedHome = this.homeFailure === undefined ? undefined : this.ctx.get('sandbox')?.protectedHome
    if (protectedHome !== undefined) throw new SpillRootUnprotectedError(this.root, protectedHome, this.homeFailure)
    const saved = await saveTextFile({
      root: this.root,
      sessionId: input.owner.sessionId,
      suggestedName: input.suggestedName,
      content: input.content,
    })
    return {
      locator: SpillLocator(saved.path),
      bytes: saved.bytes,
      retrievalHint: 'Use read with offset/limit, or grep this path to search within it.',
    }
  }
}

export default LocalSpillStore
