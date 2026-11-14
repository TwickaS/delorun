/**
 * Same-origin requests from the studio's Delorun sections to the home's routes, and the validation of their JSON answers.
 * Every request carries `credentials: 'same-origin'`; a request with a body sends it as JSON. A refusal is the Host's
 * `{ "error": "<CODE>", "message": "<sentence>" }` with a 4xx or 5xx status.
 * @module @delorun/bundle-local/client/host-api
 */

/** The `fetch` the requests go through: the browser's own, or a spec's fake. */
export type HostFetch = (input: string, init?: RequestInit) => Promise<Response>

/**
 * Why a request did not produce an answer: the Host refused it, the Host could not be reached, or its answer was not
 * the JSON the route promises.
 */
export type HostFailure =
  | { readonly kind: 'refused'; readonly status: number; readonly code: string; readonly message: string; readonly fields?: Readonly<Record<string, unknown>> }
  | { readonly kind: 'unreachable'; readonly cause: unknown }
  | { readonly kind: 'unreadable'; readonly status: number }

/** A failed request to the home, carrying its {@link HostFailure}. */
export class HostRequestError extends Error {
  /** The route that failed. */
  readonly path: string
  /** Why it failed. */
  readonly failure: HostFailure

  /**
   * @param path - the route that failed.
   * @param failure - why it failed.
   */
  constructor(path: string, failure: HostFailure) {
    super(`${path}: ${failure.kind === 'refused' ? `${failure.code}: ${failure.message}` : failure.kind}`, failure.kind === 'unreachable' ? { cause: failure.cause } : undefined)
    this.name = 'HostRequestError'
    this.path = path
    this.failure = failure
  }
}

/** The Host error code of a refusal that only the home's own computer may perform. */
export const LOOPBACK_REQUIRED = 'LOOPBACK_REQUIRED'

/** A request's state in a section: not answered yet, answered, or failed with the sentence to show. */
export type Loaded<T> = { readonly kind: 'loading' } | { readonly kind: 'ready'; readonly value: T } | { readonly kind: 'failed'; readonly text: string }

/** A predicate over one decoded JSON value. */
export type Check = (value: unknown) => boolean

/** Whether a decoded value is a JSON object. */
export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
/** Whether a decoded value is a string. */
export const isString: Check = value => typeof value === 'string'
/** Whether a decoded value is a boolean. */
export const isBoolean: Check = value => typeof value === 'boolean'
/** Whether a decoded value is a finite number, such as a time in milliseconds. */
export const isTime: Check = value => typeof value === 'number' && Number.isFinite(value)
/** A check that also accepts null. */
export const orNull = (check: Check): Check => value => value === null || check(value)
/** A check that also accepts an absent field. */
export const optional = (check: Check): Check => value => value === undefined || check(value)
/** A check of an array whose every entry passes `check`. */
export const listOf = (check: Check): Check => value => Array.isArray(value) && value.every(check)
/** A check of an object whose named fields each pass their check; other fields are ignored. */
export const fields = (shape: Readonly<Record<string, Check>>): Check =>
  value => isRecord(value) && Object.entries(shape).every(([key, check]) => check(value[key]))

const isRefusal = fields({ error: isString, message: isString })

/** What a request adds to the defaults: headers, and `keepalive` for a request sent while the page closes. */
export interface RequestExtras {
  readonly headers?: Readonly<Record<string, string>>
  readonly keepalive?: boolean
}

/**
 * Send one request and read its JSON answer.
 * @param fetch - the request function.
 * @param path - the route.
 * @param body - the JSON body; absent sends none.
 * @param extra - added headers and `keepalive`.
 * @returns the status and the decoded answer.
 * @throws {HostRequestError} `unreachable` when the request did not complete, `unreadable` when the answer is not JSON.
 */
async function send(fetch: HostFetch, path: string, body?: object, extra: RequestExtras = {}): Promise<{ status: number; ok: boolean; json: unknown }> {
  const init: RequestInit = body === undefined
    ? { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json', ...extra.headers } }
    : { method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json', 'content-type': 'application/json', ...extra.headers }, body: JSON.stringify(body) }
  if (extra.keepalive === true) init.keepalive = true
  let response: Response
  try {
    response = await fetch(path, init)
  } catch (cause) {
    throw new HostRequestError(path, { kind: 'unreachable', cause })
  }
  let json: unknown
  try {
    json = await response.json()
  } catch {
    // The answer is not JSON (a proxy's page, for example): the caller reports an unreadable answer.
    throw new HostRequestError(path, { kind: 'unreadable', status: response.status })
  }
  return { status: response.status, ok: response.ok, json }
}

/**
 * Send one request and validate its answer.
 * @param fetch - the request function.
 * @param path - the route.
 * @param check - the answer's validation.
 * @param body - the JSON body; absent sends a GET.
 * @param extra - added headers and `keepalive`.
 * @returns the validated answer.
 * @throws {HostRequestError} for a refusal, an unreachable Host or an answer that fails validation.
 */
export async function call<T>(fetch: HostFetch, path: string, check: Check, body?: object, extra?: RequestExtras): Promise<T> {
  const { status, ok, json } = await send(fetch, path, body, extra)
  if (!ok) {
    if (!isRefusal(json)) throw new HostRequestError(path, { kind: 'unreadable', status })
    const refusal = json as { error: string; message: string } & Record<string, unknown>
    throw new HostRequestError(path, { kind: 'refused', status, code: refusal.error, message: refusal.message, fields: refusal })
  }
  if (!check(json)) throw new HostRequestError(path, { kind: 'unreadable', status })
  return json as T
}

/**
 * The failure a caught error stands for.
 * @param error - the caught error.
 * @returns the {@link HostRequestError}'s failure; any other error is reported as an unreachable Host, with the error
 *   as its cause.
 */
export function hostFailureOf(error: unknown): HostFailure {
  return error instanceof HostRequestError ? error.failure : { kind: 'unreachable', cause: error }
}

/**
 * Whether an error is the Host's refusal with one code.
 * @param error - the caught error.
 * @param code - the Host error code.
 * @returns true for a {@link HostRequestError} whose refusal carries that code.
 */
export function isRefused(error: unknown, code: string): boolean {
  const failure = hostFailureOf(error)
  return failure.kind === 'refused' && failure.code === code
}

/**
 * Read one route that a profile may not serve.
 * @param fetch - the request function.
 * @param path - the route.
 * @param check - the answer's validation.
 * @param extra - added headers and `keepalive`.
 * @returns the validated answer, or undefined when the route answers 404, as a route this profile does not mount does.
 * @throws {HostRequestError} for any other refusal, an unreachable Host or an answer that fails validation.
 */
export async function readServedRoute<T>(fetch: HostFetch, path: string, check: Check, extra?: RequestExtras): Promise<T | undefined> {
  try {
    return await call<T>(fetch, path, check, undefined, extra)
  } catch (error) {
    const failure = hostFailureOf(error)
    if (failure.kind !== 'unreachable' && failure.status === 404) return undefined
    throw error
  }
}

/** The sentences a section shows for each kind of {@link HostFailure}. */
export interface FailureSentences {
  /**
   * The sentence for a refusal.
   * @param code - the Host error code.
   * @param message - the Host's own sentence.
   * @returns the sentence to show.
   */
  refused(code: string, message: string): string
  /** The sentence for a Host that did not answer. */
  readonly unreachable: string
  /** The sentence for an answer that could not be read. */
  readonly unreadable: string
}

/**
 * The sentence for a failed request.
 * @param error - the caught error.
 * @param sentences - the section's sentences.
 * @returns the sentence for the error's {@link HostFailure}.
 */
export function failureSentence(error: unknown, sentences: FailureSentences): string {
  const failure = hostFailureOf(error)
  switch (failure.kind) {
    case 'refused':
      return sentences.refused(failure.code, failure.message)
    case 'unreachable':
      return sentences.unreachable
    case 'unreadable':
      return sentences.unreadable
    /* v8 ignore next 2 -- HostFailure is a closed union, so the default holds no reachable statement. */
    default:
      return failure satisfies never
  }
}
