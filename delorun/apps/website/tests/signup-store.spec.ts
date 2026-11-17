import { describe, expect, it } from 'vitest'
import { confirm, listUnsent, purgeUnconfirmed, recordSignup, rotateTokens, unsubscribe } from '../src/worker/store.ts'
import { hashToken, isTokenShape, newToken } from '../src/worker/tokens.ts'
import { normaliseEmail, normaliseName, parseSignup } from '../src/worker/validate.ts'
import { createDb } from './d1-sqlite.ts'
import { CONSENT_TEXT_VERSION } from '../src/site/signup.ts'

const INPUT = { email: 'ada@example.com', firstName: 'Ada', page: '/' }
const T0 = '2026-11-13T10:00:00.000Z'

async function hashes(): Promise<{ confirm: string; unsubscribe: string }> {
  return { confirm: await hashToken(newToken()), unsubscribe: await hashToken(newToken()) }
}

describe('validation', () => {
  it('lower-cases and trims an address and refuses what is not one', () => {
    expect(normaliseEmail('  Ada@Example.COM ')).toBe('ada@example.com')
    for (const bad of ['', 'ada', 'ada@', '@example.com', 'ada@example', 'a b@example.com', 'a@b@example.com', `${'a'.repeat(250)}@example.com`, 'ada@example.com, bob@example.com']) {
      expect(normaliseEmail(bad)).toBeUndefined()
    }
  })

  it('treats a name as text: control characters go, an empty name is none, a long one is refused', () => {
    expect(normaliseName('  Ada\n\tLovelace ')).toBe('Ada Lovelace')
    expect(normaliseName('   ')).toBeNull()
    expect(normaliseName('x'.repeat(81))).toBeUndefined()
    expect(normaliseName('<b>Ada</b>')).toBe('<b>Ada</b>')
  })

  it('needs the consent box and keeps only known pages', () => {
    const fields = { firstName: 'first_name', email: 'email', consent: 'consent', page: 'page' }
    const form = (entries: Record<string, string>): FormData => Object.entries(entries).reduce((data, [key, value]) => (data.set(key, value), data), new FormData())
    expect(parseSignup(form({ email: 'ada@example.com' }), fields)).toEqual({ ok: false, problem: 'consent' })
    expect(parseSignup(form({ email: 'nope', consent: 'yes' }), fields)).toEqual({ ok: false, problem: 'email' })
    expect(parseSignup(form({ email: 'ada@example.com', consent: 'yes', page: '/evil' }), fields)).toEqual({ ok: true, value: { email: 'ada@example.com', firstName: null, page: 'unknown' } })
    expect(parseSignup(form({ email: 'ada@example.com', consent: 'yes', page: '/privacy', first_name: 'Ada' }), fields)).toMatchObject({ ok: true, value: { firstName: 'Ada', page: '/privacy' } })
  })
})

describe('tokens', () => {
  it('are random, shaped as expected and stored only as hashes', async () => {
    const a = newToken()
    expect(a).not.toBe(newToken())
    expect(isTokenShape(a)).toBe(true)
    expect(isTokenShape('short')).toBe(false)
    expect(isTokenShape(null)).toBe(false)
    const hash = await hashToken(a)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).not.toContain(a)
    expect(await hashToken(a)).toBe(hash)
  })

  it('never reach the database in the clear', async () => {
    const db = createDb()
    const confirmToken = newToken()
    const unsubscribeToken = newToken()
    await recordSignup(db, INPUT, { confirm: await hashToken(confirmToken), unsubscribe: await hashToken(unsubscribeToken) }, T0)
    const dump = JSON.stringify(db.rows('SELECT * FROM subscribers'))
    expect(dump).not.toContain(confirmToken)
    expect(dump).not.toContain(unsubscribeToken)
  })
})

describe('the subscriber table', () => {
  it('stores a new sign-up as pending with its consent record and no network details', async () => {
    const db = createDb()
    expect(await recordSignup(db, INPUT, await hashes(), T0)).toEqual({ kind: 'created' })
    const [row] = db.rows('SELECT * FROM subscribers')
    expect(row).toMatchObject({ email: 'ada@example.com', first_name: 'Ada', status: 'pending', consent_at: T0, consent_page: '/', consent_text_version: CONSENT_TEXT_VERSION, confirmation_sent_at: null })
    expect(Object.keys(row ?? {})).not.toContain('ip')
  })

  it('treats the address case-insensitively', async () => {
    const db = createDb()
    await recordSignup(db, INPUT, await hashes(), T0)
    const again = await recordSignup(db, { ...INPUT, email: 'ADA@example.com' }, await hashes(), T0)
    expect(again.kind).not.toBe('created')
    expect(db.rows('SELECT id FROM subscribers')).toHaveLength(1)
  })

  it('confirms through the link, and following it again changes nothing', async () => {
    const db = createDb()
    const h = await hashes()
    await recordSignup(db, INPUT, h, T0)
    expect(await confirm(db, h.confirm, '2026-11-13T11:00:00.000Z')).toBe('done')
    expect(await confirm(db, h.confirm, '2026-11-14T11:00:00.000Z')).toBe('already')
    expect(db.rows('SELECT status, confirmed_at FROM subscribers')).toEqual([{ status: 'confirmed', confirmed_at: '2026-11-13T11:00:00.000Z' }])
    expect(await confirm(db, await hashToken(newToken()), T0)).toBe('unknown')
  })

  it('does not let a later sign-up touch a confirmed record', async () => {
    const db = createDb()
    const h = await hashes()
    await recordSignup(db, INPUT, h, T0)
    await confirm(db, h.confirm, T0)
    const before = db.rows('SELECT * FROM subscribers')
    expect(await recordSignup(db, { ...INPUT, firstName: 'Someone else', page: '/privacy' }, await hashes(), '2026-12-01T00:00:00.000Z')).toEqual({ kind: 'unchanged' })
    expect(db.rows('SELECT * FROM subscribers')).toEqual(before)
  })

  it('refreshes a pending record only once its last confirmation is over an hour old', async () => {
    const db = createDb()
    const first = await hashes()
    await recordSignup(db, INPUT, first, T0)
    expect(await recordSignup(db, INPUT, await hashes(), '2026-11-13T10:05:00.000Z')).toEqual({ kind: 'refreshed' })
    db.rows("UPDATE subscribers SET confirmation_sent_at = '2026-11-13T10:05:00.000Z' RETURNING id")
    expect(await recordSignup(db, INPUT, await hashes(), '2026-11-13T10:30:00.000Z')).toEqual({ kind: 'unchanged' })
    expect(await recordSignup(db, { ...INPUT, firstName: 'Ada L' }, await hashes(), '2026-11-13T11:06:00.000Z')).toEqual({ kind: 'refreshed' })
    expect(db.rows('SELECT first_name, consent_at FROM subscribers')).toEqual([{ first_name: 'Ada L', consent_at: '2026-11-13T11:06:00.000Z' }])
    expect(await confirm(db, first.confirm, T0)).toBe('unknown')
  })

  it('unsubscribes through the link whatever the status, and repeating it changes nothing', async () => {
    const db = createDb()
    const h = await hashes()
    await recordSignup(db, INPUT, h, T0)
    await confirm(db, h.confirm, T0)
    expect(await unsubscribe(db, h.unsubscribe, '2026-11-15T00:00:00.000Z')).toBe('done')
    expect(await unsubscribe(db, h.unsubscribe, '2026-11-16T00:00:00.000Z')).toBe('already')
    expect(db.rows('SELECT status, updated_at FROM subscribers')).toEqual([{ status: 'unsubscribed', updated_at: '2026-11-15T00:00:00.000Z' }])
    expect(await unsubscribe(db, await hashToken(newToken()), T0)).toBe('unknown')
    expect(await confirm(db, h.confirm, T0)).toBe('gone')
  })

  it('lets an unsubscribed address sign up again, as pending until it confirms', async () => {
    const db = createDb()
    const h = await hashes()
    await recordSignup(db, INPUT, h, T0)
    await unsubscribe(db, h.unsubscribe, T0)
    expect(await recordSignup(db, INPUT, await hashes(), '2026-11-14T00:00:00.000Z')).toEqual({ kind: 'refreshed' })
    expect(db.rows('SELECT status FROM subscribers')).toEqual([{ status: 'pending' }])
  })

  it('deletes only pending records older than the limit', async () => {
    const db = createDb()
    const old = await hashes()
    await recordSignup(db, { ...INPUT, email: 'old@example.com' }, old, '2026-10-01T00:00:00.000Z')
    await recordSignup(db, { ...INPUT, email: 'new@example.com' }, await hashes(), '2026-11-10T00:00:00.000Z')
    const confirmed = await hashes()
    await recordSignup(db, { ...INPUT, email: 'kept@example.com' }, confirmed, '2026-10-01T00:00:00.000Z')
    await confirm(db, confirmed.confirm, '2026-10-02T00:00:00.000Z')
    expect(await purgeUnconfirmed(db, 30, '2026-11-13T00:00:00.000Z')).toBe(1)
    expect(db.rows('SELECT email FROM subscribers ORDER BY email')).toEqual([{ email: 'kept@example.com' }, { email: 'new@example.com' }])
  })

  it('lists unsent pending records and rotates the tokens of only a pending one', async () => {
    const db = createDb()
    const h = await hashes()
    await recordSignup(db, INPUT, h, T0)
    expect(await listUnsent(db, 10)).toEqual([{ id: 1, email: 'ada@example.com', firstName: 'Ada' }])
    expect(await rotateTokens(db, 1, await hashes(), T0)).toBe(true)
    expect(await confirm(db, h.confirm, T0)).toBe('unknown')
    await unsubscribe(db, (db.rows('SELECT unsubscribe_token_hash h FROM subscribers')[0] as { h: string }).h, T0)
    expect(await rotateTokens(db, 1, await hashes(), T0)).toBe(false)
  })

  it('refuses a status outside the three', () => {
    const db = createDb()
    expect(() => db.rows("INSERT INTO subscribers (email, consent_at, consent_page, consent_text_version, status, confirm_token_hash, unsubscribe_token_hash, created_at, updated_at) VALUES ('x@example.com','t','/','1','bogus','a','b','t','t')")).toThrow(/CHECK/)
  })
})
