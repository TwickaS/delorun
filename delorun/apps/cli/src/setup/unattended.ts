/**
 * The answers of the setup flags `--phone` (or its alias `--devices`), `--import-dsh` and `--port <n>` in a run that asks no questions (`--yes`, or
 * `delorun setup` without a terminal). `--phone` and `--import-dsh` run the same section as the questions do, over a
 * prompter that accepts each question's preselected answer and prints each note, so the checks, the summary and the
 * import's plan are the ones a terminal run shows.
 *
 * @module @delorun/cli/setup/unattended
 */
import type { SetupAnswers } from '@delorun/contract-setup-answers'
import { SETUP_DEFAULT_PORT } from '@delorun/contract-setup-answers'
import { CliError, EXIT } from '../exit.ts'
import type { CommandOutput } from '../command.ts'
import { portProblem, type SectionEnvironment, type SectionRegistry, withRecord } from './sections.ts'
import { stepIO } from './steps.ts'
import type { Prompter } from './prompts.ts'

/** The setup flags that answer a question of the main flow. */
export interface AnswerFlags {
  /** `--phone` or `--devices`: turn device access on. */
  readonly phone?: boolean
  /** `--import-dsh`: copy the DeepSeek Harness chats. */
  readonly importDsh?: boolean
  /** `--port <n>`: the studio port. */
  readonly port?: number
}

/**
 * Check a `--port` value.
 * @param value - the text after `--port`.
 * @returns the port.
 * @throws {CliError} `EXIT.usage` when it is not a port from 1024 to 65535.
 */
export function portFromFlag(value: string): number {
  const problem = portProblem(value)
  if (problem !== undefined) throw new CliError(EXIT.usage, `delorun setup: --port ${value}: ${problem}`)
  return Number(value)
}

/**
 * The answers a flag pre-selects, for the questions of a terminal run.
 * @param flags - the flags.
 * @returns the answers the flags set.
 */
export function flagDefaults(flags: AnswerFlags): Partial<SetupAnswers> {
  return {
    ...flags.phone === true ? { reach: { option: 'tailscale-private', identityFactor: 'tailnet-membership' } } : {},
    ...flags.importDsh === true ? { importStockHome: true } : {},
    ...flags.port === undefined ? {} : { profile: { name: null, port: flags.port === SETUP_DEFAULT_PORT ? null : flags.port } },
  }
}

/**
 * A prompter that answers every question with its preselected choice and collects every note.
 * @param notes - receives each note's title and body in order.
 * @returns the prompter; a question that needs typed text is a defect of the caller and throws.
 */
function acceptingPrompter(notes: [string, string][]): Prompter {
  const refuse = (): never => { throw new Error('delorun setup: a question that needs typed text was asked in a run without a terminal') }
  return {
    select: (_message, _options, initial) => Promise.resolve(initial),
    confirm: (_message, initial) => Promise.resolve(initial),
    secret: refuse,
    text: refuse,
    note(body, title) {
      notes.push([title, body])
    },
  }
}

/**
 * Apply `--phone`, `--import-dsh` and `--port` to the answers of a run without questions.
 * @param flags - the flags.
 * @param answers - the answers so far.
 * @param registry - the sections.
 * @param environment - what the sections may look at.
 * @param output - where the checks and the summary are printed.
 * @returns the answers with the flags applied.
 * @throws {CliError} `EXIT.failed` when `--phone` finds Tailscale not ready, with the check's message, or when `--port` names a busy port.
 */
export async function applyAnswerFlags(flags: AnswerFlags, answers: SetupAnswers, registry: SectionRegistry, environment: SectionEnvironment, output: CommandOutput): Promise<SetupAnswers> {
  let next: SetupAnswers = { ...answers, ...flagDefaults(flags.port === undefined ? {} : { port: flags.port }) }
  if (flags.port !== undefined && !await environment.portIsFree(flags.port)) {
    throw new CliError(EXIT.failed, `delorun setup --port ${String(flags.port)}: port ${String(flags.port)} is in use on this computer; choose another`)
  }
  const notes: [string, string][] = []
  const io = stepIO(acceptingPrompter(notes), false)
  const print = (): void => {
    for (const [, body] of notes.splice(0)) output.stdout(`${body}\n`)
  }
  const reach = registry.find('reach')
  if (flags.phone === true && reach !== undefined) {
    const given = await reach.ask(io, { phase: 'main', answers: { ...next, ...flagDefaults({ phone: true }) }, secret: undefined }, environment)
    if (typeof given === 'symbol' || given.answers.reach?.option !== 'tailscale-private') {
      throw new CliError(EXIT.failed, `delorun setup --phone: ${(notes.find(([title]) => title === 'Remote access')?.[1] ?? 'Tailscale is not ready').replace(/\nRemote access stays off.*$/su, '')}`)
    }
    print()
    next = { ...next, ...given.answers, sections: withRecord(next.sections, reach.id, given.status) }
  }
  const stock = registry.find('import')
  if (flags.importDsh === true && stock !== undefined) {
    if (!stock.appliesTo(environment)) {
      output.stdout('delorun setup --import-dsh: there is no DeepSeek Harness home to copy, so nothing was imported.\n')
    } else {
      const given = await stock.ask(io, { phase: 'main', answers: next, secret: undefined }, environment)
      print()
      if (typeof given !== 'symbol') next = { ...next, ...given.answers, sections: withRecord(next.sections, stock.id, given.status) }
    }
  }
  return next
}
