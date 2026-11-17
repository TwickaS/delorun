/**
 * Set-up shared by the live Codex runs: a throwaway git task folder, the harness's own subprocess owner behind a
 * spawn shaped like the gate's, the pinned program, a redacting wire log, and a top-level listing of the Codex home
 * (names, sizes and times only; no file is opened).
 *
 * Live runs use the person's own Codex sign-in. Never part of a Vitest lane.
 * @module @delorun/agent-codex/live/common
 */
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { ProgramApprovalAnswer, ProgramApprovalRequest, ProgramEvent, ProgramOpenRequest, ProgramSpawn } from '@delorun/external-agents/contract'
import { locateCodex, type LocatedCodex } from '@delorun/external-agents/locate'
import { CodexDriver } from '../src/driver.ts'
import type { CodexSession } from '../src/session.ts'

/** The worktree root. */
export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
/** Where the redacted logs go. */
export const LOG_ROOT = join(homedir(), 'delorun-rc-release', 'ea1-codex-logs')
/** A model the owner's plan offers; their configured default is not on it. */
export const MODEL = process.env.EA1_CODEX_MODEL ?? 'gpt-5.6-luna'
/** The person's Codex home, listed at the top level only. */
export const CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), '.codex')

/**
 * The pinned program, found by the gate's locator from the repository's installed packs.
 * @returns its launcher script and version.
 */
export function pinnedCodex(): LocatedCodex {
  const program = locateCodex(REPO)
  if (program === undefined) throw new Error('the Codex pack is not installed in this worktree')
  return program
}

/**
 * A throwaway git task folder under `/tmp` with one small file.
 * @returns its path.
 */
export function taskFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), 'ea1-codex-task-'))
  writeFileSync(join(folder, 'notes.txt'), 'colour: blue\n')
  const git = (...args: string[]): void => { execFileSync('git', ['-c', 'user.email=live@example.invalid', '-c', 'user.name=live', ...args], { cwd: folder }) }
  git('init', '-q')
  git('add', 'notes.txt')
  git('commit', '-q', '-m', 'notes')
  return folder
}

/**
 * Remove a task folder this module made.
 * @param folder - the folder.
 */
export function removeTask(folder: string): void {
  if (!folder.startsWith(join(tmpdir(), 'ea1-codex-task-'))) throw new Error(`refusing to remove ${folder}`)
  rmSync(folder, { recursive: true, force: true })
}

/** Keys whose values never reach a log: credentials, emails, organisations and account ids. */
const SECRET_KEY = /email|^(?!tokenUsage$)(?!.*Tokens$).*token|secret|password|api.?key|authorization|cookie|account.?id|organi[sz]ation|user.?id/i

/**
 * A copy of a JSON value with every sensitive field replaced.
 * @param value - the value.
 * @returns the redacted copy.
 */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, SECRET_KEY.test(key) ? '[redacted]' : redact(inner)]))
}

/** A redacting log of one live run. */
export class LiveLog {
  readonly path: string
  private readonly started = Date.now()

  /** @param name - the run's name. */
  constructor(name: string) {
    mkdirSync(LOG_ROOT, { recursive: true, mode: 0o700 })
    this.path = join(LOG_ROOT, `${new Date().toISOString().replace(/[:.]/g, '-')}-${name}.log`)
  }

  /**
   * Write one wire frame or stderr chunk.
   * @param direction - `>` sent, `<` received, `!` stderr.
   * @param frame - the frame.
   */
  frame(direction: string, frame: unknown): void {
    const seconds = ((Date.now() - this.started) / 1000).toFixed(3)
    // Codex's stderr is free text that may quote anything, so only its length is kept.
    const body = direction === '!' ? `[stderr, ${String(frame).length} characters]` : JSON.stringify(redact(frame))
    appendFileSync(this.path, `${seconds} ${direction} ${body}\n`, { mode: 0o600 })
  }

  /**
   * Print and log one finding.
   * @param label - what was measured.
   * @param value - the value.
   */
  report(label: string, value: unknown): void {
    const line = `${label}: ${typeof value === 'string' ? value : JSON.stringify(redact(value))}`
    console.log(line)
    appendFileSync(this.path, `## ${line}\n`, { mode: 0o600 })
  }
}

/**
 * The Codex home's top level: each name with its size and modification time. No file is opened.
 * @returns the entries by name.
 */
export function topListing(): ReadonlyMap<string, string> {
  return new Map(readdirSync(CODEX_HOME).sort().map((name) => {
    const stat = statSync(join(CODEX_HOME, name), { throwIfNoEntry: false })
    return [name, stat === undefined ? 'gone' : `${stat.isDirectory() ? 'dir' : stat.size} ${stat.mtime.toISOString()}`]
  }))
}

/** How the Codex home's top level changed between two listings. */
export interface ListingChange {
  readonly added: readonly string[]
  readonly removed: readonly string[]
  /** Entries whose size or time changed; Codex's own state databases and model cache change on every start. */
  readonly changed: readonly string[]
}

/**
 * The names added, removed and changed between two listings.
 * @param before - the earlier listing.
 * @param after - the later listing.
 * @returns the change, by name only.
 */
export function listingDiff(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): ListingChange {
  return {
    added: [...after.keys()].filter(name => !before.has(name)),
    removed: [...before.keys()].filter(name => !after.has(name)),
    changed: [...after.keys()].filter(name => before.has(name) && before.get(name) !== after.get(name)),
  }
}

/**
 * Process ids whose working directory is a folder (Linux).
 * @param folder - the task folder.
 * @returns the processes with their executables.
 */
export function processesIn(folder: string): { readonly pid: number; readonly exe: string }[] {
  return readdirSync('/proc').filter(entry => /^\d+$/.test(entry)).flatMap((pid) => {
    try {
      if (readlinkSync(`/proc/${pid}/cwd`) !== folder) return []
      return [{ pid: Number(pid), exe: readlinkSync(`/proc/${pid}/exe`).split('/').at(-1) ?? '' }]
    } catch (_gone) {
      // The process exited or is not ours to read; either way it is not one this run started.
      return []
    }
  })
}

/** One live run's harness: subprocess owner, driver, task folder and log. */
export interface Live {
  readonly log: LiveLog
  readonly task: string
  readonly spawn: ProgramSpawn
  readonly handles: SubprocessHandle[]
  readonly driver: CodexDriver
  readonly questions: ProgramApprovalRequest[]
  /** Answers for the next questions, in order; `reject` once they run out. */
  answers: ProgramApprovalAnswer[]
  request(overrides?: Partial<ProgramOpenRequest>): ProgramOpenRequest
  dispose(): Promise<void>
}

/**
 * Set up one live run.
 * @param name - the run's name, for the log.
 * @param task - a task folder to reuse, or a fresh one.
 * @returns the harness.
 */
export async function live(name: string, task = taskFolder()): Promise<Live> {
  const log = new LiveLog(`codex-${name}`)
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  const handles: SubprocessHandle[] = []
  const spawn: ProgramSpawn = (request) => {
    const handle = ctx.subprocess.spawn({ argv: request.argv, cwd: task, stdio: request.stdio, graceMs: 3_000, ...request.env === undefined ? {} : { env: request.env } })
    handles.push(handle)
    return handle
  }
  const questions: ProgramApprovalRequest[] = []
  const harness: Live = {
    log,
    task,
    spawn,
    handles,
    questions,
    answers: [],
    driver: new CodexDriver({ locate: pinnedCodex, requestTimeoutMs: 120_000, closeWaitMs: 5_000, tap: (direction, frame) => { log.frame(direction, frame) } }),
    request: overrides => ({
      sessionId: SessionId(`live-${name}`),
      cwd: task,
      model: MODEL,
      runRules: [],
      harnessTools: [],
      spawn,
      onApproval: (question) => {
        questions.push(question)
        const answer = harness.answers.shift() ?? 'reject'
        log.report('question', { callId: question.callId, toolName: question.toolName, reason: question.reason, runRule: question.runRule ?? null, answer })
        return Promise.resolve(answer)
      },
      onLimits: (observation) => { log.report('limits seen', observation) },
      signal: new AbortController().signal,
      ...overrides,
    }),
    dispose: () => ctx.fiber.dispose(),
  }
  log.report('codex', pinnedCodex().version)
  return harness
}

/**
 * Take events until the turn ends.
 * @param session - the session.
 * @param log - the run's log.
 * @param onEvent - sees each event as it arrives.
 * @returns the events.
 */
export async function untilTurnEnd(session: CodexSession, log: LiveLog, onEvent?: (event: ProgramEvent) => Promise<void> | void): Promise<ProgramEvent[]> {
  const events: ProgramEvent[] = []
  const signal = AbortSignal.timeout(240_000)
  for (;;) {
    const event = await session.next(signal)
    events.push(event)
    if (event.kind !== 'text' && event.kind !== 'reasoning') log.report('event', event)
    await onEvent?.(event)
    if (event.kind === 'turn-end') return events
  }
}

/**
 * The answer text in events.
 * @param events - the events.
 * @returns the text joined.
 */
export const answerText = (events: readonly ProgramEvent[]): string => events.flatMap(event => event.kind === 'text' ? [event.text] : []).join('')

/**
 * Wait.
 * @param ms - how long.
 * @returns after the wait.
 */
export const sleep = (ms: number): Promise<void> => new Promise(resolveWait => setTimeout(resolveWait, ms))
