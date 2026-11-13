/**
 * What the sign-up form and the Worker that receives it both state: the field names, the consent sentence a person
 * ticks and its version, and the limits on what they type.
 *
 * @module @delo/website/signup
 */

/** The sentence beside the tick box. The Worker stores {@link CONSENT_TEXT_VERSION} with each sign-up. */
export const CONSENT_TEXT = 'Email me Delorun release news. One click unsubscribes.'

/** Names the wording of {@link CONSENT_TEXT}. Change it whenever the sentence changes, so each stored consent names the words that were agreed to. */
export const CONSENT_TEXT_VERSION = '1'

/** The longest first name the form accepts, in characters. */
export const MAX_NAME_LENGTH = 80

/** The longest email address the form accepts, in characters (RFC 5321). */
export const MAX_EMAIL_LENGTH = 254

/** The pages that carry the form, which the Worker stores as the place of consent. */
export const SIGNUP_PAGES = ['/', '/privacy'] as const

/** The form fields, which the browser and the Worker read by the same names. */
export const FIELDS = {
  firstName: 'first_name',
  email: 'email',
  consent: 'consent',
  page: 'page',
  turnstile: 'cf-turnstile-response',
} as const

/** The route the form posts to. */
export const SUBSCRIBE_PATH = '/api/subscribe'

/** The route that tells the form its Turnstile site key. */
export const SIGNUP_CONFIG_PATH = '/api/signup-config'

/** Days after which a sign-up nobody confirmed is deleted. */
export const UNCONFIRMED_DAYS = 30
