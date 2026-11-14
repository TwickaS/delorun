import { describe, expect, it } from 'vitest'
import { readDebt } from '../../src/checks/gates/debt.ts'
import { REPO, runTsx } from './support.ts'

const MODULE = 'delorun/apps/tools/src/checks/gates/debt.ts'
const LISTED = Object.keys(readDebt())[0] ?? ''

describe('a listed gate run through the debt module', () => {
  it('fails the run when the gate passes, naming the entry to remove', () => {
    const run = runTsx(REPO, MODULE, [LISTED, '--', process.execPath, '-e', 'process.exit(0)'])
    expect(run.status).toBe(1)
    expect(run.output).toContain(`${LISTED}: passes, so remove its entry from delorun/apps/tools/src/checks/gates/debt.json`)
  })

  it('passes the run when the gate fails, after printing the gate\'s own findings', () => {
    const run = runTsx(REPO, MODULE, [LISTED, '--', process.execPath, '-e', 'console.error("finding one"); process.exit(1)'])
    expect(run.status).toBe(0)
    expect(run.output).toContain('finding one')
    expect(run.output).toContain(`${LISTED}: reported, not failing`)
  })

  it('fails the run when the gate cannot start, and refuses a gate the list does not name', () => {
    expect(runTsx(REPO, MODULE, [LISTED, '--', 'delorun-no-such-program']).status).toBe(1)
    expect(runTsx(REPO, MODULE, ['gates:not-listed', '--', process.execPath, '-e', '0']).status).toBe(2)
  })
})
