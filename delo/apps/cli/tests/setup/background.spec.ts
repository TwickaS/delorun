import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readBackgroundAnswer } from '../../src/setup/background.ts'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'delorun-background-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('the background answer', () => {
  it('reads the recorded answer', () => {
    writeFileSync(join(directory, 'setup-answers.json'), JSON.stringify({ version: 1, background: false }))
    expect(readBackgroundAnswer(directory)).toBe(false)
    writeFileSync(join(directory, 'setup-answers.json'), JSON.stringify({ version: 1, background: true }))
    expect(readBackgroundAnswer(directory)).toBe(true)
  })

  it('keeps the default, yes, when the record is missing, unreadable or lacks the answer', () => {
    expect(readBackgroundAnswer(directory)).toBe(true)
    writeFileSync(join(directory, 'setup-answers.json'), 'not json')
    expect(readBackgroundAnswer(directory)).toBe(true)
    writeFileSync(join(directory, 'setup-answers.json'), JSON.stringify({ version: 1, background: 'no' }))
    expect(readBackgroundAnswer(directory)).toBe(true)
  })
})
