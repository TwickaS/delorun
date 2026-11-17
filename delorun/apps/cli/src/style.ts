/**
 * How the commands that report a state draw it: marks, colour, the `delorun` badge and a spinner. Colour follows the
 * `NO_COLOR` and `FORCE_COLOR` conventions and is off when the stream is not a terminal; the marks fall back to ASCII on
 * a legacy Windows console, which cannot draw them. Plain text carries every fact, so nothing depends on colour.
 *
 * @module @delorun/cli/style
 */

/** What a mark says about a line. */
export type MarkKind = 'ok' | 'warn' | 'fail' | 'note'

/** What decides how text is drawn. */
export interface StyleEnvironment {
  /** The process environment. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** Whether the output stream is a terminal. */
  readonly isTTY: boolean
  /** The platform, as `process.platform` names it. */
  readonly platform: string
}

/** The text styles one command draws with. */
export interface Style {
  /** Whether escape sequences are written. */
  readonly color: boolean
  /** Whether the marks are the Unicode ones. */
  readonly unicode: boolean
  /**
   * A line led by a mark.
   * @param kind - what the line says.
   * @param text - the line.
   * @returns the line with its mark, coloured when colour is on.
   */
  mark(kind: MarkKind, text: string): string
  /**
   * A command a person types.
   * @param text - the command.
   * @returns it in bold when colour is on.
   */
  command(text: string): string
  /**
   * An explanation that follows a fact.
   * @param text - the explanation.
   * @returns it dimmed when colour is on.
   */
  dim(text: string): string
  /**
   * The product name, drawn once at the start of a command's first line.
   * @returns `delorun` in orange when colour is on.
   */
  badge(): string
}

/** Escape sequences by name: SGR codes, then their reset. */
const CODES = { bold: '1', dim: '2', green: '32', amber: '33', red: '31', orange: '38;5;208' } as const

/** The mark characters, Unicode then ASCII. */
const MARKS: Readonly<Record<MarkKind, readonly [string, string]>> = { ok: ['✓', '+'], warn: ['!', '!'], fail: ['✗', 'x'], note: ['●', '*'] }

/** The colour of each mark. */
const MARK_COLOUR: Readonly<Record<MarkKind, keyof typeof CODES>> = { ok: 'green', warn: 'amber', fail: 'red', note: 'dim' }

/**
 * Whether escape sequences should be written, by the `NO_COLOR` and `FORCE_COLOR` conventions.
 * @param environment - the environment, the stream and the platform.
 * @returns false when `NO_COLOR` is set to anything non-empty, or `FORCE_COLOR` is `0` or `false`; true when `FORCE_COLOR` is set otherwise; else whether the stream is a terminal.
 */
export function colourWanted(environment: StyleEnvironment): boolean {
  const { env } = environment
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false
  const forced = env.FORCE_COLOR
  if (forced === '0' || forced === 'false') return false
  if (forced !== undefined && forced !== '') return true
  return environment.isTTY && env.TERM !== 'dumb'
}

/**
 * Whether the console draws Unicode marks: everything but a legacy Windows console, which is Windows outside Windows Terminal, VS Code and terminals that set `TERM`.
 * @param environment - the environment, the stream and the platform.
 * @returns true when the marks can be Unicode.
 */
export function unicodeWanted(environment: StyleEnvironment): boolean {
  if (environment.platform !== 'win32') return environment.env.TERM !== 'linux'
  const { env } = environment
  return env.WT_SESSION !== undefined || env.TERM_PROGRAM === 'vscode' || (env.TERM !== undefined && env.TERM !== '') || env.ConEmuTask === '{cmd::Cmder}'
}

/**
 * The styles for an environment.
 * @param environment - the environment, the stream and the platform.
 * @returns the styles.
 */
export function createStyle(environment: StyleEnvironment): Style {
  const color = colourWanted(environment)
  const unicode = unicodeWanted(environment)
  const paint = (code: keyof typeof CODES, text: string): string => color ? `\u001b[${CODES[code]}m${text}\u001b[0m` : text
  return {
    color,
    unicode,
    mark: (kind, text) => `${paint(MARK_COLOUR[kind], MARKS[kind][unicode ? 0 : 1])} ${text}`,
    command: text => paint('bold', text),
    dim: text => paint('dim', text),
    badge: () => paint('orange', paint('bold', 'delorun')),
  }
}

/**
 * The styles for a command's output.
 * @param env - the command's environment.
 * @param stream - the stream the output reaches; this process's standard output by default.
 * @returns the styles.
 */
export function styleOf(env: Readonly<Record<string, string | undefined>>, stream: { readonly isTTY?: boolean } = process.stdout): Style {
  return createStyle({ env, isTTY: stream.isTTY === true, platform: process.platform })
}

/**
 * A line of a command and what it does, with the command in bold and the explanation dimmed, aligned in a column.
 * @param style - the styles.
 * @param rows - the commands and their explanations.
 * @param indent - the spaces before each row.
 * @returns one line per row.
 */
export function commandRows(style: Style, rows: readonly (readonly [command: string, what: string])[], indent = '  '): string[] {
  const width = Math.max(0, ...rows.map(([command]) => command.length))
  return rows.map(([command, what]) => `${indent}${style.command(command)}${' '.repeat(width - command.length)}  ${style.dim(what)}`)
}

/** Braille frames of the spinner, 80 ms apart. */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

/** The pause between spinner frames, in milliseconds. */
export const SPINNER_INTERVAL_MS = 80

/** The stream a spinner draws on. */
export interface SpinnerStream {
  /** Whether it is a terminal; a spinner draws only then. */
  readonly isTTY?: boolean
  /**
   * Write text.
   * @param text - the text.
   * @returns whether the write was accepted.
   */
  write(text: string): boolean
}

/** A running spinner. */
export interface Spinner {
  /**
   * Stop drawing and write the final line.
   * @param kind - the mark of the final line.
   * @param text - the final line without the elapsed time.
   * @returns the line written, including the time.
   */
  stop(kind: MarkKind, text: string): string
}

/**
 * Show that something is in progress. On a terminal it draws a braille spinner after `label`; elsewhere it draws nothing.
 * @param label - what is in progress.
 * @param style - the styles.
 * @param stream - where to draw.
 * @param now - the clock in milliseconds.
 * @returns the spinner; its `stop` replaces the spinner line with `mark text (2.1s)` and returns that line for callers that write it elsewhere.
 */
export function startSpinner(label: string, style: Style, stream: SpinnerStream = process.stdout, now: () => number = Date.now): Spinner {
  const started = now()
  let frame = 0
  const draw = (): void => { stream.write(`\r${style.dim(SPINNER_FRAMES[frame++ % SPINNER_FRAMES.length]!)} ${label}`) }
  const timer = stream.isTTY === true ? setInterval(draw, SPINNER_INTERVAL_MS) : undefined
  if (timer !== undefined) {
    timer.unref()
    draw()
  }
  return {
    stop(kind, text) {
      if (timer !== undefined) {
        clearInterval(timer)
        stream.write('\r\u001b[2K')
      }
      return style.mark(kind, `${text} ${style.dim(`(${((now() - started) / 1000).toFixed(1)}s)`)}`)
    },
  }
}
