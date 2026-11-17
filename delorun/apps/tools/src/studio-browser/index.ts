/**
 * Entry of the `studio-browser` modules: the adapter seam, the loopback rule and the real process, environment and
 * file access the command hands to an adapter.
 *
 * @module @delorun/tools/studio-browser
 */
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { BrowseDeps, ProcessRunner } from './browse.ts'

export { ADAPTERS, selectAdapter, type BrowserCheck, type RunResult, type RunSpec, type StudioBrowser } from './adapter.ts'
export { createBrowseAdapter, locateBrowse, type BrowseDeps, type ProcessResult, type ProcessRunner } from './browse.ts'
export { createPlaywrightAdapter, parseWorkerAnswer } from './playwright.ts'
export { errorMessage } from './message.ts'
export { loopbackOrigin, type LoopbackOrigin } from './origin.ts'

/**
 * Run a child process to its end with captured output.
 * @param file - the executable.
 * @param args - its arguments.
 * @param options - `timeoutMs` kills the process when exceeded.
 * @returns the exit status and output; a process that cannot start has status null and the error as `stderr`.
 */
export const spawnRunner: ProcessRunner = (file, args, options) => {
  const result = spawnSync(file, [...args], {
    encoding: 'utf8', timeout: options.timeoutMs, ...(options.input === undefined ? { stdio: ['ignore', 'pipe', 'pipe'] as const } : { input: options.input }),
  })
  const stderr = result.error === undefined ? result.stderr : `${result.error.message}\n${result.stderr}`
  return { status: result.status, stdout: result.stdout, stderr }
}

/**
 * The dependencies of a real run.
 * @param env - the environment to read.
 * @returns process, environment, session-name and temporary-file access; each temporary file sits in a directory of its own.
 */
export function realDeps(env: Readonly<Record<string, string | undefined>>): BrowseDeps {
  return {
    run: spawnRunner,
    env,
    randomHex: () => randomBytes(4).toString('hex'),
    writeTemp: code => {
      const path = join(mkdtempSync(join(tmpdir(), 'delorun-studio-browser-')), 'script.js')
      writeFileSync(path, code)
      return path
    },
    removeTemp: path => {
      rmSync(dirname(path), { recursive: true, force: true })
    },
  }
}
