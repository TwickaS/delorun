/**
 * The subscriber table: every read and write the Worker makes, with the status rules in one place.
 *
 * - A new address starts `pending`. Only the confirmation link makes it `confirmed`.
 * - A `confirmed` record is never changed by a later sign-up of the same address.
 * - An `unsubscribed` address stays on file, so it is not mailed again, until the person signs up and confirms again.
 *
 * @module @delo/website/worker/store
 */
import { CONSENT_TEXT_VERSION } from '../site/signup.ts'
import type { D1Like } from './env.ts'
import type { SignupInput } from './validate.ts'

/** Hours during which a sign-up of a pending address does not send another confirmation. */
export const RESEND_AFTER_HOURS = 1

/** The stored statuses. */
export type Status = 'pending' | 'confirmed' | 'unsubscribed'

/** What a sign-up did, which only the Worker's log and the confirmation sender see; the person always gets one answer. */
export type SignupOutcome =
  /** A new pending record: send its confirmation. */
  | { readonly kind: 'created' }
  /** An existing pending or unsubscribed record was refreshed with new tokens: send its confirmation. */
  | { readonly kind: 'refreshed' }
  /** Nothing changed: the address is confirmed, or a confirmation went out within {@link RESEND_AFTER_HOURS}. */
  | { readonly kind: 'unchanged' }

/** The hashes of the two tokens a confirmation message carries. */
export interface TokenHashes {
  readonly confirm: string
  readonly unsubscribe: string
}

interface ExistingRow {
  id: number
  status: Status
  confirmation_sent_at: string | null
}

/**
 * Records a sign-up.
 * @param db - the database.
 * @param input - the validated sign-up.
 * @param hashes - the hashes of the tokens to send.
 * @param now - the time as an ISO string.
 * @returns what changed.
 */
export async function recordSignup(db: D1Like, input: SignupInput, hashes: TokenHashes, now: string): Promise<SignupOutcome> {
  const inserted = await db.prepare(
    `INSERT INTO subscribers (email, first_name, consent_at, consent_page, consent_text_version, status, confirm_token_hash, unsubscribe_token_hash, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7, ?3, ?3) ON CONFLICT (email) DO NOTHING`,
  ).bind(input.email, input.firstName, now, input.page, CONSENT_TEXT_VERSION, hashes.confirm, hashes.unsubscribe).run()
  if (inserted.meta.changes === 1) return { kind: 'created' }

  const existing = await db.prepare('SELECT id, status, confirmation_sent_at FROM subscribers WHERE email = ?1').bind(input.email).first<ExistingRow>()
  if (existing === null || existing.status === 'confirmed') return { kind: 'unchanged' }
  const cutoff = new Date(Date.parse(now) - RESEND_AFTER_HOURS * 3_600_000).toISOString()
  if (existing.confirmation_sent_at !== null && existing.confirmation_sent_at > cutoff) return { kind: 'unchanged' }

  const refreshed = await db.prepare(
    `UPDATE subscribers SET first_name = ?2, consent_at = ?3, consent_page = ?4, consent_text_version = ?5, status = 'pending',
       confirm_token_hash = ?6, unsubscribe_token_hash = ?7, confirmed_at = NULL, confirmation_sent_at = NULL, updated_at = ?3
     WHERE id = ?1 AND status != 'confirmed'`,
  ).bind(existing.id, input.firstName, now, input.page, CONSENT_TEXT_VERSION, hashes.confirm, hashes.unsubscribe).run()
  return refreshed.meta.changes === 1 ? { kind: 'refreshed' } : { kind: 'unchanged' }
}

/**
 * Notes that a confirmation message was accepted for sending.
 * @param db - the database.
 * @param confirmHash - the hash of the message's confirmation token.
 * @param now - the time as an ISO string.
 */
export async function markConfirmationSent(db: D1Like, confirmHash: string, now: string): Promise<void> {
  await db.prepare('UPDATE subscribers SET confirmation_sent_at = ?2 WHERE confirm_token_hash = ?1').bind(confirmHash, now).run()
}

/** A pending record that no confirmation message has gone out for. */
export interface UnsentRow {
  readonly id: number
  readonly email: string
  readonly firstName: string | null
}

/**
 * Lists pending records without a sent confirmation, oldest first.
 * @param db - the database.
 * @param limit - the most to return.
 * @returns the records.
 */
export async function listUnsent(db: D1Like, limit: number): Promise<UnsentRow[]> {
  const { results } = await db.prepare(
    `SELECT id, email, first_name FROM subscribers WHERE status = 'pending' AND confirmation_sent_at IS NULL ORDER BY consent_at LIMIT ?1`,
  ).bind(limit).all<{ id: number; email: string; first_name: string | null }>()
  return results.map(row => ({ id: row.id, email: row.email, firstName: row.first_name }))
}

/**
 * Gives a pending record new tokens, since the sent ones are not kept.
 * @param db - the database.
 * @param id - the record.
 * @param hashes - the hashes of the new tokens.
 * @param now - the time as an ISO string.
 * @returns true when the record was still pending and was changed.
 */
export async function rotateTokens(db: D1Like, id: number, hashes: TokenHashes, now: string): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE subscribers SET confirm_token_hash = ?2, unsubscribe_token_hash = ?3, updated_at = ?4 WHERE id = ?1 AND status = 'pending'`,
  ).bind(id, hashes.confirm, hashes.unsubscribe, now).run()
  return result.meta.changes === 1
}

/** What a confirmation or unsubscribe link did. */
export type LinkResult = 'done' | 'already' | 'unknown' | 'gone'

/**
 * Confirms a pending sign-up. Following the link again does nothing more.
 * @param db - the database.
 * @param confirmHash - the hash of the link's token.
 * @param now - the time as an ISO string.
 * @returns `done` when it confirmed, `already` when it was confirmed before, `gone` when the address has unsubscribed since, `unknown` when no record has the token.
 */
export async function confirm(db: D1Like, confirmHash: string, now: string): Promise<LinkResult> {
  const row = await db.prepare('SELECT status FROM subscribers WHERE confirm_token_hash = ?1').bind(confirmHash).first<{ status: Status }>()
  if (row === null) return 'unknown'
  if (row.status === 'confirmed') return 'already'
  if (row.status === 'unsubscribed') return 'gone'
  const result = await db.prepare(
    `UPDATE subscribers SET status = 'confirmed', confirmed_at = ?2, updated_at = ?2 WHERE confirm_token_hash = ?1 AND status = 'pending'`,
  ).bind(confirmHash, now).run()
  return result.meta.changes === 1 ? 'done' : 'already'
}

/**
 * Unsubscribes an address, whatever its status. Following the link again does nothing more.
 * @param db - the database.
 * @param unsubscribeHash - the hash of the link's token.
 * @param now - the time as an ISO string.
 * @returns `done` when it unsubscribed, `already` when it had, `unknown` when no record has the token.
 */
export async function unsubscribe(db: D1Like, unsubscribeHash: string, now: string): Promise<'done' | 'already' | 'unknown'> {
  const row = await db.prepare('SELECT status FROM subscribers WHERE unsubscribe_token_hash = ?1').bind(unsubscribeHash).first<{ status: Status }>()
  if (row === null) return 'unknown'
  if (row.status === 'unsubscribed') return 'already'
  const result = await db.prepare(
    `UPDATE subscribers SET status = 'unsubscribed', updated_at = ?2 WHERE unsubscribe_token_hash = ?1 AND status != 'unsubscribed'`,
  ).bind(unsubscribeHash, now).run()
  return result.meta.changes === 1 ? 'done' : 'already'
}

/**
 * Deletes sign-ups that were never confirmed.
 * @param db - the database.
 * @param days - the age in days, from the time of consent, beyond which a pending record goes.
 * @param now - the time as an ISO string.
 * @returns how many records were deleted.
 */
export async function purgeUnconfirmed(db: D1Like, days: number, now: string): Promise<number> {
  const cutoff = new Date(Date.parse(now) - days * 86_400_000).toISOString()
  const result = await db.prepare(`DELETE FROM subscribers WHERE status = 'pending' AND consent_at < ?1`).bind(cutoff).run()
  return result.meta.changes
}
