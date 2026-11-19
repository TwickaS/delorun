/**
 * What the sign-up form and the Worker that receives it both state: the field names, the consent sentence a person
 * ticks and its version, and the limits on what they type.
 *
 * @module @delorun/website/signup
 */

/** The consent sentence, its version, and the answer to a page that shows an older one; see `words/consent-en.ts`. */
export { CONSENT_OUT_OF_DATE, CONSENT_TEXT, CONSENT_TEXT_VERSION } from './words/consent-en.ts'

/** The longest first name the form accepts, in characters. */
export const MAX_NAME_LENGTH = 80

/** The longest email address the form accepts, in characters (RFC 5321). */
export const MAX_EMAIL_LENGTH = 254

/** The home page, whose sign-up section records it as the place of consent. */
export const HOME_SIGNUP_PAGE = '/'

/** The pages that carry the form, which the Worker stores as the place of consent; any other value is stored as `unknown`. */
export const SIGNUP_PAGES = [HOME_SIGNUP_PAGE, '/privacy', '/notices', '/blog'] as const

/** The form fields, which the browser and the Worker read by the same names. */
export const FIELDS = {
  firstName: 'first_name',
  email: 'email',
  consent: 'consent',
  page: 'page',
  consentVersion: 'consent_version',
  turnstile: 'cf-turnstile-response',
} as const

/** The route the form posts to. */
export const SUBSCRIBE_PATH = '/api/subscribe'

/** The route that tells the form its Turnstile site key. */
export const SIGNUP_CONFIG_PATH = '/api/signup-config'

/** Days after which a sign-up nobody confirmed is deleted. */
export const UNCONFIRMED_DAYS = 30
