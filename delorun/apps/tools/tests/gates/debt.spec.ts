import { describe, expect, it } from 'vitest'
import { DEBT_PATH, debtVerdict, parseDebt, readDebt, withDebt } from '../../src/checks/gates/debt.ts'
import { GATES } from '../../src/checks/gates/index.ts'
import type { GateCheck } from '../../src/checks/types.ts'

const LINT: GateCheck = { id: 'gates:lint', title: 'lint', command: ['pnpm', 'run', 'lint'], inputs: ['**'] }
const QUICK: GateCheck = { id: 'gates:quick', title: 'quick', command: ['node', 'quick.ts'] }

describe('the gate debt list', () => {
  it('fails the run when a listed gate passes, until its entry is removed', () => {
    expect(debtVerdict('gates:lint', 0, 'findings')).toEqual({ failed: true, line: `gates:lint: passes, so remove its entry from ${DEBT_PATH}` })
  })

  it('reports a listed gate\'s failure without failing the run, and fails a run that reported nothing', () => {
    expect(debtVerdict('gates:lint', 1, '49 findings')).toEqual({ failed: false, line: `gates:lint: reported, not failing: listed in ${DEBT_PATH} (49 findings)` })
    expect(debtVerdict('gates:lint', null, '49 findings').failed).toBe(true)
  })

  it('runs a listed gate through the debt module with the list among its inputs, and leaves the others unchanged', () => {
    const [lint, quick] = withDebt([LINT, QUICK], { 'gates:lint': 'findings' })
    expect(lint?.command).toEqual(['node_modules/.bin/tsx', 'delorun/apps/tools/src/checks/gates/debt.ts', 'gates:lint', '--', 'pnpm', 'run', 'lint'])
    expect(lint?.inputs).toEqual(['**', DEBT_PATH, 'delorun/apps/tools/src/checks/gates/debt.ts'])
    expect(quick).toBe(QUICK)
  })

  it('refuses an entry for a gate the catalogue does not hold, an entry without a reason and a reason over several lines', () => {
    expect(() => withDebt([QUICK], { 'gates:lint': 'findings' })).toThrow(`${DEBT_PATH} lists gates:lint, which no gate is named`)
    expect(() => parseDebt('{"gates":{"gates:lint":" "}}')).toThrow('a debt entry needs its reason')
    expect(() => parseDebt('{"gates":{"gates:lint":"one\\ntwo"}}')).toThrow('a debt reason is one line')
    expect(() => parseDebt('{"gates":{"lint":"findings"}}')).toThrow('a debt entry names a gate id')
  })

  it('names only gates of the catalogue, each run through the debt module', () => {
    const debt = readDebt()
    expect(Object.keys(debt).length).toBeGreaterThan(0)
    for (const id of Object.keys(debt)) expect(GATES.find(gate => gate.id === id)?.command.slice(1, 4)).toEqual(['delorun/apps/tools/src/checks/gates/debt.ts', id, '--'])
  })
})
