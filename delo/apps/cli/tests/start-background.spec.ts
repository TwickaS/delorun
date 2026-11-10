import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startsDetached } from '../src/start.ts'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'delorun-start-background-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('whether delorun start detaches', () => {
  it('starts in this terminal when the person chose against the background', () => {
    writeFileSync(join(directory, 'setup-answers.json'), JSON.stringify({ version: 1, background: false }))
    expect(startsDetached(false, directory)).toBe(false)
  })

  it('detaches when the person chose the background, and when no answer is recorded', () => {
    expect(startsDetached(false, directory)).toBe(true)
    writeFileSync(join(directory, 'setup-answers.json'), JSON.stringify({ version: 1, background: true }))
    expect(startsDetached(false, directory)).toBe(true)
  })

  it('stays in this terminal under --foreground whatever the answer', () => {
    expect(startsDetached(true, directory)).toBe(false)
    writeFileSync(join(directory, 'setup-answers.json'), JSON.stringify({ version: 1, background: true }))
    expect(startsDetached(true, directory)).toBe(false)
  })
})
