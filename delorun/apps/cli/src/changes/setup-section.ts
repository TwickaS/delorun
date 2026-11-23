/**
 * Setup's `changes-protection` section, asked in the main flow after a phone Yes and as `delorun setup changes-protection`: whether changes to
 * the person's plugins and to Delorun itself wait for their review before they load (contract C21). The default is no,
 * which leaves the home's setting as it is; setup never turns protection off. A yes is applied through the terminal
 * proof `delorun changes protection on` uses, from setup's own standard input and output, and writes nothing when
 * protection is already on. It lives with `delorun changes` because only modules there may take a terminal proof.
 *
 * @module @delorun/cli/changes/setup-section
 */
import { attestTerminal, isChangesError, readProtection, setProtection, type AtComputer, type ProtectionLevel } from '@delorun/changes'
import { CliError, EXIT } from '../exit.ts'
import type { SetupSection } from '../setup/sections.ts'
import { BACK } from '../setup/steps.ts'

/** The section's place in the flow: right after the phone question, which brings it. */
export const CHANGES_PROTECTION_SECTION_ORDER = 13

/** The streams whose being terminals proves the person is at their computer. */
export type TerminalStreams = Parameters<typeof attestTerminal>[0]

/** The question. */
export const PROTECTION_QUESTION = 'Hold changes to your plugins and to Delorun itself for your review before they load?'

/** The one-line explanation shown before the question, for each current setting. */
const EXPLANATION: Readonly<Record<ProtectionLevel, string>> = {
  off: 'Off by default: changes load at once and are recorded, so you can undo them with delorun changes list.',
  on: 'On for this home: changes wait for your review in delorun changes list. Answering no leaves it on; delorun changes protection off turns it off.',
}

/**
 * Run a Changes read or write, reporting its typed failure as setup's.
 * @param run - the read or write.
 * @returns what it returned.
 * @throws {CliError} `EXIT.failed` with the failure's detail for a {@link ChangesError}.
 */
async function reported<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (!isChangesError(error)) throw error
    throw new CliError(EXIT.failed, `delorun setup: ${error.detail}`)
  }
}

/**
 * @param streams - setup's standard input and output.
 * @returns the terminal proof.
 * @throws {CliError} `EXIT.failed` when either stream is not a terminal, naming how to finish.
 */
function attested(streams: TerminalStreams): AtComputer {
  try {
    return attestTerminal(streams)
  } catch {
    // attestTerminal throws only its NOT_AT_COMPUTER refusal, which names the command rather than setup.
    throw new CliError(EXIT.failed, 'delorun setup: turning changes protection on needs you at a terminal; run delorun setup in one to finish, or delorun changes protection on')
  }
}

/**
 * Build the section over the streams whose terminal proof turns protection on.
 * @param streams - setup's standard input and output; `process` in a real run, read only when the answer is applied.
 * @returns the section.
 */
export function changesProtectionSection(streams: TerminalStreams): SetupSection {
  return {
    id: 'changes-protection',
    title: 'Changes protection',
    // The phone answer brings this question: remote access without a hold on changes is the pairing the person should weigh.
    inMainFlow: draft => draft.answers.reach.option === 'tailscale-private' ? 'asked' : 'never',
    asks: () => true,
    appliesTo: () => true,
    async ask(io, draft, environment) {
      const current = await reported(() => readProtection(environment.home))
      io.note(EXPLANATION[current], 'Changes protection')
      const on = await io.confirm(PROTECTION_QUESTION, draft.answers.protectChanges || current === 'on')
      return on === BACK ? BACK : { answers: { protectChanges: on }, status: 'answered' }
    },
    async apply(context, answers) {
      if (!answers.protectChanges) return undefined
      if (await reported(() => readProtection(context.home)) === 'on') return undefined
      const presence = attested(streams)
      await reported(() => setProtection(context.home, 'on', presence))
      return 'Changes protection is on: changes to your plugins and to Delorun itself wait for your review in delorun changes list.'
    },
  }
}
