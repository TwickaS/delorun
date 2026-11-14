/**
 * The stack's sending flag: whether the Worker sends the confirmation message, and the origin its links point at.
 *
 * @module @delorun/website/sending
 */
import { SITE_URL } from './config.ts'

/** What a stage's deployment decides about email. */
export interface SendingSettings {
  readonly sending: boolean
  readonly publicOrigin: string | undefined
}

/**
 * Reads the flag. Unset, sending is on for the `prod` stage and off for every other.
 * @param stage - the stage being deployed.
 * @param environment - the deploying process's environment variables.
 * @returns the settings.
 * @throws when the flag is neither `on` nor `off`, or sending is on without an origin for the links.
 */
export function resolveSending(stage: string, environment: Readonly<Record<string, string | undefined>>): SendingSettings {
  const prod = stage === 'prod'
  const setting = environment.WEBSITE_CONFIRMATION_EMAIL ?? (prod ? 'on' : 'off')
  if (setting !== 'on' && setting !== 'off') throw new Error(`WEBSITE_CONFIRMATION_EMAIL must be "on" or "off", not "${setting}"`)
  const publicOrigin = environment.WEBSITE_PUBLIC_ORIGIN ?? (prod ? SITE_URL : undefined)
  if (setting === 'on' && publicOrigin === undefined) throw new Error(`Sending on stage "${stage}" needs WEBSITE_PUBLIC_ORIGIN, the origin that its message links point at`)
  return { sending: setting === 'on', publicOrigin }
}
