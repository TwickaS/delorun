/**
 * The sentence shown in the sign-up form's place when its script fails to load. It has a module of its own, with no
 * imports, so the form's wrapper in the entry does not import the shared dictionary.
 *
 * @module @delorun/website/words/signup-failed-en
 */

/** The form's fallback in English; `tests/chunk-failure.spec.ts` checks that it names the support address. */
export const SIGNUP_FAILED = 'The sign-up form did not load. Reload the page, or write to support@delorun.com to be added.'
