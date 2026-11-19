/**
 * Validation of what the sign-up form submits.
 *
 * @module @delorun/website/worker/validate
 */
import { MAX_EMAIL_LENGTH, MAX_NAME_LENGTH, SIGNUP_PAGES } from '../site/signup.ts'

/** The fields of a valid sign-up. */
export interface SignupInput {
  readonly email: string
  readonly firstName: string | null
  readonly page: string
}

/** Why a submission was refused; each names the message the form shows. */
export type SignupProblem = 'email' | 'name' | 'consent' | 'version'

/** One address: no spaces, one `@`, a dot in the domain. Delivery is proved by the confirmation, so the check is only a shape check. */
const EMAIL_SHAPE = /^[^\s@<>(),;:"[\]\\]+@[^\s@<>(),;:"[\]\\]+\.[^\s@<>(),;:"[\]\\]+$/

/** Control characters, which a name never needs. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g

/**
 * Cleans and checks an email address.
 * @param raw - the submitted text.
 * @returns the address in lower case, or undefined when it is not an address.
 */
export function normaliseEmail(raw: string): string | undefined {
  const email = raw.trim().toLowerCase()
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH) return undefined
  if (!EMAIL_SHAPE.test(email)) return undefined
  const [local = ''] = email.split('@')
  if (local.length > 64) return undefined
  return email
}

/**
 * Cleans a first name.
 * @param raw - the submitted text, which may be empty.
 * @returns the name, null when none was given, or undefined when it is too long.
 */
export function normaliseName(raw: string): string | null | undefined {
  const name = raw.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  if (name.length === 0) return null
  if ([...name].length > MAX_NAME_LENGTH) return undefined
  return name
}

/**
 * Checks a submitted form.
 * @param form - the form's fields.
 * @param fields - the field names the form uses.
 * @param currentVersion - the version of the consent sentence the Worker records; the form's submitted version must equal it, so a page that shows older words is refused, and so is a form with no version.
 * @returns the cleaned sign-up, or the first problem found; a version that is missing, malformed or not the current one is `version`.
 */
export function parseSignup(
  form: FormData,
  fields: { firstName: string; email: string; consent: string; page: string; consentVersion: string },
  currentVersion: string,
): { ok: true; value: SignupInput } | { ok: false; problem: SignupProblem } {
  // A page cached from before a deploy shows older words than the ones this Worker would record, so its version must be the current one.
  if (text(form, fields.consentVersion) !== currentVersion) return { ok: false, problem: 'version' }
  const email = normaliseEmail(text(form, fields.email))
  if (email === undefined) return { ok: false, problem: 'email' }
  const firstName = normaliseName(text(form, fields.firstName))
  if (firstName === undefined) return { ok: false, problem: 'name' }
  if (text(form, fields.consent) !== 'yes') return { ok: false, problem: 'consent' }
  const page = text(form, fields.page)
  return { ok: true, value: { email, firstName, page: (SIGNUP_PAGES as readonly string[]).includes(page) ? page : 'unknown' } }
}

/**
 * Reads one text field.
 * @param form - the form.
 * @param name - the field.
 * @returns the field's text, empty when it is absent or a file.
 */
function text(form: FormData, name: string): string {
  const value = form.get(name)
  return typeof value === 'string' ? value : ''
}
