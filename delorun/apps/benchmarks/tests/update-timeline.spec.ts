import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Finished } from '../src/harness/processes.ts'
import { difference, readMarks, splitRecord, rollbackItems, UPDATE_ITEMS, UPDATE_SCENARIOS, UpdateTimeline, updateItems } from '../src/suites/update/index.ts'

const made: string[] = []
afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true })
})

/** A finished command that started at 1000 and exited at 9000. */
const COMMAND: Finished = { code: 0, signal: null, startedAt: 1000, firstOutputAt: 1100, endedAt: 9000, lines: [], timedOut: false }

/** The driver's records of one update with a copy, plus one record from before the command. */
const MARKS = [
  { event: 'store.prepare:start', at: 500 },
  { event: 'store.prepare:start', at: 1200 },
  { event: 'channel.open:start', at: 1210 },
  { event: 'channel.open:end', at: 1300 },
  { event: 'channel.resolve:start', at: 1300 },
  { event: 'install.resolved', at: 1350 },
  { event: 'install.signature-checked', at: 1400 },
  { event: 'install.log-checked', at: 1450 },
  { event: 'channel.resolve:end', at: 1450 },
  { event: 'channel.fill:start', at: 1460 },
  { event: 'download.file:start', at: 1470 },
  { event: 'download.file:end', at: 2470 },
  { event: 'download.bytes:start', at: 2470 },
  { event: 'download.bytes:end', at: 2480 },
  { event: 'channel.fill:end', at: 3000 },
  { event: 'report.running:start', at: 3200 },
  { event: 'report.target:start', at: 3210 },
  { event: 'report.target:end', at: 3600 },
  { event: 'report.data:start', at: 3600 },
  { event: 'report.data:end', at: 3700 },
  { event: 'report.profile:start', at: 3210 },
  { event: 'report.profile:end', at: 3250 },
  { event: 'store.prepare:end', at: 3800 },
  { event: 'copies.plan:start', at: 3900 },
  { event: 'snapshots.save:start', at: 3950 },
  { event: 'snapshots.save:end', at: 4000 },
  { event: 'copies.save:start', at: 4500 },
  { event: 'copies.save:end', at: 5500 },
  { event: 'store.switchTo:start', at: 5500 },
  { event: 'store.switchTo:end', at: 5520 },
]

/** The home log's records of the same update. */
const LOGS = [
  { at: 4010, msg: 'update phase', pid: 1, phase: 'waiting' },
  { at: 4100, msg: 'update phase', pid: 1, phase: 'switching' },
  { at: 5530, msg: 'update phase', pid: 1, phase: 'health-check' },
  { at: 7000, msg: 'the Host booted on the new runtime; checking its health', pid: 2, phase: undefined },
  { at: 8000, msg: 'update committed', pid: 1, phase: undefined },
  { at: 8100, msg: 'took over from the previous runtime', pid: 2, phase: undefined },
]

describe('the update timeline', () => {
  it('reads every item of an update with a copy from the records after the command started', () => {
    expect(updateItems(COMMAND, new UpdateTimeline(COMMAND.startedAt, MARKS, LOGS), true)).toEqual({
      'total': 7000, 'command': 8000, 'cli-start': 200, 'running-check': 90, 'channel-verify': 150,
      'download-unpack': 1540, 'store-install': 200, 'report': 600, 'report-target': 390, 'report-data': 100, 'report-profile': 40,
      'confirm': 100, 'snapshot': 50, 'drain': 90, 'stop-host': 400, 'data-copy': 1000, 'switch': 20, 'target-boot': 1470, 'health-check': 1000, 'handover': 100,
    })
  })

  it('stops the Host at the switch when no copy is taken, and leaves out what was not recorded', () => {
    const items = updateItems(COMMAND, new UpdateTimeline(COMMAND.startedAt, MARKS.filter(mark => !mark.event.startsWith('copies.')), LOGS.slice(0, 3)), false)
    expect(items['stop-host']).toBe(1400)
    expect(items['confirm']).toBe(150)
    expect(items).not.toHaveProperty('data-copy')
    expect(items).not.toHaveProperty('total')
    expect(items).not.toHaveProperty('target-boot')
  })

  it('declares every item it measures', () => {
    const measured = Object.keys(updateItems(COMMAND, new UpdateTimeline(COMMAND.startedAt, MARKS, LOGS), true))
    expect(measured.filter(item => !(item in UPDATE_ITEMS))).toEqual([])
    expect(new Set(UPDATE_SCENARIOS.map(scenario => scenario.id)).size).toBe(UPDATE_SCENARIOS.length)
  })

  it('reads the rollback\'s items from the times its phase lines arrived', () => {
    const rollback: Finished = { ...COMMAND, lines: [{ at: 2000, stream: 'stdout', text: '… waiting' }, { at: 3000, stream: 'stdout', text: '… switching' }, { at: 5000, stream: 'stdout', text: '… health-check' }] }
    expect(rollbackItems(rollback)).toEqual({ 'rollback': 8000, 'rollback-switch': 2000, 'rollback-target': 4000 })
    expect(rollbackItems(COMMAND)).toEqual({ rollback: 8000 })
  })

  it('splits the details a record\'s message carries from the message', () => {
    expect(splitRecord('update phase {"phase":"switching","from":"0.1.0"}', undefined)).toEqual({ msg: 'update phase', phase: 'switching' })
    expect(splitRecord('update committed {"from":"0.1.0"}', undefined)).toEqual({ msg: 'update committed', phase: undefined })
    expect(splitRecord('update phase', { phase: 'waiting' })).toEqual({ msg: 'update phase', phase: 'waiting' })
    expect(splitRecord('a brace { that is not JSON}', undefined)).toEqual({ msg: 'a brace { that is not JSON}', phase: undefined })
    expect(splitRecord('running', null)).toEqual({ msg: 'running', phase: undefined })
  })

  it('gives no difference for a missing or reversed pair of times', () => {
    expect(difference(undefined, 1)).toBeUndefined()
    expect(difference(2, 1)).toBeUndefined()
    expect(difference(1, 3)).toBe(2)
  })

  it('reads the driver\'s timing file, and nothing when it is absent', () => {
    const directory = mkdtempSync(join(tmpdir(), 'delorun-bench-spec-'))
    made.push(directory)
    writeFileSync(join(directory, 'timings.jsonl'), '{"event":"driver.ready","at":5}\n')
    expect(readMarks(join(directory, 'timings.jsonl'))).toEqual([{ event: 'driver.ready', at: 5 }])
    expect(readMarks(join(directory, 'absent.jsonl'))).toEqual([])
  })
})
