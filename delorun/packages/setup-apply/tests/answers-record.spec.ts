/** The answers record: reading it, the answers it holds, and its rewrite, which only a profile that ran setup has. */
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SETUP_DEFAULTS } from '@delorun/contract-setup-answers'
import { ANSWERS_FILENAME, backgroundOf, promptsOf, readAnswersRecord, updateAnswersRecord } from '../src/answers-record.ts'
import { SetupApplyError } from '../src/errors.ts'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'delorun-answers-record-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

const record = (): string => join(directory, ANSWERS_FILENAME)

describe('reading the record', () => {
  it('has none for a profile that never ran setup, a file that is not JSON and a JSON file that is not an object', () => {
    expect(readAnswersRecord(directory)).toBeUndefined()
    for (const text of ['{ not json', '[1]', 'null', '"text"']) {
      writeFileSync(record(), text)
      expect(readAnswersRecord(directory), text).toBeUndefined()
    }
  })

  it('reads what setup recorded, and gives setup\'s defaults for what it does not hold', () => {
    writeFileSync(record(), JSON.stringify({ version: 1, prompts: 'stock', background: false }))
    const held = readAnswersRecord(directory)
    expect([promptsOf(held), backgroundOf(held)]).toEqual(['stock', false])
    expect([promptsOf(undefined), backgroundOf(undefined)]).toEqual([SETUP_DEFAULTS.prompts, SETUP_DEFAULTS.background])
    expect([promptsOf({ prompts: 'anything' }), backgroundOf({ background: 'yes' })]).toEqual([SETUP_DEFAULTS.prompts, SETUP_DEFAULTS.background])
  })
})

describe('rewriting the record', () => {
  it('keeps every key the change leaves, writes at mode 0600 and leaves no temporary file', async () => {
    writeFileSync(record(), JSON.stringify({ version: 1, prompts: 'safer', background: true, profile: { name: null, port: null } }))
    chmodSync(record(), 0o644)
    const written = await updateAnswersRecord(directory, current => ({ ...current, prompts: 'stock' }))
    expect(written).toEqual({ version: 1, prompts: 'stock', background: true, profile: { name: null, port: null } })
    expect(JSON.parse(readFileSync(record(), 'utf8'))).toEqual(written)
    expect(statSync(record()).mode & 0o777).toBe(0o600)
    expect(readdirSync(directory)).toEqual([ANSWERS_FILENAME])
  })

  it('refuses a profile with no record and creates none', async () => {
    await expect(updateAnswersRecord(directory, current => current)).rejects.toThrow(SetupApplyError)
    await expect(updateAnswersRecord(directory, current => current)).rejects.toThrow('has no setup answers to change')
    expect(existsSync(record())).toBe(false)
  })

  it('refuses a record that is not a JSON object, leaving it as it is', async () => {
    for (const text of ['{ not json', '[1]']) {
      writeFileSync(record(), text)
      await expect(updateAnswersRecord(directory, current => ({ ...current, prompts: 'stock' })), text).rejects.toThrow('is not a setup record; it was not changed')
      expect(readFileSync(record(), 'utf8')).toBe(text)
    }
  })

  it('does not write when the change throws', async () => {
    const text = JSON.stringify({ version: 1, prompts: 'safer' })
    writeFileSync(record(), text)
    await expect(updateAnswersRecord(directory, () => { throw new Error('stop') })).rejects.toThrow('stop')
    expect(readFileSync(record(), 'utf8')).toBe(text)
  })
})
