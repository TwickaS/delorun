import { describe, expect, it } from 'vitest'
import { attributedWindows, parseMarks, withinWindows } from '../../../src/compat-bench/privacy/stages.ts'

const mark = (at: string, stage: string, phase: string): string => JSON.stringify({ at: `2026-11-22T10:${at}.000Z`, stage, phase })
const log = [
  mark('00:00', 'install', 'before'), mark('00:10', 'install', 'after'),
  mark('00:20', 'start', 'before'), mark('00:30', 'start', 'after'),
  mark('00:30', 'harness', 'before'), mark('00:40', 'harness', 'after'),
  mark('00:50', 'update', 'before'), mark('01:00', 'update', 'after'),
  mark('01:10', 'uninstall', 'before'), mark('01:20', 'uninstall', 'after'),
].join('\n')
const ms = (at: string): number => Date.parse(`2026-11-22T10:${at}.000Z`)

describe('stage windows', () => {
  it('count every stage but install, update and uninstall', () => {
    const windows = attributedWindows(parseMarks(log), ms('02:00'))
    expect(windows).toEqual([{ from: ms('00:20'), to: ms('00:30') }, { from: ms('00:30'), to: ms('00:40') }])
  })

  it('run to the end of the run for a stage that was still open', () => {
    const windows = attributedWindows(parseMarks(mark('00:20', 'start', 'before')), ms('05:00'))
    expect(windows).toEqual([{ from: ms('00:20'), to: ms('05:00') }])
  })

  it('keep the events inside a window, and those with no time', () => {
    const windows = attributedWindows(parseMarks(log), ms('02:00'))
    const events = [{ ts: ms('00:05'), n: 'install' }, { ts: ms('00:25'), n: 'start' }, { ts: ms('00:45'), n: 'between' }, { ts: ms('01:15'), n: 'uninstall' }, { n: 'untimed' }]
    expect(withinWindows(events, windows).map(event => event.n)).toEqual(['start', 'untimed'])
  })

  it('skip torn and blank lines', () => {
    expect(parseMarks(`\n{"at":\n${mark('00:00', 'start', 'before')}`)).toHaveLength(1)
  })
})
