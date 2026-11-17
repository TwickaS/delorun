/**
 * What the sign-up form and the Worker that receives it both state: the field names, the consent sentence a person
 * ticks and its version, and the limits on what they type.
 *
 * @module @delorun/website/signup
 */
import { EN } from './words/en.ts'

/** The sentence beside the tick box, from the dictionary of the page's language. The Worker stores {@link CONSENT_TEXT_VERSION} with each sign-up. */
export const CONSENT_TEXT = EN.signup.consent.text

/** Names the wording of {@link CONSENT_TEXT}; the dictionary raises it whenever the sentence or the page around it changes, so each stored consent names the words that were agreed to. */
export const CONSENT_TEXT_VERSION = EN.signup.consent.version

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
  turnstile: 'cf-turnstile-response',
} as const

/** The route the form posts to. */
export const SUBSCRIBE_PATH = '/api/subscribe'

/** The route that tells the form its Turnstile site key. */
export const SIGNUP_CONFIG_PATH = '/api/signup-config'

/** Days after which a sign-up nobody confirmed is deleted. */
export const UNCONFIRMED_DAYS = 30
