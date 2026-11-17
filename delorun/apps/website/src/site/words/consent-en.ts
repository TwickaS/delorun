/**
 * The sign-up consent in English: every sentence the form has ever shown beside its tick box, each under its version,
 * and the answer a visitor gets when their page shows an older one. The form posts the version it rendered and the
 * Worker refuses any but the current one, so a consent is only ever recorded to words the visitor saw.
 *
 * @module @delorun/website/words/consent-en
 */

/** Every consent sentence by version. Never change or remove an entry: a new wording takes the next version. */
export const CONSENTS = {
  '1': 'Email me Delorun release news. One click unsubscribes.',
  '2': 'Email me Delorun release news and major articles. One click unsubscribes.',
} as const

/** The version the form shows and the Worker accepts. */
export const CONSENT_TEXT_VERSION = '2' satisfies keyof typeof CONSENTS

/** The sentence beside the tick box. */
export const CONSENT_TEXT: string = CONSENTS[CONSENT_TEXT_VERSION]

/** The answer to a sign-up from a page that shows an older consent sentence. */
export const CONSENT_OUT_OF_DATE = 'The sign-up words changed after this page loaded. Reload the page, read them again and sign up.'
