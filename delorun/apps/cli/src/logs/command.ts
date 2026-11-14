/**
 * `delorun logs` as a row of the command table: it resolves the home and the CLI profile without creating
 * anything, asks for `--clear`'s confirmation on the terminal, and ends `--follow` on an interrupt.
 *
 * @module @delorun/cli/logs/command
 */
import { createInterface } from 'node:readline/promises'
import type { CliCommand } from '../command.ts'
import { resolveDelorunHome } from '@delorun/home'
import { selectCommandProfile } from '../profile.ts'
import { runLogs } from './index.ts'

/**
 * Ask a yes-or-no question on the terminal. Without a terminal on both standard input and standard output the
 * answer is no, so a clear never happens unasked.
 * @param question - the question.
 * @param stderr - where the refusal is explained when no terminal can ask.
 * @returns whether the person answered yes.
 */
async function confirmOnTerminal(question: string, stderr: (text: string) => void): Promise<boolean> {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    stderr('delorun logs: --clear asks for confirmation, which needs a terminal\n')
    return false
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return /^y(es)?$/i.test((await prompt.question(`${question} [y/N] `)).trim())
  } finally {
    prompt.close()
  }
}

/** `delorun logs [<surface>] [options]` (contract C20). */
export const logsCommand: CliCommand = {
  name: 'logs',
  summary: 'Show where each operational log is and its recent records; follow, clear or prune them',
  async run(args, context) {
    // `runLogs` parses `--profile` itself; every value it could read is held to C1's rule first.
    const profile = selectCommandProfile('logs', args, context.env)
    const home = await resolveDelorunHome(context.env)
    const interrupt = new AbortController()
    const stop = (): void => { interrupt.abort() }
    process.once('SIGINT', stop)
    try {
      return await runLogs(args, {
        home: home.path,
        profile,
        stdout: context.stdout,
        stderr: context.stderr,
        confirm: question => confirmOnTerminal(question, context.stderr),
        now: Date.now,
        signal: interrupt.signal,
      })
    } finally {
      process.off('SIGINT', stop)
    }
  },
}
