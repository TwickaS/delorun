/**
 * A batch's durable record, `<git common dir>/delo-batch/<id>/state.json`. Each step's outcome is recorded under a key
 * before the next step starts, so `--resume` replays the recorded outcomes and runs the first step without one. The file
 * is written through a temporary file renamed into place, so an interruption leaves the previous whole record.
 *
 * @module @delo/tools/batch/state
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { BatchError } from './errors.ts'

/** The record's version; a reader refuses any other. */
export const STATE_VERSION = 1

const Sha = z.string().regex(/^[0-9a-f]{40,64}$/)

/** Why a lane was set aside without running a check. */
const SetAsideSchema = z.discriminatedUnion('kind', [
  /** A commit of the lane conflicted with the candidate; `paths` are the conflicting paths. */
  z.object({ kind: z.literal('conflict'), commit: Sha, paths: z.array(z.string()) }),
  /** The lane holds merge commits, which the batch does not replay. */
  z.object({ kind: z.literal('merge-commits'), commits: z.array(Sha) }),
  /** The lane has no commit beyond the trunk. */
  z.object({ kind: z.literal('no-commits') }),
  /** `git cherry-pick` failed without a conflict; `detail` is git's first error line. */
  z.object({ kind: z.literal('pick-failed'), commit: Sha, detail: z.string() }),
])

/** Why a lane was set aside without running a check. */
export type SetAside = z.infer<typeof SetAsideSchema>

/** One replayed commit: its id on the lane and on the candidate, or null when it became empty and was dropped. */
const ReplayedSchema = z.object({ original: Sha, applied: Sha.nullable() })

/** A lane replayed onto a candidate. */
const ApplicationSchema = z.object({
  lane: z.string(),
  /** The candidate commit before the lane. */
  before: Sha,
  /** The candidate commit after the lane. */
  after: Sha,
  commits: z.array(ReplayedSchema),
  /** The paths the replayed commits change, old and new names of a rename included. */
  paths: z.array(z.string()),
})

/** A lane replayed onto a candidate. */
export type Application = z.infer<typeof ApplicationSchema>

/** One failing check of a gate, with what its log names, read before the next run replaces the log. */
const FailedCheckSchema = z.object({
  check: z.string(),
  reason: z.string().nullable(),
  logPath: z.string().nullable(),
  /** The first failing test's name and assertion, or the log's first error lines. */
  excerpt: z.array(z.string()),
  /** Repository-relative spec files the log names as failing. */
  specs: z.array(z.string()),
  /** Commit ids, full or abbreviated, the log names. */
  commits: z.array(z.string()),
})

/** One failing check of a gate. */
export type FailedCheck = z.infer<typeof FailedCheckSchema>

/** What one gate of a candidate found. */
const GateSchema = z.discriminatedUnion('kind', [
  /** Every check passed; with landing on, the push completed. */
  z.object({ kind: z.literal('passed') }),
  /** At least one check failed. */
  z.object({ kind: z.literal('failed'), failing: z.array(FailedCheckSchema) }),
  /** The remote rejected the push because the trunk moved. */
  z.object({ kind: z.literal('trunk-moved'), detail: z.string() }),
  /** The gate failed without a failed check: no report, a declined check, or a remote refusal. */
  z.object({ kind: z.literal('gate-error'), detail: z.string() }),
])

/** What one gate of a candidate found. */
export type Gate = z.infer<typeof GateSchema>

/** How narrowing faulted a group of lanes. */
const FaultSchema = z.object({
  lanes: z.array(z.string()),
  /** `removal-fixes`: removing this lane alone fixed every failing check; `fails-alone`: the lane fails on the trunk by itself; `together`: the lanes fail only together. */
  why: z.enum(['removal-fixes', 'fails-alone', 'together']),
  /** The failing checks the group is a suspect for. */
  checks: z.array(z.string()),
})

/** A group of lanes narrowing faulted. */
export type Fault = z.infer<typeof FaultSchema>

/** What narrowing concluded. */
const VerdictSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('faulted'), faults: z.array(FaultSchema) }),
  /** The failure persists without every suspect: the trunk, the environment or a flake. */
  z.object({ kind: z.literal('not-attributable'), checks: z.array(z.string()) }),
])

/** What narrowing concluded. */
export type Verdict = z.infer<typeof VerdictSchema>

/** The result of one recorded step. */
const StepSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('applied'), application: ApplicationSchema }),
  z.object({ kind: z.literal('set-aside'), lane: z.string(), reason: SetAsideSchema }),
  /** A candidate rebuilt from the start for a round: its commit, its lanes and the lanes that no longer applied. */
  z.object({ kind: z.literal('build'), commit: Sha, applied: z.array(ApplicationSchema), setAside: z.array(z.object({ lane: z.string(), reason: SetAsideSchema })) }),
  z.object({ kind: z.literal('gate'), commit: Sha, gate: GateSchema }),
  /** The failing checks rerun once on the same candidate: those still failing, and those that passed. */
  z.object({ kind: z.literal('rerun'), failing: z.array(z.string()), flaky: z.array(z.string()) }),
  /** The failing checks on a candidate of some lanes; `unbuildable` when a lane no longer applies without the others. */
  z.object({ kind: z.literal('trial'), lanes: z.array(z.string()), result: z.enum(['passed', 'failed', 'unbuildable']), failing: z.array(z.string()) }),
  z.object({ kind: z.literal('verdict'), verdict: VerdictSchema }),
])

/** The result of one recorded step. */
export type Step = z.infer<typeof StepSchema>

/** How the batch ended. */
const OutcomeSchema = z.discriminatedUnion('kind', [
  /** The push to the trunk completed with this commit. */
  z.object({ kind: z.literal('landed'), commit: Sha }),
  /** With landing off, this candidate passed the merge tier. */
  z.object({ kind: z.literal('passed'), commit: Sha }),
  z.object({ kind: z.literal('trunk-moved'), detail: z.string() }),
  z.object({ kind: z.literal('gate-error'), detail: z.string() }),
  z.object({ kind: z.literal('not-attributable'), checks: z.array(z.string()) }),
  /** A second round failed only on checks that passed when rerun. */
  z.object({ kind: z.literal('flaky'), checks: z.array(z.string()) }),
  /** Every lane was set aside or faulted. */
  z.object({ kind: z.literal('nothing-to-land') }),
])

/** How the batch ended. */
export type Outcome = z.infer<typeof OutcomeSchema>

/** A lane as the batch found it when it started. */
const LaneSchema = z.object({
  name: z.string(),
  /** The lane's tip when the batch started; later commits on the lane are not part of the batch. */
  tip: Sha,
  /** `merge-base(<remote>/<trunk>, tip)`. */
  base: Sha,
  /** The commits from `base` to `tip`, oldest first. */
  commits: z.array(Sha),
  /** The merge commits among them. */
  merges: z.array(Sha),
})

/** A lane as the batch found it when it started. */
export type Lane = z.infer<typeof LaneSchema>

const StateSchema = z.object({
  version: z.literal(STATE_VERSION),
  id: z.string(),
  trunk: z.string(),
  remote: z.string(),
  land: z.boolean(),
  /** `<remote>/<trunk>` when the batch started: every candidate is built on it and every gate measures from it. */
  start: Sha,
  lanes: z.array(LaneSchema),
  /** The last recorded candidate commit, which `--resume` resets the candidate branch to. */
  candidate: Sha,
  /** Each finished step's result, by key, in the order they finished. */
  steps: z.record(z.string(), StepSchema),
  outcome: OutcomeSchema.nullable(),
})

/** A batch's durable record. */
export type BatchState = z.infer<typeof StateSchema>

/** The file operations the batch performs; all paths are absolute. */
export interface Files {
  /**
   * Read a file.
   * @param path - the file.
   * @returns its text, or undefined when it does not exist.
   */
  readonly read: (path: string) => string | undefined
  /**
   * Write a file through a temporary file in its directory renamed into place, creating the directory.
   * @param path - the file.
   * @param text - its new content.
   */
  readonly write: (path: string, text: string) => void
  /**
   * Remove a file; a missing file is not an error.
   * @param path - the file.
   */
  readonly remove: (path: string) => void
}

/**
 * Parse a state file.
 * @param text - the file's text.
 * @param path - the file, for the error.
 * @returns the state.
 * @throws BatchError with code `state` when the text is not JSON or not a state of {@link STATE_VERSION}.
 */
export function parseState(text: string, path: string): BatchState {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (error) {
    // SyntaxError: a truncated or hand-edited file, which no step can be replayed from.
    void error
    throw new BatchError('state', `${path} is not JSON; it cannot be resumed`)
  }
  const parsed = StateSchema.safeParse(json)
  if (!parsed.success) throw new BatchError('state', `${path} is not a batch state of version ${String(STATE_VERSION)}: ${parsed.error.issues.slice(0, 1).map(issue => `${issue.path.join('.')}: ${issue.message}`).join('')}`)
  return parsed.data
}

/**
 * The text a state is stored as.
 * @param state - the state.
 * @returns indented JSON with a trailing newline.
 */
export function stateText(state: BatchState): string {
  return `${JSON.stringify(state, null, 2)}\n`
}

/**
 * A test for recorded steps of some kinds.
 * @param kinds - the kinds a step may have.
 * @returns a type guard that is true for a step of one of them.
 */
export function ofKind<K extends Step['kind']>(...kinds: readonly K[]): (step: Step) => step is Extract<Step, { kind: K }> {
  return (step): step is Extract<Step, { kind: K }> => kinds.some(kind => kind === step.kind)
}

/** The file port over Node's file system. */
export const nodeFiles: Files = {
  read: path => existsSync(path) ? readFileSync(path, 'utf8') : undefined,
  write: (path, text) => {
    mkdirSync(dirname(path), { recursive: true })
    const temporary = `${path}.${String(process.pid)}.tmp`
    writeFileSync(temporary, text)
    renameSync(temporary, path)
  },
  remove: path => { rmSync(path, { force: true }) },
}
