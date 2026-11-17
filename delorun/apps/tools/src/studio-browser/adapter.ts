/**
 * The `StudioBrowser` adapter seam of `studio-browser`: one interface a browser tool implements, and the registry that
 * selects an implementation by id. Add an adapter by implementing {@link StudioBrowser} and adding it to {@link ADAPTERS}.
 *
 * @module @delorun/tools/studio-browser/adapter
 */
import { createBrowseAdapter, type BrowseDeps } from './browse.ts'
import { createPlaywrightAdapter } from './playwright.ts'
import type { LoopbackOrigin } from './origin.ts'
import type { Step } from './steps.ts'

/** The outcome of {@link StudioBrowser.check}. */
export interface BrowserCheck {
  /** True when the browser tool can run a script now. */
  readonly ok: boolean
  /** The tool's own status lines, or why it cannot run. */
  readonly detail: string
}

/** One script run in a browser. */
export interface RunSpec {
  /** The only origin the run may reach. */
  readonly origin: LoopbackOrigin
  /** The address the run opens first, a studio sign-in link included. It is on {@link RunSpec.origin}. */
  readonly startUrl: string
  /** The body of an async function that receives Playwright's `page` and may `return` a JSON value; absent when only steps or a screenshot are asked for. */
  readonly code?: string
  /** The viewport in CSS pixels; the adapter's own default when absent. Only the `playwright` adapter honours it. */
  readonly viewport?: { readonly width: number, readonly height: number }
  /** The `prefers-color-scheme` the page sees. Only the `playwright` adapter honours it. */
  readonly scheme?: 'light' | 'dark'
  /** The JSON steps to run after the page is idle and before `code`. Only the `playwright` adapter honours them. */
  readonly steps?: readonly Step[]
  /** Absolute path of the `.png` taken after steps and code. Only the `playwright` adapter honours it. */
  readonly screenshotTo?: string
  /** Absolute path of the `.webm` file to record the run to; the run is not recorded when absent. */
  readonly recordTo?: string
  /** The script's time limit in milliseconds. */
  readonly timeoutMs: number
}

/** The outcome of {@link StudioBrowser.run}. */
export interface RunResult {
  /** True when the script ran to its end and every cleanup step succeeded. */
  readonly ok: boolean
  /** The script's printed output, or the failing step's output; cleanup failures are appended. */
  readonly output: string
  /** The recording's path when one was written. */
  readonly recording?: string
}

/** A browser tool that runs scripts against a studio on this computer. */
export interface StudioBrowser {
  /** The id `--adapter` and `DELORUN_STUDIO_BROWSER` select by. */
  readonly id: string
  /**
   * Report whether the tool can run a script now.
   * @returns the verdict and the tool's status lines.
   * @throws Error when the tool cannot be located.
   */
  check(): BrowserCheck
  /**
   * Run a script in a session of its own and end the session afterwards.
   * @param spec - the script, its origin and its limits.
   * @returns the outcome; a failed step is `ok: false`, not a throw.
   * @throws Error when the tool cannot be located.
   */
  run(spec: RunSpec): RunResult
}

/** The adapters by id. */
export const ADAPTERS: Readonly<Record<string, (deps: BrowseDeps) => StudioBrowser>> = {
  playwright: createPlaywrightAdapter,
  browse: createBrowseAdapter,
}

/**
 * Create the adapter with the given id.
 * @param id - an id from {@link ADAPTERS}.
 * @param deps - the process, environment and file access the adapter uses.
 * @returns the adapter.
 * @throws Error naming the known ids when `id` is unknown.
 */
export function selectAdapter(id: string, deps: BrowseDeps): StudioBrowser {
  const create = Object.hasOwn(ADAPTERS, id) ? ADAPTERS[id] : undefined
  if (create === undefined) throw new Error(`unknown studio-browser adapter "${id}"; known adapters: ${Object.keys(ADAPTERS).join(', ')}`)
  return create(deps)
}
