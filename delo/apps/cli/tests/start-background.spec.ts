import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { foregroundHint, startChoice } from '../src/start.ts'

/** What `delorun start` decides with the given flags. */
const detached = (foreground: boolean, directory: string): boolean => startChoice('start', { foreground, background: false }, directory).detached

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
    expect(detached(false, directory)).toBe(false)
  })

  it('detaches when the person chose the background, and when no answer is recorded', () => {
    expect(detached(false, directory)).toBe(true)
    writeFileSync(join(directory, 'setup-answers.json'), JSON.stringify({ version: 1, background: true }))
    expect(detached(false, directory)).toBe(true)
  })

  it('stays in this terminal under --foreground whatever the answer', () => {
    expect(detached(true, directory)).toBe(false)
    writeFileSync(join(directory, 'setup-answers.json'), JSON.stringify({ version: 1, background: true }))
    expect(detached(true, directory)).toBe(false)
  })

  it('detaches under --background whatever the answer, refuses both options together, and says which option chose', () => {
    writeFileSync(join(directory, 'setup-answers.json'), JSON.stringify({ version: 1, background: false }))
    expect(startChoice('start', { foreground: false, background: true }, directory)).toEqual({ detached: true, explicit: true })
    expect(startChoice('start', { foreground: true, background: false }, directory)).toEqual({ detached: false, explicit: true })
    expect(startChoice('', { foreground: false, background: false }, directory)).toEqual({ detached: false, explicit: false })
    expect(() => startChoice('start', { foreground: true, background: true }, directory)).toThrow('delorun start: --background and --foreground cannot be used together')
    expect(() => startChoice('', { foreground: true, background: true }, directory)).toThrow(/^delorun: --background/)
  })

  it('tells a start that stays in the terminal how to keep Delo running after it closes', () => {
    expect(foregroundHint('default')).toContain('delorun start --background, or run delorun setup background to make that the default')
    expect(foregroundHint('work')).toContain('delorun start --background --profile work')
  })
})
