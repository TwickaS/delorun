/**
 * The confirmation message and its sending, behind the stack's sending flag.
 *
 * @module @delorun/website/worker/mail
 */
import { TRADING_NAME } from '../site/config.ts'
import type { Env, OutgoingEmail } from './env.ts'
import { markConfirmationSent, type TokenHashes } from './store.ts'

/** The tokens a confirmation message carries. */
export interface MessageTokens {
  readonly confirm: string
  readonly unsubscribe: string
}

/**
 * Escapes text for an HTML body.
 * @param text - plain text.
 * @returns the text with HTML's special characters replaced.
 */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/**
 * Builds the confirmation message. Names are treated as text and never as markup.
 * @param env - the Worker's settings.
 * @param to - the address.
 * @param firstName - the name, or null.
 * @param tokens - the tokens for the links.
 * @param origin - the origin the links point at.
 * @returns the message for the send binding.
 */
export function confirmationMessage(env: Pick<Env, 'SENDER_ADDRESS' | 'SUPPORT_ADDRESS'>, to: string, firstName: string | null, tokens: MessageTokens, origin: string): OutgoingEmail {
  const confirmUrl = `${origin}/confirm?token=${tokens.confirm}`
  const unsubscribeUrl = `${origin}/unsubscribe?token=${tokens.unsubscribe}`
  const greeting = firstName === null ? 'Hello,' : `Hello ${firstName},`
  const text = [
    greeting,
    '',
    'Someone, we hope you, asked for Delorun release news at delorun.com. To confirm that you want it, open this link:',
    '',
    confirmUrl,
    '',
    'If that was not you, ignore this message. We delete a sign-up that is not confirmed within 30 days.',
    '',
    `To unsubscribe, or to ask us to delete your address, open ${unsubscribeUrl} or write to ${env.SUPPORT_ADDRESS}.`,
    '',
    TRADING_NAME,
  ].join('\n')
  const html = [
    `<p>${escapeHtml(greeting)}</p>`,
    '<p>Someone, we hope you, asked for Delorun release news at delorun.com. To confirm that you want it, open this link:</p>',
    `<p><a href="${escapeHtml(confirmUrl)}">${escapeHtml(confirmUrl)}</a></p>`,
    '<p>If that was not you, ignore this message. We delete a sign-up that is not confirmed within 30 days.</p>',
    `<p>To unsubscribe, or to ask us to delete your address, <a href="${escapeHtml(unsubscribeUrl)}">unsubscribe here</a> or write to ${escapeHtml(env.SUPPORT_ADDRESS)}.</p>`,
    `<p>${escapeHtml(TRADING_NAME)}</p>`,
  ].join('\n')
  return {
    from: { email: env.SENDER_ADDRESS, name: TRADING_NAME },
    to,
    replyTo: env.SUPPORT_ADDRESS,
    subject: 'Confirm your Delorun updates sign-up',
    text,
    html,
    headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  }
}

/**
 * Sends a confirmation message when sending is on, and records that it went out. Nothing is sent when the flag is
 * off, and a failed send leaves the record unsent for the next sweep.
 * @param env - the Worker's bindings.
 * @param to - the address.
 * @param firstName - the name, or null.
 * @param tokens - the raw tokens.
 * @param hashes - the hashes of the same tokens.
 * @param origin - the origin the links point at.
 * @param now - the time as an ISO string.
 * @returns true when the message was accepted for sending.
 */
export async function sendConfirmation(env: Env, to: string, firstName: string | null, tokens: MessageTokens, hashes: TokenHashes, origin: string, now: string): Promise<boolean> {
  if (env.SEND_CONFIRMATION !== 'on' || env.EMAIL === undefined) return false
  try {
    await env.EMAIL.send(confirmationMessage(env, to, firstName, tokens, origin))
  } catch (error) {
    // The record stays unsent, so the daily sweep tries again; the log names the error code, never the address.
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'unknown'
    console.error('mail: confirmation was not sent', code)
    return false
  }
  await markConfirmationSent(env.DB, hashes.confirm, now)
  return true
}
