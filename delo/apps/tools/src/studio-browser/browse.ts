/**
 * The `browse` adapter: drives the person's own Chrome through the `browse` CLI (https://github.com/anomalyco/browse).
 * Every process call, environment read and file write goes through {@link BrowseDeps}, so specs spawn nothing. A run
 * uses a session of its own, limited to the studio's origin, and deletes it on every path.
 *
 * @module @delo/tools/studio-browser/browse
 */
import { errorMessage } from './message.ts'
import type { BrowserCheck, RunResult, RunSpec, StudioBrowser } from './adapter.ts'

/** What a finished child process left behind; `status` is null when it could not start or was killed. */
export interface ProcessResult {
  /** The exit code. */
  readonly status: number | null
  /** Standard output. */
  readonly stdout: string
  /** Standard error, or the spawn error's message. */
  readonly stderr: string
}

/** Runs one child process to its end. */
export type ProcessRunner = (file: string, args: readonly string[], options: { readonly timeoutMs?: number }) => ProcessResult

/** Everything the adapter reads or writes outside its own memory. */
export interface BrowseDeps {
  /** Runs `browse`, `cmd.exe` and `wslpath`. */
  readonly run: ProcessRunner
  /** The environment: `DELO_BROWSE_BIN` and `WSL_DISTRO_NAME`. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** Eight random lowercase hex digits for the session name. */
  readonly randomHex: () => string
  /** Write a script to a new temporary file and return its path. */
  readonly writeTemp: (code: string) => string
  /** Remove a file written by `writeTemp`. */
  readonly removeTemp: (path: string) => void
}

/** The project's install page, named when no binary is found. */
export const INSTALL_PAGE = 'https://github.com/anomalyco/browse'

/** Time allowed for quick `browse` calls such as `--version` and `session new`. */
const QUICK_MS = 30_000

/** Time added to the script's limit before the `execute` process is killed. */
const EXECUTE_GRACE_MS = 15_000

/** The Windows install's path under the Windows profile directory. */
const WINDOWS_INSTALL = '.local/bin/browse.exe'

/**
 * Whether a binary answers `--version`.
 * @param deps - process access.
 * @param file - the binary.
 * @returns true when it exits 0.
 */
function answers(deps: BrowseDeps, file: string): boolean {
  return deps.run(file, ['--version'], { timeoutMs: QUICK_MS }).status === 0
}

/**
 * The Windows install seen from WSL.
 * @param deps - process access.
 * @returns the WSL path of `browse.exe` when the profile directory resolves and it answers, else undefined.
 */
function windowsInstall(deps: BrowseDeps): string | undefined {
  const profile = deps.run('cmd.exe', ['/c', 'echo %USERPROFILE%'], { timeoutMs: QUICK_MS })
  if (profile.status !== 0 || profile.stdout.trim() === '') return undefined
  const converted = deps.run('wslpath', ['-u', profile.stdout.trim()], { timeoutMs: QUICK_MS })
  if (converted.status !== 0) return undefined
  const candidate = `${converted.stdout.trim()}/${WINDOWS_INSTALL}`
  return answers(deps, candidate) ? candidate : undefined
}

/**
 * Find the `browse` binary: `DELO_BROWSE_BIN`, then `browse` on `PATH`, then under WSL the Windows install.
 * @param deps - process and environment access.
 * @returns the command to run.
 * @throws Error naming the three places and the install page when none answers.
 */
export function locateBrowse(deps: BrowseDeps): string {
  const configured = deps.env.DELO_BROWSE_BIN
  if (configured !== undefined && configured !== '') {
    if (answers(deps, configured)) return configured
    throw new Error(`DELO_BROWSE_BIN is set to ${configured}, which does not answer \`--version\``)
  }
  if (answers(deps, 'browse')) return 'browse'
  if (deps.env.WSL_DISTRO_NAME !== undefined && deps.env.WSL_DISTRO_NAME !== '') {
    const found = windowsInstall(deps)
    if (found !== undefined) return found
  }
  throw new Error(`browse not found: looked at DELO_BROWSE_BIN, \`browse\` on PATH, and under WSL the Windows install at %USERPROFILE%\\${WINDOWS_INSTALL.replaceAll('/', '\\')}; install it from ${INSTALL_PAGE}`)
}

/**
 * Format a failed process for the run's output.
 * @param label - the step's name.
 * @param result - what the step left behind.
 * @returns the label, the exit status and the step's output.
 */
function failure(label: string, result: ProcessResult): string {
  const text = [result.stderr.trim(), result.stdout.trim()].filter(part => part !== '').join('\n')
  return `${label} failed (exit ${String(result.status)})${text === '' ? '' : `:\n${text}`}`
}

/** A step that exited non-zero; the message is its report. */
class StepError extends Error {}

/**
 * Create the `browse` adapter.
 * @param deps - process, environment and file access.
 * @returns the adapter; the binary is located on the first `check` or `run`.
 */
export function createBrowseAdapter(deps: BrowseDeps): StudioBrowser {
  return {
    id: 'browse',
    check(): BrowserCheck {
      const result = deps.run(locateBrowse(deps), ['doctor'], { timeoutMs: QUICK_MS })
      const detail = result.stdout.split('\n').slice(0, 4).join('\n').trim()
      if (result.status === 0 && result.stdout.includes('Status: ok')) return { ok: true, detail }
      return { ok: false, detail: detail === '' ? failure('browse doctor', result) : detail }
    },
    run(spec: RunSpec): RunResult {
      const bin = locateBrowse(deps)
      const windows = bin.toLowerCase().endsWith('.exe')
      const name = `delo-studio-${deps.randomHex()}`
      const toBrowsePath = (path: string): string => {
        if (!windows) return path
        const converted = deps.run('wslpath', ['-w', path], { timeoutMs: QUICK_MS })
        if (converted.status !== 0) throw new StepError(failure('wslpath', converted))
        return converted.stdout.trim()
      }
      const step = (label: string, args: readonly string[], timeoutMs = QUICK_MS): ProcessResult => {
        const result = deps.run(bin, args, { timeoutMs })
        if (result.status !== 0) throw new StepError(failure(label, result))
        return result
      }

      const cleanup: string[] = []
      let ok = false
      let output = ''
      let recording: string | undefined
      let tempFile: string | undefined
      let recordingOpen = false
      try {
        step('browse session new', ['session', 'new', '--allow-origin', spec.origin, name])
        if (spec.recordTo !== undefined) {
          // A recording needs an attached tab, and a new session has none until a script opens one.
          step('browse open', ['execute', '-s', name, `await page.goto(${JSON.stringify(`${spec.origin}/`)}); return null`])
          step('browse recording start', ['recording', 'start', '-s', name, '--frame-rate', '15', toBrowsePath(spec.recordTo)])
          recordingOpen = true
        }
        tempFile = deps.writeTemp(spec.code)
        const executed = step('browse execute', [
          'execute', '-s', name, '--timeout-ms', String(spec.timeoutMs), '--file', toBrowsePath(tempFile),
        ], spec.timeoutMs + EXECUTE_GRACE_MS)
        output = executed.stdout
        if (spec.recordTo !== undefined) {
          step('browse recording stop', ['recording', 'stop', '-s', name])
          recordingOpen = false
          recording = spec.recordTo
        }
        ok = true
      } catch (error) {
        output = errorMessage(error)
      } finally {
        if (recordingOpen) {
          const cancelled = deps.run(bin, ['recording', 'cancel', '-s', name], { timeoutMs: QUICK_MS })
          if (cancelled.status !== 0) cleanup.push(failure('browse recording cancel', cancelled))
        }
        const deleted = deps.run(bin, ['session', 'delete', name], { timeoutMs: QUICK_MS })
        if (deleted.status !== 0) cleanup.push(failure(`browse session delete ${name}`, deleted))
        if (tempFile !== undefined) {
          try {
            deps.removeTemp(tempFile)
          } catch (error) {
            cleanup.push(`removing ${tempFile} failed: ${errorMessage(error)}`)
          }
        }
      }
      const text = [output, ...cleanup].filter(part => part !== '').join('\n')
      return { ok: ok && cleanup.length === 0, output: text, ...(recording === undefined ? {} : { recording }) }
    },
  }
}
