/**
 * What `delorun update` shows while the home process installs the update's target: the same checklist the launcher
 * draws, from the install events the home process sends as `install` fields of its progress lines. A line from a home
 * process that still sends text is printed as it is.
 *
 * @module @delorun/cli/update/progress
 */
import { createRenderer, isInstallerProgress, type InstallRenderer, type RenderStream } from '@delorun/install'
import type { ResponseLine } from '@delorun/home-process'
import type { UpdateInstallEvent } from '@delorun/runtime-store'
import type { CommandOutput } from '../command.ts'

/** The display of one request to the home process. */
export interface UpdateDisplay {
  /**
   * Show one progress line of the home process.
   * @param line - the line.
   */
  readonly onLine: (line: ResponseLine) => void
  /**
   * Show one step of an install.
   * @param event - the step; a value that is not an install step is ignored.
   */
  readonly report: (event: UpdateInstallEvent) => void
  /**
   * Ask a question on the terminal the checklist is drawn on: the checklist waits while the question is asked.
   * @param question - asks it.
   * @returns the answer.
   */
  readonly asking: <T>(question: () => Promise<T>) => Promise<T>
  /** End the display after a request that was answered; the checklist's last phase has ended already. */
  readonly close: () => void
  /** End the display of a request that failed: the running phase is marked failed, and the error's own text follows. */
  readonly fail: () => void
}

/**
 * Open the display of one request.
 * @param output - where the command writes.
 * @param env - the command's environment, for `NO_COLOR` and `TERM`.
 * @param stream - the stream `output.stdout` writes to, for its terminal flag and width; standard output by default.
 * @returns the display.
 */
export function updateDisplay(output: CommandOutput, env: Readonly<Record<string, string | undefined>>, stream: RenderStream = process.stdout): UpdateDisplay {
  const renderer: InstallRenderer = createRenderer(text => { output.stdout(text) }, stream, env)
  const report = (event: UpdateInstallEvent): void => {
    if (isInstallerProgress(event)) renderer.handle(event)
  }
  return {
    report,
    asking: async (question) => {
      renderer.suspend()
      try {
        return await question()
      } finally {
        renderer.resume()
      }
    },
    onLine: (line) => {
      if (!line.ok) return
      if (typeof line.phase === 'string') output.stdout(`… ${line.phase}\n`)
      if (typeof line.line === 'string') output.stdout(line.line)
      if (isInstallerProgress(line.install)) report(line.install)
    },
    close: () => { renderer.close() },
    fail: () => { renderer.fail() },
  }
}
