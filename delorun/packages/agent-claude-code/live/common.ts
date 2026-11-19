/**
 * Shared set-up for the live Claude Code runs: a throwaway git task folder under `/tmp`, the harness's own subprocess
 * owner standing in for the gate's spawn, the driver over upstream's pinned SDK, and a redacted log under
 * `~/delorun-rc-release/ea1-claude-logs/`. Runs use the person's own Claude Code sign-in and settings; nothing here
 * reads, copies or prints a credential. Never part of a Vitest lane.
 * @module @delorun/agent-claude-code/live/common
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { ClaudeCodeDriver } from '../src/driver.ts'
import type { ProgramEvent, ProgramSession, ProgramSpawn } from '@delorun/external-agents/contract'
import { loadClaudeSdk } from '../src/sdk.ts'

/** The worktree root. */
export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
/** Where the redacted logs go. */
export const LOG_ROOT = join(homedir(), 'delorun-rc-release', 'ea1-claude-logs')
/** The prefix of every task folder these runs make. */
const TASK_PREFIX = join(tmpdir(), 'ea1-claude-task-')

/**
 * The SDK upstream's Claude Code package brings.
 * @returns its entry and version.
 */
export function locateSdk(): { entry: string, version: string } {
  const entry = realpathSync(createRequire(join(REPO, 'packages/subagent/subagent-claude-code/package.json')).resolve('@anthropic-ai/claude-agent-sdk'))
  const manifest = JSON.parse(readFileSync(join(dirname(entry), 'package.json'), 'utf8')) as { version: string }
  return { entry, version: manifest.version }
}

/**
 * Make a throwaway git task folder holding `notes.txt` (`colour: blue`).
 * @returns its path.
 */
export function taskFolder(): string {
  const folder = mkdtempSync(TASK_PREFIX)
  writeFileSync(join(folder, 'notes.txt'), 'colour: blue\n')
  const git = (args: string[]): void => { execFileSync('git', ['-c', 'user.email=live@example.invalid', '-c', 'user.name=live', ...args], { cwd: folder, timeout: 10_000 }) }
  git(['init', '-q'])
  git(['add', 'notes.txt'])
  git(['commit', '-q', '-m', 'notes'])
  return folder
}

/**
 * Remove a task folder this module made.
 * @param folder - the folder.
 */
export function removeTask(folder: string): void {
  if (!folder.startsWith(TASK_PREFIX)) throw new Error(`refusing to remove ${folder}`)
  rmSync(folder, { recursive: true, force: true })
}

/** Strip anything that could name the person or their account from a log line. */
function redact(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
    .replace(/sk-ant-[\w-]+/g, '<token>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replaceAll(homedir(), '~')
}

/** A redacted log for one run. */
export class Log {
  /** The log file. */
  readonly path: string
  readonly #t0 = Date.now()

  /** @param name - the run's name. */
  constructor(name: string) {
    mkdirSync(LOG_ROOT, { recursive: true, mode: 0o700 })
    this.path = join(LOG_ROOT, `${new Date().toISOString().replace(/[:.]/g, '-')}-${name}.log`)
  }

  /**
   * Write one line, redacted, with the time since the run started.
   * @param label - what it is.
   * @param value - the value.
   */
  line(label: string, value: unknown): void {
    const text = redact(`${Date.now() - this.#t0}ms ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    console.log(text)
    appendFileSync(this.path, `${text}\n`, { mode: 0o600 })
  }
}

/** The harness's subprocess owner, standing in for the gate. */
export interface Runtime {
  /** The gate's spawn, for the folder given at start. */
  readonly spawn: ProgramSpawn
  /** Every process spawned. */
  readonly handles: SubprocessHandle[]
  /** Dispose the owner, which ends every process it holds. */
  dispose(): Promise<void>
}

/**
 * Mount the harness's local subprocess owner and a spawn bound to one folder, as the gate's is.
 * @param cwd - the folder.
 * @returns the runtime.
 */
export async function runtime(cwd: string): Promise<Runtime> {
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  const handles: SubprocessHandle[] = []
  return {
    handles,
    spawn: (request) => {
      const handle = ctx.subprocess.spawn({ argv: request.argv, env: request.env, stdio: request.stdio, cwd, graceMs: 3000 })
      handles.push(handle)
      return handle
    },
    dispose: () => ctx.fiber.dispose(),
  }
}

/**
 * The driver over the pinned SDK, with the person's own environment and settings.
 * @returns the driver.
 */
export function driver(): ClaudeCodeDriver {
  return new ClaudeCodeDriver({ sdk: () => loadClaudeSdk(locateSdk()), harnessToolTimeoutMs: () => 900_000 })
}

/**
 * Read events until the turn ends, logging each one briefly.
 * @param session - the session.
 * @param log - the log.
 * @param onEvent - called with each event before the next is read.
 * @returns the events.
 */
export async function readTurn(session: ProgramSession, log: Log, onEvent?: (event: ProgramEvent) => Promise<void> | void): Promise<ProgramEvent[]> {
  const signal = AbortSignal.timeout(240_000)
  const events: ProgramEvent[] = []
  for (;;) {
    const event = await session.next(signal)
    events.push(event)
    log.line('event', brief(event))
    await onEvent?.(event)
    if (event.kind === 'turn-end') return events
  }
}

function brief(event: ProgramEvent): string {
  switch (event.kind) {
    case 'text':
    case 'reasoning':
      return `${event.kind} ${event.text.slice(0, 200)}`
    case 'tool-call':
      return `tool-call ${event.name} ${event.input.slice(0, 200)}`
    case 'tool-result':
      return `tool-result ${event.isError ? 'error' : 'ok'} ${event.output.slice(0, 120)}`
    case 'message-end':
      return `message-end ${JSON.stringify(event.usage ?? {})}`
    case 'turn-end':
      return `turn-end ${event.outcome} ${JSON.stringify(event.failure ?? {})} ${JSON.stringify(event.usage ?? {})}`
    default: {
      const unknown: never = event
      return JSON.stringify(unknown)
    }
  }
}

/**
 * The text of a turn's events.
 * @param events - the events.
 * @returns the text blocks joined.
 */
export function textOf(events: readonly ProgramEvent[]): string {
  return events.flatMap(event => event.kind === 'text' ? [event.text] : []).join(' ')
}

/**
 * The process ids whose working folder is inside a task folder (Linux).
 * @param folder - the task folder.
 * @returns the processes with their command names.
 */
export function processesIn(folder: string): { pid: number, name: string }[] {
  const found: { pid: number, name: string }[] = []
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const cwd = readlinkSync(`/proc/${entry}/cwd`)
      if (cwd === folder || cwd.startsWith(`${folder}/`)) found.push({ pid: Number(entry), name: readFileSync(`/proc/${entry}/comm`, 'utf8').trim() })
    } catch (_gone) {
      // The process ended or belongs to another user while the table was read.
    }
  }
  return found
}
