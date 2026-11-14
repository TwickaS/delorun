/**
 * Bounded Host teardown that never ends the process: the wait a failed start, a refused boot and an update's switch
 * put on a Host's teardown, and the error that reports a refused Host whose teardown did not finish.
 *
 * @module @delorun/home-process/host-stop
 */

/**
 * How long a failed start or a refused boot waits for its Host's teardown, in seconds: upstream's own grace before it
 * ends a process whose application does not dispose.
 */
export const REFUSED_HOST_STOP_S = 5

/** How a bounded Host teardown ended. */
export type HostStopOutcome =
  | { readonly stopped: true }
  | { readonly stopped: false, readonly kind: 'overran', readonly limitS: number }
  | { readonly stopped: false, readonly kind: 'failed', readonly error: unknown }

/**
 * Run a Host's teardown and wait for it at most `limitS` seconds. Nothing here ends the process: a teardown that
 * overruns goes on in the background, and its later failure is dropped, because the outcome already reports it.
 * @param stop - the teardown; a synchronous throw counts as a failed teardown.
 * @param limitS - the longest wait, in seconds.
 * @returns whether the Host stopped, or how its teardown did not finish.
 */
export async function stopHostWithin(stop: () => Promise<void>, limitS: number): Promise<HostStopOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const overrun = new Promise<HostStopOutcome>((resolve) => {
    timer = setTimeout(() => { resolve({ stopped: false, kind: 'overran', limitS }) }, limitS * 1000)
  })
  const teardown = Promise.resolve().then(stop).then(
    (): HostStopOutcome => ({ stopped: true }),
    (error: unknown): HostStopOutcome => ({ stopped: false, kind: 'failed', error }),
  )
  try {
    return await Promise.race([teardown, overrun])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Why a Host's teardown did not finish, as a clause after "the Host".
 * @param outcome - a teardown that did not finish.
 * @returns the clause.
 */
export function hostStopFailure(outcome: Exclude<HostStopOutcome, { readonly stopped: true }>): string {
  return outcome.kind === 'overran'
    ? `did not stop within ${String(outcome.limitS)} seconds`
    : `failed to stop (${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)})`
}

/**
 * A start or a boot was refused, and the refused Host's teardown failed or did not finish in time: that Host may still
 * run in this process and use the profile's data. Whoever catches it runs nothing more on that data, such as a
 * rollback or another start, and the home lock stays held until the process ends. Its `cause` is the refusal.
 */
export class HostNotStoppedError extends Error {
  /** How the refused Host's teardown did not finish. */
  readonly outcome: Exclude<HostStopOutcome, { readonly stopped: true }>

  /**
   * @param refusal - the refusal or failure that stopped the start.
   * @param outcome - how the refused Host's teardown did not finish.
   */
  constructor(refusal: unknown, outcome: Exclude<HostStopOutcome, { readonly stopped: true }>) {
    super(`${refusal instanceof Error ? refusal.message : String(refusal)}; the refused Host ${hostStopFailure(outcome)} and may still run in this process`, { cause: refusal })
    this.name = 'HostNotStoppedError'
    this.outcome = outcome
  }
}

/**
 * Tear down a Host that a check refused, within {@link REFUSED_HOST_STOP_S}, and throw the refusal.
 * @param stop - the refused Host's teardown, which must end no process.
 * @param refusal - the refusal to throw once the Host has stopped.
 * @param limitS - the longest wait, in seconds.
 * @returns never.
 * @throws the refusal when the Host stopped; {@link HostNotStoppedError} carrying it when the teardown failed or overran.
 */
export async function refuseBootedHost(stop: () => Promise<void>, refusal: unknown, limitS = REFUSED_HOST_STOP_S): Promise<never> {
  const outcome = await stopHostWithin(stop, limitS)
  if (outcome.stopped) throw refusal
  throw new HostNotStoppedError(refusal, outcome)
}
