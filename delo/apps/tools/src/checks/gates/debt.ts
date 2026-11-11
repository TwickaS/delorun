/**
 * Gate debt: the gates that fail on the integration branch, listed in `debt.json` with the reason each is not fixed
 * yet. The runner runs a listed gate through this module, which runs the gate's own command and inverts what it means
 * for the run: a failure prints the gate's findings and passes as reported debt, and a pass fails the run until the
 * entry is removed, so the list only shrinks. A gate that cannot start or ends by a signal fails the run either way,
 * because it reported nothing. Run from the repository root:
 * `node_modules/.bin/tsx delo/apps/tools/src/checks/gates/debt.ts <gate id> -- <command...>`.
 *
 * @module @delo/tools/checks/gates/debt
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import type { GateCheck } from '../types.ts'

const TSX = 'node_modules/.bin/tsx'

/** The debt list's repository path, which every listed gate declares as an input. */
export const DEBT_PATH = 'delo/apps/tools/src/checks/gates/debt.json'

/** The module that runs a listed gate. */
const DEBT_MODULE = 'delo/apps/tools/src/checks/gates/debt.ts'

const DebtFile = z.object({
  $comment: z.string().optional(),
  gates: z.record(
    z.string().regex(/^gates:[a-z0-9-]+$/u, 'a debt entry names a gate id such as gates:lint'),
    z.string().trim().min(1, 'a debt entry needs its reason').regex(/^[^\n]+$/u, 'a debt reason is one line'),
  ),
}).strict()

/** Each listed gate id with the one-line reason it is listed. */
export type GateDebt = Readonly<Record<string, string>>

/**
 * Read the debt list from its JSON text.
 * @param text - the contents of `debt.json`.
 * @returns the listed gates and their reasons.
 * @throws Error when the text is not the list's JSON, an id is not a gate id, or a reason is empty or spans lines.
 */
export function parseDebt(text: string): GateDebt {
  return DebtFile.parse(JSON.parse(text)).gates
}

/**
 * The committed debt list.
 * @returns the listed gates and their reasons.
 */
export function readDebt(): GateDebt {
  return parseDebt(readFileSync(new URL('./debt.json', import.meta.url), 'utf8'))
}

/**
 * The gates with each listed gate's command run through this module, and the list among its inputs.
 * @param gates - the runner's gates.
 * @param debt - the debt list.
 * @returns the gates, in order; an unlisted gate is unchanged.
 * @throws Error when the list names a gate the catalogue does not hold, because that entry would never be repaid.
 */
export function withDebt(gates: readonly GateCheck[], debt: GateDebt): GateCheck[] {
  const unknown = Object.keys(debt).filter(id => !gates.some(gate => gate.id === id))
  if (unknown.length > 0) throw new Error(`${DEBT_PATH} lists ${unknown.join(', ')}, which no gate is named; remove the entry or name the gate`)
  return gates.map(gate => debt[gate.id] === undefined ? gate : {
    ...gate,
    command: [TSX, DEBT_MODULE, gate.id, '--', ...gate.command],
    ...gate.inputs === undefined ? {} : { inputs: [...gate.inputs, DEBT_PATH, DEBT_MODULE] },
  })
}

/** What a listed gate's run means for the check run. */
export interface DebtVerdict {
  /** Whether the check run fails. */
  readonly failed: boolean
  /** The line the runner prints for the gate. */
  readonly line: string
}

/**
 * The verdict on one run of a listed gate.
 * @param id - the gate id.
 * @param status - the gate command's exit status, or null when it could not start or ended by a signal.
 * @param reason - the gate's reason in the list.
 * @returns a failure when the gate passed or reported nothing, and a reported pass when it failed.
 */
export function debtVerdict(id: string, status: number | null, reason: string): DebtVerdict {
  if (status === null) return { failed: true, line: `${id}: did not run to an exit status, so it reported nothing; the listed debt cannot excuse that` }
  if (status === 0) return { failed: true, line: `${id}: passes, so remove its entry from ${DEBT_PATH}` }
  return { failed: false, line: `${id}: reported, not failing: listed in ${DEBT_PATH} (${reason})` }
}

/* v8 ignore start -- the entry point runs only as the gate's command, which the integration spec runs as a child process */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [id = '', separator, program, ...args] = process.argv.slice(2)
  const reason = readDebt()[id]
  if (separator !== '--' || program === undefined || reason === undefined) {
    console.error(`usage: tsx ${DEBT_MODULE} <gate id listed in ${DEBT_PATH}> -- <command...>`)
    process.exitCode = 2
  } else {
    const result = spawnSync(program, args, { stdio: 'inherit' })
    const verdict = debtVerdict(id, result.error === undefined ? result.status : null, reason)
    if (verdict.failed) console.error(verdict.line)
    else console.log(verdict.line)
    process.exitCode = verdict.failed ? 1 : 0
  }
}
/* v8 ignore stop */
