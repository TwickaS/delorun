/**
 * The `playwright` adapter, the default of `studio-browser`: runs a request in the Chromium that the repository's
 * Playwright install provides, headless, in a worker process ([worker](./playwright-worker.ts)) that gets the request as JSON on
 * standard input and answers with one JSON line. The browser has no profile and no sign-ins, and the worker aborts every
 * request that leaves the studio's origin.
 *
 * @module @delorun/tools/studio-browser/playwright
 */
import { fileURLToPath } from 'node:url'
import { errorMessage } from './message.ts'
import type { BrowserCheck, RunResult, RunSpec, StudioBrowser } from './adapter.ts'
import type { BrowseDeps } from './browse.ts'

/** The worker's answer, one JSON line on standard output. */
export interface WorkerAnswer {
  /** True when every step ran. */
  readonly ok: boolean
  /** The script's return value as JSON text, or the failure's message. */
  readonly output: string
  /** Where the recording was written, when one was asked for. */
  readonly recording?: string
}

/** What `check` asks the worker to report. */
export const CHECK_REQUEST = '{"check":true}'

/** Extra time on top of the script's limit for the browser to start and stop. */
const WORKER_GRACE_MS = 60_000

const WORKER_FILE = fileURLToPath(new URL('./playwright-worker.ts', import.meta.url))

/**
 * Read the worker's last standard-output line as its answer.
 * @param stdout - everything the worker printed.
 * @returns the answer, or undefined when the last line is not a worker answer.
 */
export function parseWorkerAnswer(stdout: string): WorkerAnswer | undefined {
  const line = stdout.trim().split('\n').at(-1)
  if (line === undefined || line === '') return undefined
  try {
    const value: unknown = JSON.parse(line)
    if (typeof value === 'object' && value !== null && 'ok' in value && typeof value.ok === 'boolean' && 'output' in value && typeof value.output === 'string') {
      return { ok: value.ok, output: value.output, ...('recording' in value && typeof value.recording === 'string' ? { recording: value.recording } : {}) }
    }
  } catch (error) {
    // A line that is not JSON is some other output of the worker's process, not its answer.
    void errorMessage(error)
  }
  return undefined
}

/**
 * Create the Playwright adapter.
 * @param deps - process access; the worker runs through `deps.run` with the current Node's own flags.
 * @returns the adapter.
 */
export function createPlaywrightAdapter(deps: BrowseDeps): StudioBrowser {
  const worker = (input: string, timeoutMs: number): WorkerAnswer => {
    const result = deps.run(process.execPath, [...process.execArgv, WORKER_FILE], { timeoutMs, input })
    const answer = parseWorkerAnswer(result.stdout)
    if (answer !== undefined) return answer
    const text = [result.stderr.trim(), result.stdout.trim()].filter(part => part !== '').join('\n')
    return { ok: false, output: `the Playwright worker failed (exit ${String(result.status)})${text === '' ? '' : `:\n${text}`}` }
  }
  return {
    id: 'playwright',
    check(): BrowserCheck {
      const answer = worker(CHECK_REQUEST, WORKER_GRACE_MS)
      return { ok: answer.ok, detail: answer.output }
    },
    run(spec: RunSpec): RunResult {
      const answer = worker(JSON.stringify(spec), spec.timeoutMs + WORKER_GRACE_MS)
      return { ok: answer.ok, output: answer.output, ...(answer.recording === undefined ? {} : { recording: answer.recording }) }
    },
  }
}
