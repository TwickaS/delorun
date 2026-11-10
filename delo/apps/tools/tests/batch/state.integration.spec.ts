/**
 * The batch's state file: a state round-trips, a file that is not JSON or not a state of this version is refused, step
 * kinds are tested, and the file port writes whole files.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BatchError } from '../../src/batch/errors.ts'
import { nodeFiles, ofKind, parseState, stateText, STATE_VERSION, type BatchState } from '../../src/batch/state.ts'
import { cleanUp, tempDir } from './fixtures.ts'

afterEach(cleanUp)

const SHA = 'a'.repeat(40)
const state: BatchState = {
  version: STATE_VERSION,
  id: '20261110-120000',
  trunk: 'v5',
  remote: 'origin',
  land: true,
  start: SHA,
  lanes: [{ name: 'lane/a', tip: SHA, base: SHA, commits: [SHA], merges: [] }],
  candidate: SHA,
  steps: { 'round:0:gate': { kind: 'gate', commit: SHA, gate: { kind: 'passed' } } },
  outcome: { kind: 'landed', commit: SHA },
}

describe('parseState', () => {
  it('reads what stateText writes', () => {
    expect(stateText(state).endsWith('}\n')).toBe(true)
    expect(parseState(stateText(state), 'state.json')).toEqual(state)
  })

  it('refuses text that is not JSON, and JSON of another version', () => {
    expect(() => parseState('{', 'state.json')).toThrow(/state.json is not JSON/)
    expect(() => parseState(JSON.stringify({ ...state, version: 2 }), 'state.json')).toThrow(BatchError)
    expect(() => parseState(JSON.stringify({ ...state, version: 2 }), 'state.json')).toThrow(/version: /)
  })
})

describe('ofKind', () => {
  it('accepts the named kinds only', () => {
    const gate = state.steps['round:0:gate']
    if (gate === undefined) throw new Error('no step')
    expect(ofKind('gate', 'rerun')(gate)).toBe(true)
    expect(ofKind('trial')(gate)).toBe(false)
  })
})

describe('nodeFiles', () => {
  it('writes through a renamed temporary file, reads, and removes', () => {
    const dir = tempDir('delo-batch-files-')
    const path = join(dir, 'nested', 'state.json')
    expect(nodeFiles.read(path)).toBeUndefined()
    nodeFiles.write(path, 'one')
    nodeFiles.write(path, 'two')
    expect(nodeFiles.read(path)).toBe('two')
    expect(readdirSync(join(dir, 'nested'))).toEqual(['state.json'])
    expect(nodeFiles.exists(path)).toBe(true)
    nodeFiles.remove(path)
    nodeFiles.remove(path)
    expect(nodeFiles.exists(path)).toBe(false)
    expect(existsSync(path)).toBe(false)
  })
})
