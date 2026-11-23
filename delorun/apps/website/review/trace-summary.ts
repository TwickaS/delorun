/**
 * Reads a Chromium performance trace taken while the home page scrolls and sums what the renderer spent per kind of
 * work, for `scroll-trace.ts`. The trace events are Chromium's own `devtools.timeline` and `cc` events; the frame
 * intervals are measured in the page with `requestAnimationFrame`.
 *
 * @module @delorun/website/review/trace-summary
 */

/** One event of a Chromium trace, as far as the summary reads it. */
export interface TraceEvent {
  readonly name: string
  readonly ph: string
  readonly pid: number
  readonly tid: number
  readonly dur?: number
  readonly ts?: number
  readonly args?: { readonly name?: string; readonly elementCount?: number; readonly chrome_frame_reporter?: { readonly state?: string }; readonly data?: { readonly message?: string } }
}

/** The `console.timeStamp` label the page records when the measured scroll starts. */
export const SCROLL_START = 'scroll-start'

/** What one scroll cost. Times are milliseconds summed over the scroll; frame times are intervals between frames. */
export interface ScrollSummary {
  readonly frames: number
  readonly frameMedianMs: number
  readonly frameP95Ms: number
  readonly frameMaxMs: number
  /** Frames that took longer than one and a half 60 Hz frames: each is at least one missed frame. */
  readonly slowFrames: number
  /** Frames Chromium's frame reporter counts as dropped. */
  readonly droppedFrames: number
  /** Main-thread tasks over 50 ms. */
  readonly longTasks: number
  readonly styleMs: number
  /** Elements whose style was recalculated, summed over every recalculation. */
  readonly styleElements: number
  readonly layoutMs: number
  readonly prePaintMs: number
  readonly paintMs: number
  readonly layerizeMs: number
  readonly commitMs: number
  readonly scriptMs: number
  /** Raster work on every thread. */
  readonly rasterMs: number
  /** Image decoding on every thread. */
  readonly decodeMs: number
}

/** A frame interval this long or longer misses at least one 60 Hz frame. */
const SLOW_FRAME_MS = 25

/** A main-thread task this long or longer is a long task. */
const LONG_TASK_US = 50_000

/**
 * A rounded value at a quantile of a sorted list.
 * @param sorted - the values, ascending.
 * @param q - the quantile, 0 to 1.
 * @returns the value, to one decimal place, or 0 for an empty list.
 */
function quantile(sorted: readonly number[], q: number): number {
  const value = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0
  return Math.round(value * 10) / 10
}

/**
 * Sums a trace and the frame intervals measured during it. Work before the page's {@link SCROLL_START} time stamp, such
 * as the repaint that starting a trace causes, is left out.
 * @param events - the trace events.
 * @param frames - the intervals between animation frames, in milliseconds.
 * @returns the summary.
 */
export function summariseScroll(events: readonly TraceEvent[], frames: readonly number[]): ScrollSummary {
  const main = events.find(event => event.name === 'thread_name' && event.args?.name === 'CrRendererMain')
  const start = events.find(event => event.name === 'TimeStamp' && event.args?.data?.message === SCROLL_START)?.ts ?? Number.NEGATIVE_INFINITY
  const complete = events.filter(event => event.ph === 'X' && (event.ts ?? 0) >= start)
  const onMain = main === undefined ? [] : complete.filter(event => event.pid === main.pid && event.tid === main.tid)
  const ms = (list: readonly TraceEvent[], ...names: readonly string[]) => Math.round(list.filter(event => names.includes(event.name)).reduce((total, event) => total + (event.dur ?? 0), 0) / 100) / 10
  const reporters = events.filter(event => event.name === 'PipelineReporter' && event.ph === 'b' && (event.ts ?? 0) >= start)
  const sorted = [...frames].sort((a, b) => a - b)
  return {
    frames: frames.length,
    frameMedianMs: quantile(sorted, 0.5),
    frameP95Ms: quantile(sorted, 0.95),
    frameMaxMs: Math.round((sorted.at(-1) ?? 0) * 10) / 10,
    slowFrames: frames.filter(frame => frame >= SLOW_FRAME_MS).length,
    droppedFrames: reporters.filter(event => event.args?.chrome_frame_reporter?.state === 'STATE_DROPPED').length,
    longTasks: onMain.filter(event => event.name === 'RunTask' && (event.dur ?? 0) >= LONG_TASK_US).length,
    styleMs: ms(onMain, 'UpdateLayoutTree'),
    styleElements: onMain.filter(event => event.name === 'UpdateLayoutTree').reduce((total, event) => total + (event.args?.elementCount ?? 0), 0),
    layoutMs: ms(onMain, 'Layout'),
    prePaintMs: ms(onMain, 'PrePaint'),
    paintMs: ms(onMain, 'Paint'),
    layerizeMs: ms(onMain, 'Layerize'),
    commitMs: ms(onMain, 'Commit'),
    scriptMs: ms(onMain, 'FunctionCall', 'EventDispatch'),
    rasterMs: ms(complete, 'RasterTask'),
    decodeMs: ms(complete, 'ImageDecodeTask', 'Decode Image'),
  }
}
