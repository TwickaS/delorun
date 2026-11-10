/**
 * The termination signals a home process answers (contract C19, "The home process"): `SIGTERM`, a supervisor's or a
 * login item's ordinary stop, ends it with code 0, and `SIGINT`, a person's interrupt, with code 130, the codes
 * upstream's profile runner uses. The home process holds one listener for both for its whole life, across every Host
 * it boots, so its own stop order runs whatever Host is current.
 *
 * @module @delo/home-process/signals
 */

/** A termination signal the home process answers. */
export type HomeSignal = 'SIGTERM' | 'SIGINT'

/** The exit code each signal ends the home process with. */
export const SIGNAL_EXIT_CODES: Readonly<Record<HomeSignal, number>> = { SIGTERM: 0, SIGINT: 130 }

/**
 * Listen for this operating-system process's `SIGTERM` and `SIGINT`: the `onSignal` a real home process runs with.
 * While the listener is registered, Node's default handling of both signals, which ends the process without its
 * `exit` listeners, does not run.
 * @param listener - runs with the signal's name each time one arrives.
 * @returns the disposer that removes the listener from both signals.
 */
export function listenProcessSignals(listener: (signal: HomeSignal) => void): () => void {
  const terminate = (): void => { listener('SIGTERM') }
  const interrupt = (): void => { listener('SIGINT') }
  process.on('SIGTERM', terminate)
  process.on('SIGINT', interrupt)
  return () => {
    process.off('SIGTERM', terminate)
    process.off('SIGINT', interrupt)
  }
}
