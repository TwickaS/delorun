import { describe, expect, it } from 'vitest'
import { SCROLL_START, summariseScroll, type TraceEvent } from '../review/trace-summary.ts'

const MAIN = { pid: 1, tid: 7 }
const OTHER = { pid: 1, tid: 9 }

/**
 * A complete trace event.
 * @param name - the event's name.
 * @param durUs - its duration in microseconds.
 * @param thread - its process and thread.
 * @param args - its arguments.
 * @returns the event.
 */
function task(name: string, durUs: number, thread = MAIN, args?: TraceEvent['args']): TraceEvent {
  return { name, ph: 'X', ...thread, dur: durUs, ...(args === undefined ? {} : { args }) }
}

const events: readonly TraceEvent[] = [
  { name: 'thread_name', ph: 'M', ...MAIN, args: { name: 'CrRendererMain' } },
  task('UpdateLayoutTree', 4000, MAIN, { elementCount: 1500 }),
  task('UpdateLayoutTree', 1000, MAIN, { elementCount: 20 }),
  task('UpdateLayoutTree', 9000, OTHER, { elementCount: 99 }),
  task('Paint', 2500),
  task('RunTask', 60_000),
  task('RunTask', 10_000),
  task('RasterTask', 3000, OTHER),
  task('RasterTask', 2000),
  task('ImageDecodeTask', 1500, OTHER),
  { name: 'PipelineReporter', ph: 'b', ...OTHER, args: { chrome_frame_reporter: { state: 'STATE_DROPPED' } } },
  { name: 'PipelineReporter', ph: 'b', ...OTHER, args: { chrome_frame_reporter: { state: 'STATE_PRESENTED_ALL' } } },
]

describe('the scroll trace summary', () => {
  const summary = summariseScroll(events, [16.7, 16.6, 33.4, 16.7, 50.1])

  it('counts style work on the main thread only, with the elements it touched', () => {
    expect(summary.styleMs).toBe(5)
    expect(summary.styleElements).toBe(1520)
  })

  it('counts raster and decode work on every thread', () => {
    expect(summary.rasterMs).toBe(5)
    expect(summary.decodeMs).toBe(1.5)
  })

  it('counts long tasks and dropped frames', () => {
    expect(summary.longTasks).toBe(1)
    expect(summary.droppedFrames).toBe(1)
  })

  it('reads frame intervals as median, 95th percentile, worst and slow frames', () => {
    expect(summary).toMatchObject({ frames: 5, frameMedianMs: 16.7, frameP95Ms: 50.1, frameMaxMs: 50.1, slowFrames: 2 })
  })

  it('leaves out work before the scroll starts', () => {
    const later = summariseScroll([
      ...events.map(event => ({ ...event, ts: 100 })),
      { name: 'TimeStamp', ph: 'I', ...MAIN, ts: 200, args: { data: { message: SCROLL_START } } },
      { ...task('Paint', 7000), ts: 300 },
    ], [])
    expect(later).toMatchObject({ paintMs: 7, styleMs: 0, rasterMs: 0, droppedFrames: 0 })
  })

  it('reads an empty trace as nothing spent', () => {
    expect(summariseScroll([], [])).toMatchObject({ frames: 0, frameMedianMs: 0, styleMs: 0, longTasks: 0 })
  })
})
