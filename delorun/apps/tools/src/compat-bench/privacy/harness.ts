/**
 * A small harness that runs a fixture script under the privacy hooks on this machine, with no container: for the
 * observer's own tests and for checking a fixture before the runner exists. Only the repository's own fixtures run
 * through it; a third-party plugin runs only inside the bench's containers.
 *
 * @module @delorun/tools/compat-bench/privacy/harness
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEvents, summarise } from './events.ts'
import type { EventSummary } from './events.ts'
import type { HookEvent } from './types.ts'

/** The preload's absolute path. */
export const PRELOAD_PATH = fileURLToPath(new URL('./preload.mjs', import.meta.url))

/** What a fixture run produced. */
export type HookedRun = Readonly<{ events: ReadonlyArray<HookEvent>; summary: EventSummary; stdout: string; stderr: string; status: number | null }>

/**
 * Run a Node script with the hooks loaded.
 * @param script - the script's absolute path.
 * @param options - extra environment, the watch list, the working directory and arguments.
 * @returns the events and the script's output.
 */
export async function runWithHooks(script: string, options: Readonly<{ env?: Readonly<Record<string, string>>; watch?: ReadonlyArray<{ label: string; path: string }>; cwd?: string; args?: ReadonlyArray<string> }> = {}): Promise<HookedRun> {
  const dir = await mkdtemp(join(tmpdir(), 'bench-privacy-'))
  try {
    const log = join(dir, 'events.jsonl')
    const env = { ...process.env, ...options.env, DELORUN_PRIVACY_LOG: log, DELORUN_PRIVACY_WATCH: JSON.stringify(options.watch ?? []), NODE_OPTIONS: `--import ${PRELOAD_PATH}` }
    const child = spawn(process.execPath, [script, ...options.args ?? []], { env, cwd: options.cwd ?? dir, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    const status = await new Promise<number | null>((done) => { child.on('close', done) })
    const text = await readFile(log, 'utf8').catch(() => '')
    const events = parseEvents(text)
    return { events, summary: summarise(events), stdout, stderr, status }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
