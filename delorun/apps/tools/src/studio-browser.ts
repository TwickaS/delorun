/**
 * Drive a browser against a studio running on this computer, through a `StudioBrowser` adapter: the repository's Playwright
 * Chromium by default, the person's own Chrome through `browse` on request. Run from the
 * repository root: `node_modules/.bin/tsx delorun/apps/tools/src/studio-browser.ts check` reports whether the browser is
 * ready, and `... run --url <studio url> (--file <script.js> | --code '<js>') [--record <out.webm>] [--timeout-ms n]`
 * runs a script and prints what it returns. Exit codes: 0 done, 1 the script or browser failed, 2 usage error.
 * Only loopback studio addresses are reachable, and nothing widens that. The procedure is in
 * `.agents/skills/delorun-studio-browser/SKILL.md`.
 *
 * @module @delorun/tools/studio-browser
 */
import { readFileSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { parseSteps, type Step } from './studio-browser/steps.ts'
import { ADAPTERS, errorMessage, loopbackOrigin, realDeps, selectAdapter, type BrowseDeps, type RunSpec } from './studio-browser/index.ts'

/** The adapter used when neither `--adapter` nor `DELORUN_STUDIO_BROWSER` names one. */
export const DEFAULT_ADAPTER = 'playwright'

/** The script time limit used when `--timeout-ms` is absent. */
export const DEFAULT_TIMEOUT_MS = 60_000

const USAGE = [
  'usage: studio-browser.ts check [--adapter <id>]',
  '       studio-browser.ts run --url <studio url> [--file <script.js> | --code <js>] [--steps <steps.json>] [--viewport <w>x<h>] [--scheme light|dark]',
  '                             [--screenshot <out.png>] [--record <out.webm>] [--timeout-ms <n>] [--adapter <id>]',
  'run needs at least one of --file, --code, --steps and --screenshot; --file and --code exclude each other.',
].join('\n')

/** What the command line asked for, before defaults. */
export interface Request {
  /** `check` or `run`. */
  readonly command: string | undefined
  /** `--adapter`. */
  readonly adapter?: string | undefined
  /** `--url`. */
  readonly url?: string | undefined
  /** `--file`. */
  readonly file?: string | undefined
  /** `--code`. */
  readonly code?: string | undefined
  /** `--steps`. */
  readonly steps?: string | undefined
  /** `--viewport`. */
  readonly viewport?: string | undefined
  /** `--scheme`. */
  readonly scheme?: string | undefined
  /** `--screenshot`. */
  readonly screenshot?: string | undefined
  /** `--record`. */
  readonly record?: string | undefined
  /** `--timeout-ms`. */
  readonly timeoutMs?: string | undefined
}

/** A command with every default applied. */
export type Spec =
  | { readonly command: 'check'; readonly adapter: string }
  | { readonly command: 'run'; readonly adapter: string; readonly run: RunSpec }

/** A usage error; the command prints it with the usage text and exits 2. */
export class UsageError extends Error {}

/**
 * Parse the command line.
 * @param argv - the arguments after the script name.
 * @returns the request.
 * @throws UsageError on an unknown flag or a missing value.
 */
export function parseRequest(argv: readonly string[]): Request {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: {
        adapter: { type: 'string' }, url: { type: 'string' }, file: { type: 'string' }, code: { type: 'string' },
        record: { type: 'string' }, 'timeout-ms': { type: 'string' },
        steps: { type: 'string' }, viewport: { type: 'string' }, scheme: { type: 'string' }, screenshot: { type: 'string' },
      },
      strict: true,
      allowPositionals: true,
    })
    if (positionals.length > 1) throw new UsageError(`unexpected argument ${positionals.slice(1).join(' ')}`)
    return {
      command: positionals[0], adapter: values.adapter, url: values.url, file: values.file, code: values.code,
      record: values.record, timeoutMs: values['timeout-ms'],
      steps: values.steps, viewport: values.viewport, scheme: values.scheme, screenshot: values.screenshot,
    }
  } catch (error) {
    if (error instanceof UsageError) throw error
    throw new UsageError(errorMessage(error))
  }
}

/**
 * Apply the defaults and validate: the adapter id is `--adapter`, else `DELORUN_STUDIO_BROWSER`, else {@link DEFAULT_ADAPTER}.
 * @param request - the parsed command line.
 * @param env - the environment.
 * @param cwd - the directory relative paths resolve against.
 * @param readScript - reads a script file's text.
 * @returns the command to run.
 * @throws UsageError for an unknown command, a missing or conflicting flag, a non-loopback URL, a bad `--record` or a bad timeout.
 */
export function resolve(
  request: Request,
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
  readScript: (path: string) => string,
): Spec {
  const adapter = request.adapter ?? (env.DELORUN_STUDIO_BROWSER === undefined || env.DELORUN_STUDIO_BROWSER === '' ? DEFAULT_ADAPTER : env.DELORUN_STUDIO_BROWSER)
  if (!Object.hasOwn(ADAPTERS, adapter)) throw new UsageError(`unknown studio-browser adapter "${adapter}"; known adapters: ${Object.keys(ADAPTERS).join(', ')}`)
  if (request.command === 'check') return { command: 'check', adapter }
  if (request.command !== 'run') throw new UsageError('expected the command check or run')
  if (request.url === undefined) throw new UsageError('run needs --url')
  if (request.file !== undefined && request.code !== undefined) throw new UsageError('--file and --code exclude each other')
  if (request.file === undefined && request.code === undefined && request.steps === undefined && request.screenshot === undefined) {
    throw new UsageError('run needs at least one of --file, --code, --steps and --screenshot')
  }
  const viewport = request.viewport === undefined ? undefined : parseViewport(request.viewport)
  if (request.scheme !== undefined && request.scheme !== 'light' && request.scheme !== 'dark') throw new UsageError('--scheme must be light or dark')
  if (request.screenshot !== undefined && !request.screenshot.endsWith('.png')) throw new UsageError('--screenshot must name a .png file')
  const absolute = (path: string): string => (isAbsolute(path) ? path : resolvePath(cwd, path))
  if (request.record !== undefined && !request.record.endsWith('.webm')) throw new UsageError('--record must name a .webm file')
  const timeoutMs = request.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Number(request.timeoutMs)
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new UsageError('--timeout-ms must be a positive integer')
  let origin
  try {
    origin = loopbackOrigin(request.url)
  } catch (error) {
    throw new UsageError(errorMessage(error))
  }
  let code = request.code
  if (request.file !== undefined) {
    try {
      code = readScript(resolvePath(cwd, request.file))
    } catch (error) {
      throw new UsageError(`cannot read --file: ${errorMessage(error)}`)
    }
  }
  let steps: readonly Step[] | undefined
  if (request.steps !== undefined) {
    try {
      steps = parseSteps(readScript(resolvePath(cwd, request.steps)), cwd)
    } catch (error) {
      throw new UsageError(errorMessage(error))
    }
  }
  return {
    command: 'run',
    adapter,
    run: {
      origin, startUrl: new URL(request.url).href, timeoutMs,
      ...(code === undefined ? {} : { code }),
      ...(viewport === undefined ? {} : { viewport }),
      ...(request.scheme === undefined ? {} : { scheme: request.scheme }),
      ...(steps === undefined ? {} : { steps }),
      ...(request.screenshot === undefined ? {} : { screenshotTo: absolute(request.screenshot) }),
      ...(request.record === undefined ? {} : { recordTo: absolute(request.record) }),
    },
  }
}

/**
 * Parse `<width>x<height>`.
 * @param text - the `--viewport` value, such as `1440x900`.
 * @returns the viewport in CSS pixels.
 * @throws UsageError when either side is not a positive integer.
 */
export function parseViewport(text: string): { readonly width: number, readonly height: number } {
  const match = /^([1-9][0-9]*)x([1-9][0-9]*)$/.exec(text)
  if (match === null) throw new UsageError('--viewport must look like 1440x900')
  return { width: Number(match[1]), height: Number(match[2]) }
}

/** The command's outside world, replaceable in specs. */
export interface Io {
  /** The environment. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** The current directory. */
  readonly cwd: string
  /** Reads a script file. */
  readonly readScript: (path: string) => string
  /** Process, environment and file access for the adapter. */
  readonly deps: BrowseDeps
  /** Prints to standard output. */
  readonly out: (text: string) => void
  /** Prints to standard error. */
  readonly err: (text: string) => void
}

/**
 * Run the command.
 * @param argv - the arguments after the script name.
 * @param io - the outside world.
 * @returns the exit code: 0 done, 1 the script or browser failed, 2 usage error.
 */
export function main(argv: readonly string[], io: Io): number {
  try {
    const spec = resolve(parseRequest(argv), io.env, io.cwd, io.readScript)
    const browser = selectAdapter(spec.adapter, io.deps)
    if (spec.command === 'check') {
      const check = browser.check()
      io.out(`adapter: ${browser.id}\n${check.detail}`)
      return check.ok ? 0 : 1
    }
    const result = browser.run(spec.run)
    if (result.output !== '') (result.ok ? io.out : io.err)(result.output)
    if (result.ok && result.recording !== undefined) io.out(`recording: ${result.recording}`)
    return result.ok ? 0 : 1
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`${error.message}\n${USAGE}`)
      return 2
    }
    io.err(errorMessage(error))
    return 1
  }
}

/**
 * The real outside world.
 * @param env - the environment.
 * @param cwd - the current directory.
 * @returns file, process and console access.
 */
export function realIo(env: Readonly<Record<string, string | undefined>>, cwd: string): Io {
  return {
    env,
    cwd,
    readScript: path => readFileSync(path, 'utf8'),
    deps: realDeps(env),
    out: text => console.log(text),
    err: text => console.error(text),
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2), realIo(process.env, process.cwd()))
}
