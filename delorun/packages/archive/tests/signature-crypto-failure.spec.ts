/**
 * Proves a signature check that fails inside the crypto library is reported as
 * an invalid signature rather than propagating: the library does not throw for
 * a malformed signature today, so the spec makes `verify` throw to pin that a
 * thrown failure never reads as a verified archive.
 */
import { verify } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { signManifest, verifyArchiveSignature } from '../src/index.ts'
import { refusal } from './refusals.ts'
import { makeKey, utf8 } from './support.ts'

vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return { ...actual, verify: vi.fn(actual.verify) }
})

describe('verifyArchiveSignature when the crypto library throws', () => {
  it('refuses the signature as not an Ed25519 signature over the manifest', () => {
    const key = makeKey()
    const manifestBytes = utf8('{}')
    const signature = signManifest(manifestBytes, 'home-key', key.privateKey)
    vi.mocked(verify).mockImplementationOnce(() => { throw new Error('crypto failure') })

    const error = refusal(() => verifyArchiveSignature({ manifestBytes, origin: { homeKeyId: 'home-key', publicKey: key.publicKey }, signature }))

    expect(error.code).toBe('ARCHIVE_SIGNATURE_INVALID')
    expect(error.message).toContain('not an Ed25519 signature')
  })
})
