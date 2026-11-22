/**
 * The one renderer of an install's progress, shared by the first install through the npm launcher, `delorun update`,
 * `delorun repair` and plugin pack downloads: the same {@link InstallerProgress} events drive all of them. It shows a
 * checklist, one line per phase with a spinner while the phase runs and a tick and its duration when it ends, and a live
 * bar for a download or an extraction. A terminal gets one redrawn block; anything else gets one plain line per phase and
 * one line for each ten percent of a download. The renderer only displays: it reads no file, decides nothing about a
 * check, and shows only what an event carries.
 *
 * @module @delorun/install/render
 */
import { uncheckedWarning } from '@delorun/release-verify/start'
import { formatDuration, formatSize, formatSpeed, type InstallerProgress } from './progress.ts'

/** Runs a function every `ms` milliseconds until the returned function is called. */
export type Every = (fn: () => void, ms: number) => () => void

/** What an {@link InstallRenderer} writes to and reads. */
export interface RendererOptions {
  /** Writes text to the person's terminal or log. */
  readonly write: (text: string) => void
  /** Whether `write` reaches a terminal that redraws lines; false writes plain lines only. */
  readonly terminal: boolean
  /** The terminal's width in columns, read at each redraw; 80 when absent. */
  readonly columns?: () => number
  /** Whether to colour the marks; false when `NO_COLOR` is set. */
  readonly color?: boolean
  /** The clock, in milliseconds; `Date.now` by default. */
  readonly now?: () => number
  /** The repeating timer that animates the spinner and shows a stall; an unreferenced `setInterval` by default. */
  readonly every?: Every
}

/** How often the spinner turns and a stalled download's wait is redrawn. */
const FRAME_MS = 100
/** Bytes arrive over this long a window when the speed and the time left are worked out. */
const SPEED_WINDOW_MS = 5000
/** The least span of samples that gives a speed. */
const SPEED_MIN_SPAN_MS = 1000
/** A download that delivers no byte for this long shows that it waits. */
const STALL_SHOWN_MS = 3000
/** The column the durations of a terminal's checklist end at, at most. */
const TIME_EDGE_MAX = 80
/** The bar's widest and narrowest width. */
const BAR_MAX = 24
const BAR_MIN = 8
/** The narrowest bar that is kept beside the amounts, the speed and the time left; a narrower one drops those first. */
const BAR_KEPT_MIN = 12
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/**
 * The default repeating timer: an unreferenced interval, so a renderer never keeps a process alive.
 * @param fn - what to run.
 * @param ms - the interval.
 * @returns the function that stops it.
 */
function intervalEvery(fn: () => void, ms: number): () => void {
  const timer = setInterval(fn, ms)
  timer.unref()
  return () => { clearInterval(timer) }
}

/** The phase a person sees running. */
interface Phase {
  /** What the spinner line says. */
  readonly label: string
  /** When it started, in clock milliseconds. */
  readonly startedAt: number
  /** The bar under the line, for the phases that measure something. */
  bar?: Measure
}

/** A measured phase: bytes of a download or files of an extraction. */
interface Measure {
  readonly unit: 'bytes' | 'files'
  /** What arrived. */
  done: number
  /** What the phase expects. */
  readonly total: number
  /** Samples of `done`, newest last, within the speed window; empty for files. */
  readonly samples: Array<{ readonly at: number, readonly done: number }>
  /** When the last byte arrived. */
  lastAt: number
  /** The last whole ten percent a plain log reported. */
  tenth: number
}

/**
 * The text of a size pair that names the unit once: `126.4 / 218.0 MB`.
 * @param done - what arrived.
 * @param total - what is expected.
 * @returns the pair.
 */
function sizePair(done: number, total: number): string {
  const whole = formatSize(total)
  const unit = whole.slice(whole.lastIndexOf(' ') + 1)
  const divisor = unit === 'GB' ? 1e9 : unit === 'MB' ? 1e6 : 1e3
  const value = (bytes: number): string => unit === 'kB' ? String(Math.round(bytes / divisor)) : (bytes / divisor).toFixed(1)
  return `${value(done)} / ${whole}`
}

/**
 * The time left, shown with a tilde because it is an estimate.
 * @param seconds - the estimate.
 * @returns `~14s left`, `~2m 05s left` or `~1h 03m left`.
 */
function formatLeft(seconds: number): string {
  if (seconds >= 3600) return `~${String(Math.floor(seconds / 3600))}h ${String(Math.floor(seconds % 3600 / 60)).padStart(2, '0')}m left`
  return `~${formatDuration(Math.max(1, seconds) * 1000)} left`
}

/**
 * Renders the events of one install, one run at a time. Call {@link InstallRenderer.handle} with each event, then
 * {@link InstallRenderer.finish} when the install succeeded or {@link InstallRenderer.fail} when it threw; both stop the
 * timer, so none runs after the install ends.
 */
export class InstallRenderer {
  private readonly options: RendererOptions
  private readonly now: () => number
  private readonly every: Every
  private phase: Phase | undefined
  private stop: (() => void) | undefined
  private frame = 0
  /** Lines of the redrawn block on screen. */
  private drawn = 0
  private downloadStartedAt = 0

  /**
   * @param options - where to write, whether it is a terminal, and the clock and timer.
   */
  constructor(options: RendererOptions) {
    this.options = options
    this.now = options.now ?? Date.now
    this.every = options.every ?? intervalEvery
  }

  /**
   * Show one event.
   * @param event - the install's event.
   */
  handle(event: InstallerProgress): void {
    switch (event.step) {
      case 'resolving':
        this.begin(`Finding the release on the ${event.channel} channel`)
        break
      case 'resolved':
        this.end(`Found release ${event.version} on the ${event.channel} channel`)
        this.begin('Checking the signature')
        break
      case 'signature-checked':
        this.end(`Signature checked (release root ${String(event.rootVersion)})`)
        this.begin('Checking the release log')
        break
      case 'log-checked':
        if (event.state === 'verified') {
          this.end('Release log checked')
        } else {
          this.end(`Release log not checked (${event.detail ?? 'the check did not run'})`, '!')
          this.note(`Warning: ${uncheckedWarning(event.version)}`)
        }
        break
      case 'downloading':
        this.downloadStartedAt = this.now()
        this.begin(`Downloading ${event.name}`, { unit: 'bytes', done: 0, total: event.bytes })
        break
      case 'download-bytes':
        this.bytes(event.name, event.received, event.total)
        break
      case 'downloaded':
        this.end(this.downloadedText('Downloaded', event.bytes))
        this.begin('Checking the download against its signed hash')
        break
      case 'download-verified':
        this.end('Download matches its signed hash')
        break
      case 'unpacking':
        this.begin('Unpacking the runtime', { unit: 'files', done: 0, total: event.files })
        break
      case 'unpack-files':
        this.files(event.written, event.total)
        break
      case 'origin-skipped':
        this.note(`${event.failed} did not serve ${event.name} (${event.reason}); ${event.served} served it, and its bytes verified.`)
        break
      case 'pack-downloading':
        this.downloadStartedAt = this.now()
        this.begin(`Downloading plugin pack ${event.name}`, { unit: 'bytes', done: 0, total: event.bytes })
        break
      case 'pack-bytes':
        this.bytes(event.name, event.received, event.total, `Downloading plugin pack ${event.name}`)
        break
      case 'pack-installing':
        this.end(this.downloadedText(`Downloaded plugin pack ${event.name}`, event.bytes))
        this.begin(`Installing plugin pack ${event.name}`)
        break
      case 'pack-installed':
        this.end(`Installed plugin pack ${event.name}`)
        break
      case 'installing':
        if (this.phase?.bar?.unit === 'files') this.end(`Unpacked the runtime (${this.phase.bar.total.toLocaleString('en-GB')} files)`)
        this.begin(`Installing release ${event.version}`)
        break
      case 'installed':
        this.end(`Installed release ${event.version}`)
        break
      case 'starting':
        this.begin('Starting Delorun')
        break
      case 'failed':
        this.fail()
        break
    }
  }

  /**
   * End a successful install.
   * @param next - the one short line that says what happens or what to do next, without its `Next:`; no line is
   *   printed when nothing useful can be said.
   */
  finish(next?: string): void {
    this.settle('✔')
    if (next !== undefined) this.line(`Next: ${next}`)
    this.halt()
  }

  /**
   * Clear the redrawn block and stop the timer, so a question that is asked on the same terminal is not drawn over. A
   * log has nothing to clear.
   */
  suspend(): void {
    this.halt()
    if (this.options.terminal) this.options.write(this.erase())
  }

  /**
   * Draw the running phase again after {@link InstallRenderer.suspend}.
   */
  resume(): void {
    if (this.phase === undefined || !this.options.terminal) return
    this.stop ??= this.every(() => { this.frame++; this.paint() }, FRAME_MS)
    this.paint()
  }

  /**
   * End the display without a mark or a line, for a caller whose own output follows: the redrawn block is cleared and the
   * timer stopped. A phase that still runs is dropped, so call it after the last event.
   */
  close(): void {
    this.phase = undefined
    this.suspend()
  }

  /**
   * End an install that threw: the running phase is marked as failed. The caller prints the error's own text.
   */
  fail(): void {
    this.settle('✖')
    this.halt()
  }

  /**
   * The line of a finished download: what it was, its size and the speed it averaged.
   * @param what - what was downloaded, such as `Downloaded`.
   * @param bytes - its size.
   * @returns the line.
   */
  private downloadedText(what: string, bytes: number): string {
    const durationMs = this.now() - this.downloadStartedAt
    return `${what} ${formatSize(bytes)}${durationMs > 0 ? ` at ${formatSpeed(bytes * 1000 / durationMs)} average` : ''}`
  }

  /**
   * Update the download bar.
   * @param name - the file.
   * @param received - bytes on disk.
   * @param total - the signed length.
   * @param label - what a download that starts here is called; the release archive again by default, which is what a
   *   later origin serving it after the first origin's bytes failed to verify looks like.
   */
  private bytes(name: string, received: number, total: number, label = `Downloading ${name} again`): void {
    if (this.phase?.bar?.unit !== 'bytes') {
      this.downloadStartedAt = this.now()
      this.begin(label, { unit: 'bytes', done: 0, total })
    }
    const measure = this.phase!.bar!
    const now = this.now()
    measure.done = received
    measure.lastAt = now
    measure.samples.push({ at: now, done: received })
    while (measure.samples.length > 1 && now - measure.samples[0]!.at > SPEED_WINDOW_MS) measure.samples.shift()
    // A terminal shows the count at the timer's next frame, so a fast stream of events does not become a stream of writes.
    if (!this.options.terminal) this.plainTenths(measure, `  ${sizePair(received, total)}${this.speed(measure) === undefined ? '' : `  ${formatSpeed(this.speed(measure)!)}`}`)
  }

  /**
   * Update the extraction count.
   * @param written - files written.
   * @param total - files expected.
   */
  private files(written: number, total: number): void {
    const measure = this.phase?.bar
    if (measure?.unit !== 'files') return
    measure.done = written
    measure.lastAt = this.now()
    if (!this.options.terminal) this.plainTenths(measure, `  ${written.toLocaleString('en-GB')} / ${total.toLocaleString('en-GB')} files`)
  }

  /**
   * A plain log's line for each whole ten percent.
   * @param measure - the phase's measure.
   * @param detail - what follows the percentage.
   */
  private plainTenths(measure: Measure, detail: string): void {
    const tenth = measure.total === 0 ? 10 : Math.floor(measure.done * 10 / measure.total)
    if (tenth <= measure.tenth) return
    measure.tenth = tenth
    this.line(`  ${String(tenth * 10)}%${detail}`)
  }

  /**
   * The bytes per second over the recent window.
   * @param measure - the download's measure.
   * @returns the speed, or `undefined` while the window is too short or nothing arrived in it.
   */
  private speed(measure: Measure): number | undefined {
    const first = measure.samples[0]
    const last = measure.samples.at(-1)
    if (first === undefined || last === undefined || last.at - first.at < SPEED_MIN_SPAN_MS) return undefined
    const speed = (last.done - first.done) * 1000 / (last.at - first.at)
    return speed > 0 ? speed : undefined
  }

  /**
   * Start a phase: its spinner line shows at once and turns until the phase ends.
   * @param label - what the line says.
   * @param bar - what the phase measures, if it does.
   */
  private begin(label: string, bar?: { readonly unit: Measure['unit'], readonly done: number, readonly total: number }): void {
    this.settle('✔')
    const at = this.now()
    this.phase = { label, startedAt: at, ...bar === undefined ? {} : { bar: { ...bar, samples: [{ at, done: 0 }], lastAt: at, tenth: 0 } } }
    if (this.options.terminal) {
      this.resume()
    } else if (bar !== undefined) {
      this.line(`${label}…`)
    }
  }

  /**
   * End the running phase with its tick and duration; a phase that is not running ends nothing.
   * @param text - what the finished line says.
   * @param mark - the mark, a tick by default.
   */
  private end(text: string, mark = '✔'): void {
    const phase = this.phase
    this.phase = undefined
    this.permanent(this.timed(mark, text, phase === undefined ? undefined : this.now() - phase.startedAt))
  }

  /**
   * A finished line: the mark, the text and, when the phase's time is known, the duration. On a terminal the durations
   * of all lines end at one column, the width of the terminal up to {@link TIME_EDGE_MAX} columns; in a log, and when
   * the text leaves no room, two spaces separate them.
   * @param mark - the mark.
   * @param text - what the line says.
   * @param ms - how long the phase took, when it ran.
   * @returns the line, with its colours.
   */
  private timed(mark: string, text: string, ms: number | undefined): string {
    if (ms === undefined) return `${this.mark(mark)} ${text}`
    const took = formatDuration(ms)
    const edge = this.options.terminal ? Math.min(Math.max(20, (this.options.columns?.() ?? 80) - 1), TIME_EDGE_MAX) : 0
    const gap = Math.max(2, edge - (2 + text.length) - took.length)
    return `${this.mark(mark)} ${text}${' '.repeat(gap)}${this.dim(took)}`
  }

  /**
   * End whatever phase runs, with the given mark.
   * @param mark - a tick for success, a cross for a failure.
   */
  private settle(mark: '✔' | '✖'): void {
    if (this.phase === undefined) return
    const phase = this.phase
    this.phase = undefined
    this.permanent(this.timed(mark, phase.label, this.now() - phase.startedAt))
  }

  /**
   * Stop the timer and clear the block.
   */
  private halt(): void {
    this.stop?.()
    this.stop = undefined
  }

  /**
   * Print a plain note above the block.
   * @param text - the note.
   */
  private note(text: string): void {
    this.permanent(`  ${text}`)
  }

  /**
   * Print a line that stays, above the redrawn block.
   * @param text - the line, which already carries its colour.
   */
  private permanent(text: string): void {
    if (!this.options.terminal) {
      this.options.write(`${text}\n`)
      return
    }
    this.options.write(`${this.erase()}${text}\n`)
    this.paint()
  }

  /**
   * Print one line outside the block, such as the line of a plain log.
   * @param text - the line.
   */
  private line(text: string): void {
    if (this.options.terminal) this.permanent(text)
    else this.options.write(`${text}\n`)
  }

  /**
   * The text that removes the redrawn block from the screen.
   * @returns the control sequence, empty when nothing is drawn.
   */
  private erase(): string {
    const erased = this.drawn === 0 ? '' : `\u001B[${String(this.drawn)}F\u001B[J`
    this.drawn = 0
    return erased
  }

  /**
   * Redraw the running phase: its spinner line and, for a measured phase, the bar under it.
   */
  private paint(): void {
    const phase = this.phase
    if (phase === undefined || !this.options.terminal) return
    const width = Math.max(20, (this.options.columns?.() ?? 80) - 1)
    const spinner = SPINNER[this.frame % SPINNER.length]!
    const lines = [clip(`${spinner} ${phase.label}`, width)]
    if (phase.bar !== undefined) lines.push(`  ${this.barLine(phase.bar, width - 2)}`)
    const text = this.erase() + lines.map((each, index) => index === 0 ? `${this.paintSpinner(each)}\n` : `${this.dim(each)}\n`).join('')
    this.drawn = lines.length
    this.options.write(text)
  }

  /**
   * The line of a bar: the bar, the percentage, the amounts, and for a download the speed and the time left. A narrow
   * terminal first shortens the bar, then drops the time left, the speed and the amounts.
   * @param measure - what the phase measures.
   * @param width - the columns available.
   * @returns the line.
   */
  private barLine(measure: Measure, width: number): string {
    const fraction = measure.total === 0 ? 1 : Math.min(1, measure.done / measure.total)
    const percent = `${String(Math.floor(fraction * 100))}%`.padStart(4)
    const amount = measure.unit === 'bytes' ? sizePair(measure.done, measure.total) : `${measure.done.toLocaleString('en-GB')} / ${measure.total.toLocaleString('en-GB')} files`
    const extras: string[] = []
    if (measure.unit === 'bytes') {
      const waited = this.now() - measure.lastAt
      if (waited >= STALL_SHOWN_MS && measure.done < measure.total) {
        extras.push(`waiting for data… ${formatDuration(waited)}`)
      } else {
        const speed = this.speed(measure)
        if (speed !== undefined) extras.push(formatSpeed(speed))
        extras.push(speed === undefined ? 'estimating…' : formatLeft((measure.total - measure.done) / speed))
      }
    }
    // Pieces after the bar and percentage, least important last.
    const pieces = [amount, ...extras]
    for (let keep = pieces.length; keep >= 0; keep--) {
      const tail = pieces.slice(0, keep).map(piece => `  ${piece}`).join('')
      for (let barWidth = BAR_MAX; barWidth >= (keep === 0 ? BAR_MIN : BAR_KEPT_MIN); barWidth--) {
        const line = `${bar(fraction, barWidth)}  ${percent}${tail}`
        if (line.length <= width) return line
      }
    }
    return clip(percent.trim(), width)
  }

  /**
   * A mark with its colour.
   * @param mark - the glyph.
   * @returns the glyph, coloured green, red or yellow when colour is on.
   */
  private mark(mark: string): string {
    if (this.options.color !== true) return mark
    const code = mark === '✔' ? '32' : mark === '✖' ? '31' : '33'
    return `\u001B[${code}m${mark}\u001B[0m`
  }

  /**
   * Dim a detail when colour is on.
   * @param text - the detail.
   * @returns the text, dimmed when colour is on.
   */
  private dim(text: string): string {
    return this.options.color === true && text !== '' ? `\u001B[2m${text}\u001B[0m` : text
  }

  /**
   * The spinner line with its glyph in cyan when colour is on.
   * @param text - the line, whose first character is the spinner.
   * @returns the line.
   */
  private paintSpinner(text: string): string {
    return this.options.color === true ? `\u001B[36m${text.slice(0, 1)}\u001B[0m${text.slice(1)}` : text
  }
}

/**
 * A bar.
 * @param fraction - 0 to 1.
 * @param width - its width in cells.
 * @returns filled cells then empty ones.
 */
function bar(fraction: number, width: number): string {
  const filled = Math.round(fraction * width)
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`
}

/**
 * Cut a line to the columns it may use.
 * @param text - the line.
 * @param width - the columns.
 * @returns the line, ending in an ellipsis when it was cut.
 */
function clip(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`
}

/** What a renderer reads of the stream it writes to: a terminal has `isTTY`, and its width is `columns`. */
export interface RenderStream {
  readonly isTTY?: boolean | undefined
  readonly columns?: number | undefined
}

/**
 * A renderer for a stream: redrawn when it is a terminal that can take control sequences, plain otherwise, and coloured
 * unless `NO_COLOR` names something (https://no-color.org) or the terminal is `dumb`.
 * @param write - writes to the stream.
 * @param stream - the stream, for its terminal flag and width.
 * @param env - the environment, for `NO_COLOR` and `TERM`.
 * @param options - the clock and the timer, for a test.
 * @returns the renderer.
 */
export function createRenderer(write: (text: string) => void, stream: RenderStream, env: Readonly<Record<string, string | undefined>>, options: Pick<RendererOptions, 'now' | 'every'> = {}): InstallRenderer {
  const terminal = stream.isTTY === true && env['TERM'] !== 'dumb'
  const color = terminal && (env['NO_COLOR'] === undefined || env['NO_COLOR'] === '')
  return new InstallRenderer({ write, terminal, color, columns: () => stream.columns ?? 80, ...options })
}
