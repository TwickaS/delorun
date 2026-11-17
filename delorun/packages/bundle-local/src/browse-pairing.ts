/**
 * The Host half of pairing the browse extension, for a row whose need is a browse pairing: `POST
 * /api/delorunBrowsePair.start` runs `browse pair` from that row's pack and answers with one JSON event per line, the
 * one-time code as soon as browse prints it, then the browser that connected, the code running out, or browse's
 * failure. Only the computer's own studio may start it: the route admits no paired device, and it also refuses a
 * request whose `Host` is not a loopback name. It never reads browse's token files; browse writes them itself.
 *
 * The program runs with Delorun's environment less every `OPENCODE_BROWSER_*` variable, as the browse driver starts
 * browse by default, and with updates off (`OPENCODE_BROWSER_AUTO_UPDATE=off`, `OPENCODE_BROWSER_UPDATE_CHECK=0`):
 * `browse pair` starts browse's relay when none runs, and the relay keeps the environment it starts with, so none of
 * browse's access switches reaches it from Delorun's, and pairing writes to the data folder the driver's browse reads. It waits the code's
 * whole lifetime, ten minutes. One pairing runs at a time: a new start ends the one before, and so does the request
 * closing or the plugin stopping.
 *
 * @module @delorun/bundle-local/browse-pairing
 */
import { spawn } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.connection service.
import type {} from '@deepseek-ai/dsh-client-connection'
import { isLoopbackHost } from '@delorun/home-auth'
import { BROWSE_PAIR_ROUTE, type BrowsePairEvent, type BrowsePairRequest } from './client/browse-pair-api.ts'

/** How long `browse pair` waits for the extension: browse's one-time code lives ten minutes, and browse waits at most that. */
const CODE_LIFETIME_SECONDS = 600

/** The most text of browse's output the route keeps while it looks for a line; browse prints a few short lines. */
const MAX_PENDING = 64 * 1024

/** Where the program for a row is, or why there is none. */
export type PairProgram =
  | { readonly kind: 'program', readonly path: string }
  | { readonly kind: 'unknown-row' }
  | { readonly kind: 'unsupported' }

/**
 * Find browse's program for a row.
 * @param request - the bundle package and row.
 * @returns the program, `unknown-row` when no listed bundle declares a browse pairing for that row, or `unsupported`
 * when browse has no program for this computer.
 */
export type FindPairProgram = (request: BrowsePairRequest) => Promise<PairProgram>

/**
 * The environment `browse pair` runs with: Delorun's, less every browse variable, with updates off.
 * @param env - Delorun's environment.
 * @returns the child's environment.
 */
export function browsePairEnvironment(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const kept = Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && !entry[0].toUpperCase().startsWith('OPENCODE_BROWSER_'))
  return { ...Object.fromEntries(kept), OPENCODE_BROWSER_AUTO_UPDATE: 'off', OPENCODE_BROWSER_UPDATE_CHECK: '0' }
}

const CODE_LINE = /^Pairing code: ([0-9A-Z]{4}-[0-9A-Z]{4})\s*$/u
const PAIRED_LINE = /^Paired (.+?)\.?\s*$/u

/**
 * Run `browse pair` and report its steps.
 * @param program - browse's program.
 * @param env - Delorun's environment.
 * @param signal - stops the program.
 * @param emit - receives each step; the last is `paired`, `expired` or `failed`.
 * @returns when the program has exited and the last step is emitted.
 */
export function runBrowsePair(program: string, env: Readonly<Record<string, string | undefined>>, signal: AbortSignal, emit: (event: BrowsePairEvent) => void): Promise<void> {
  return new Promise((resolve) => {
    let coded = false
    let paired = false
    let failure = ''
    let pending = ''
    const child = spawn(program, ['pair', '--wait-seconds', String(CODE_LIFETIME_SECONDS)], { env: browsePairEnvironment(env), stdio: ['ignore', 'pipe', 'pipe'], signal, windowsHide: true })
    child.stdout.setEncoding('utf8').on('data', (text: string) => {
      pending = (pending + text).slice(-MAX_PENDING)
      let end = pending.indexOf('\n')
      while (end !== -1) {
        const line = pending.slice(0, end).trim()
        pending = pending.slice(end + 1)
        const code = CODE_LINE.exec(line)?.[1]
        const name = PAIRED_LINE.exec(line)?.[1]
        if (code !== undefined && !coded) {
          coded = true
          emit({ kind: 'code', code })
        } else if (name !== undefined && coded && !paired) {
          paired = true
          emit({ kind: 'paired', name })
        }
        end = pending.indexOf('\n')
      }
    })
    child.stderr.setEncoding('utf8').on('data', (text: string) => { failure = (failure + text).slice(-MAX_PENDING) })
    let settled = false
    const finish = (event: BrowsePairEvent | undefined): void => {
      if (settled) return
      settled = true
      if (event !== undefined) emit(event)
      resolve()
    }
    child.on('error', (error) => {
      // Stopped on purpose (a newer start, the request closing): nothing to report.
      if (signal.aborted) finish(undefined)
      else finish({ kind: 'failed', message: error.message })
    })
    child.on('close', (status) => {
      if (signal.aborted) return finish(undefined)
      if (status === 0) return finish(paired ? undefined : { kind: 'paired' })
      const message = failure.trim().split('\n').at(-1)?.replace(/^browse:\s*/u, '') ?? ''
      finish(coded && message === '' ? { kind: 'expired' } : { kind: 'failed', message: message === '' ? `browse pair stopped with status ${String(status)}` : message })
    })
  })
}

/**
 * Answer one pairing request.
 * @param request - the request.
 * @param find - finds the row's program.
 * @param env - Delorun's environment.
 * @param running - the pairing running now, which a new start ends.
 * @returns the event stream, or a refusal.
 */
export async function answerBrowsePair(request: Request, find: FindPairProgram, env: Readonly<Record<string, string | undefined>>, running: { current?: AbortController }): Promise<Response> {
  const json = (status: number, error: string, message: string): Response => new Response(JSON.stringify({ error, message }), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
  if (!isLoopbackHost(request.headers.get('host') ?? undefined)) return json(403, 'LOOPBACK_REQUIRED', 'Pairing your browser needs you at your computer: open the studio on the home\'s own computer')
  let body: unknown
  try {
    body = await request.json()
  } catch (error) {
    return json(400, 'BAD_REQUEST', `The request is not JSON: ${(error as Error).message}`)
  }
  if (typeof body !== 'object' || body === null || !('packageName' in body) || !('rowId' in body) || typeof body.packageName !== 'string' || typeof body.rowId !== 'string') {
    return json(400, 'BAD_REQUEST', 'Name the bundle package and the row to pair for')
  }
  const program = await find({ packageName: body.packageName, rowId: body.rowId })
  if (program.kind === 'unknown-row') return json(404, 'NOT_FOUND', `${body.packageName} declares no browse pairing for the row ${body.rowId}`)
  if (program.kind === 'unsupported') return json(409, 'UNSUPPORTED', 'browse has no program for this kind of computer')
  running.current?.abort()
  const stop = new AbortController()
  running.current = stop
  request.signal.addEventListener('abort', () => { stop.abort() }, { once: true })
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start: async (controller) => {
      await runBrowsePair(program.path, env, stop.signal, (event) => { controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)) })
      if (running.current === stop) delete running.current
      controller.close()
    },
    cancel: () => { stop.abort() },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' } })
}

/**
 * Register the pairing route; the pairing running when the scope stops is ended.
 * @param scope - the scope that holds the Connection.
 * @param find - finds a row's program.
 */
export function registerBrowsePairing(scope: Context, find: FindPairProgram): void {
  const running: { current?: AbortController } = {}
  scope.effect(() => () => { running.current?.abort() }, 'delorun-requirements: browse pairing')
  scope.connection.fetch.register({
    path: BROWSE_PAIR_ROUTE, methods: ['POST'], requestBody: 'buffered', requestMediaType: 'application/json',
    // No `admitPeer`: only the owner's own studio reaches the route; `answerBrowsePair` also refuses a non-loopback Host.
    fetch: request => answerBrowsePair(request, find, process.env, running),
  })
}
