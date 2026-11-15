/**
 * The rules for a new PIN or passcode, checked before the secret is sent. They mirror the home's own check
 * (`checkNewSecret` in `@delorun/home-auth`), which stays the authority: a secret this passes can still be refused.
 */

/** Rule values the home enforces. */
const MIN_PIN_DIGITS = 6
const MIN_PASSCODE_CHARS = 10
const MAX_SECRET_CHARS = 128
const COMMON_PINS = new Set(['123456', '1234567', '12345678', '123123', '121212', '112233', '654321', '696969', '000000', '123321', '159753', '147258', '142536', '102030', '121314'])

/** The rule a secret breaks. */
export type SecretProblem = 'tooLong' | 'pinShort' | 'pinWeak' | 'passcodeShort' | 'passcodeRepeat'

/**
 * Whether the digits are one to three digits repeated.
 * @param digits - the digits.
 * @returns whether they are.
 */
function isRepeat(digits: string): boolean {
  for (let size = 1; size <= 3; size += 1) {
    if (digits.length % size === 0 && digits === digits.slice(0, size).repeat(digits.length / size)) return true
  }
  return false
}

/**
 * Whether the digits climb or fall by one at every step.
 * @param digits - the digits.
 * @returns whether they do.
 */
function isRun(digits: string): boolean {
  const steps = new Set<number>()
  for (let at = 1; at < digits.length; at += 1) steps.add(Number(digits[at]) - Number(digits[at - 1]))
  return steps.size === 1 && (steps.has(1) || steps.has(-1))
}

/**
 * Check a typed secret against the rules.
 * @param typed - what the person typed.
 * @returns the broken rule, or undefined when the secret passes.
 */
export function secretProblem(typed: string): SecretProblem | undefined {
  const secret = typed.normalize('NFC')
  const length = [...secret].length
  if (length > MAX_SECRET_CHARS) return 'tooLong'
  if (!/^[0-9]+$/.test(secret)) {
    if (length < MIN_PASSCODE_CHARS) return 'passcodeShort'
    return new Set(secret).size === 1 ? 'passcodeRepeat' : undefined
  }
  if (length < MIN_PIN_DIGITS) return 'pinShort'
  return isRepeat(secret) || isRun(secret) || COMMON_PINS.has(secret) ? 'pinWeak' : undefined
}
