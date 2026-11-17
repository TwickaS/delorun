/**
 * The attribute of the replica's wrapper, which the scoped token block (`build/tokens.ts`) is written for. It is an
 * attribute and not a class, so no stylesheet has to hold a rule for a name that only scopes the tokens.
 * @module @delorun/website/replica/wrapper
 */

/** The wrapper's attribute name. */
export const WRAPPER_ATTRIBUTE = 'data-studio-replica'

/** The selector of the wrapper, for the token block and for specs. */
export const WRAPPER_SELECTOR = `[${WRAPPER_ATTRIBUTE}]`

/** The props that mark a wrapper element. */
export const WRAPPER_PROPS = { [WRAPPER_ATTRIBUTE]: '' } as const

/** The attribute that marks a still's element, carrying its width; `ReplicaFrame` reads the server's stills by it. */
export const STILL_ATTRIBUTE = 'data-replica-still'
