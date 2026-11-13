/**
 * The marker of a fail-closed stand-in: the refusing service or guard a Delo row mounts when its real service failed to
 * activate. The CLI's boot invariant reads it to keep refusing to report the composition healthy.
 *
 * @module @delo/home/fail-closed
 */

/** Registry key of {@link FAIL_CLOSED_STUB}; a package without a `@delo/home` dependency repeats it in `Symbol.for`. */
export const FAIL_CLOSED_STUB_KEY = 'delo.fail-closed-stub'

/** The property a fail-closed stand-in carries, set to `true`. */
export const FAIL_CLOSED_STUB: unique symbol = Symbol.for(FAIL_CLOSED_STUB_KEY) as typeof FAIL_CLOSED_STUB

/** A value that carries {@link FAIL_CLOSED_STUB}. */
export interface FailClosedStub {
  readonly [FAIL_CLOSED_STUB]: true
}

/**
 * Whether a provided service or guard is a fail-closed stand-in.
 * @param value - what a context provides under a service name.
 * @returns `true` when the value carries the marker.
 */
export function isFailClosedStub(value: object | undefined): boolean {
  return value !== undefined && (value as Partial<FailClosedStub>)[FAIL_CLOSED_STUB] === true
}
