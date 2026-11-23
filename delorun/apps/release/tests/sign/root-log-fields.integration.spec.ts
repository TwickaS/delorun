/**
 * The root's `logEntryKeys` and `logs` (contract C2): what a root may carry in them, how the draft command writes them
 * from public key files, and that they reach a client only through a root the chain verifies. Every key is a throwaway
 * one generated here.
 */
import { createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { LogEntryKey, RootMetadata } from '@delorun/contract-release-manifest'
import { NOTE_COSIGNATURE, NOTE_ED25519, verifierKey } from '@delorun/release-formats/log/note'
import { signEnvelope } from '@delorun/release-formats/sign/envelope'
import { toJsonValue } from '@delorun/release-formats/sign/json'
import { RootSchema } from '@delorun/release-formats/sign/schemas'
import { walkRootChain } from '@delorun/release-formats/sign/verify'
import { draftRoot } from '../../src/draft-root.ts'
import { scratch } from '../support.ts'
import { rootFile, throwawayKeys } from './fixture.ts'

/**
 * A key's DER public key, base64.
 * @param key - the key.
 * @returns the base64 SPKI.
 */
function der(key: KeyObject): string {
  return (key.type === 'public' ? key : createPublicKey(key)).export({ format: 'der', type: 'spki' }).toString('base64')
}

const ED = generateKeyPairSync('ed25519').publicKey
const EC = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey

/**
 * Whether a root's content reads under the schema.
 * @param change - the fields to set on a fixture root.
 * @returns the first issue's message, or `undefined` when it reads.
 */
function issue(change: Record<string, unknown>): string | undefined {
  const base = rootFile(throwawayKeys(), {}, undefined, true).metadata
  const parsed = RootSchema.safeParse({ ...base, ...change })
  return parsed.success ? undefined : parsed.error.issues[0]?.message ?? 'refused'
}

describe('the root schema', () => {
  const active = (keyDetails: string, key: KeyObject): LogEntryKey => ({ keyDetails, public: der(key), status: 'active' })

  it('reads a root without either field, and one with both', () => {
    expect(issue({})).toBeUndefined()
    const log = rootFile(throwawayKeys()).metadata.log
    expect(issue({ logEntryKeys: [active('PKIX_ED25519_PH', ED), active('PKIX_ECDSA_P256_SHA_256', EC)], logs: [log, { origin: 'earlier.example.test', vkey: 'earlier.example.test+00000000+AQ==' }] })).toBeUndefined()
  })

  it('stays strict: refuses any other new field', () => {
    expect(issue({ logEntryKeyTypes: ['PKIX_ED25519_PH'] })).not.toBeUndefined()
    expect(issue({ logEntryKeys: [{ ...active('PKIX_ED25519_PH', ED), note: 'x' }] })).not.toBeUndefined()
    expect(issue({ logs: [{ ...rootFile(throwawayKeys()).metadata.log, url: 'https://x' }] })).not.toBeUndefined()
  })

  it('refuses a log-entry key whose public key is not of its type, or is not canonical base64', () => {
    expect(issue({ logEntryKeys: [active('PKIX_ED25519_PH', EC)] })).toContain('not a DER public key of that type')
    expect(issue({ logEntryKeys: [active('PKIX_ECDSA_P256_SHA_256', ED)] })).toContain('not a DER public key of that type')
    const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey
    expect(issue({ logEntryKeys: [active('PKIX_ECDSA_P256_SHA_256', p384)] })).toContain('not a DER public key of that type')
    expect(issue({ logEntryKeys: [{ ...active('PKIX_ED25519_PH', ED), public: `${der(ED)}\n` }] })).not.toBeUndefined()
  })

  it('refuses lastRelease on a key that is not retired and its absence on one that is, a key listed twice, and a list with no active key it verifies', () => {
    expect(issue({ logEntryKeys: [{ ...active('PKIX_ED25519_PH', ED), lastRelease: '0.1.0' }] })).toContain('lastRelease')
    expect(issue({ logEntryKeys: [active('PKIX_ECDSA_P256_SHA_256', EC), { ...active('PKIX_ED25519_PH', ED), status: 'retired' }] })).toContain('lastRelease')
    expect(issue({ logEntryKeys: [active('PKIX_ED25519_PH', ED), active('PKIX_ED25519_PH', ED)] })).toContain('listed more than once')
    expect(issue({ logEntryKeys: [{ ...active('PKIX_ED25519_PH', ED), status: 'revoked' }] })).toContain('no log-entry key of a type this client verifies is active')
    expect(issue({ logEntryKeys: [active('PKIX_FUTURE_TYPE', EC)] })).toContain('no log-entry key of a type this client verifies is active')
    expect(issue({ logEntryKeys: [active('PKIX_ED25519_PH', ED), active('PKIX_FUTURE_TYPE', EC)] })).toBeUndefined()
    expect(issue({ logEntryKeys: [active('pkix_lower', EC), active('PKIX_ED25519_PH', ED)] })).not.toBeUndefined()
    expect(issue({ logEntryKeys: [] })).not.toBeUndefined()
  })

  it('refuses logs that leave out the root\'s log, or list one origin twice', () => {
    const log = rootFile(throwawayKeys()).metadata.log
    expect(issue({ logs: [{ origin: 'earlier.example.test', vkey: 'earlier.example.test+00000000+AQ==' }] })).toContain('does not list the root\'s log')
    expect(issue({ logs: [{ origin: log.origin, vkey: 'other+00000000+AQ==' }] })).toContain('does not list the root\'s log')
    expect(issue({ logs: [log, { origin: log.origin, vkey: 'other+00000000+AQ==' }] })).toContain('one origin more than once')
    expect(issue({ logs: [] })).not.toBeUndefined()
  })
})

describe('a rotation that adds the fields', () => {
  it('c02-log-entry-keys-unverified-root-refused: walks from root 1 to a root 2 the root key signs, and refuses one it did not', () => {
    const keys = throwawayKeys()
    const first = rootFile(keys, {}, [keys.root], true)
    const second: RootMetadata = { ...first.metadata, version: 2, logs: [first.metadata.log], logEntryKeys: [{ keyDetails: 'PKIX_ECDSA_P256_SHA_256', public: der(EC), status: 'active' }] }
    const signed = Buffer.from(JSON.stringify(signEnvelope({ signed: toJsonValue(second), signatures: [] }, [keys.root])))
    expect(walkRootChain([first.bytes, signed]).at(-1)!.metadata.logEntryKeys).toEqual(second.logEntryKeys)
    const stranger = throwawayKeys().root
    const forged = Buffer.from(JSON.stringify(signEnvelope({ signed: toJsonValue(second), signatures: [] }, [stranger])))
    expect(() => walkRootChain([first.bytes, forged])).toThrow()
  })
})

describe('draft-root', () => {
  /**
   * A draft command line over fresh throwaway keys, written as public key files.
   * @param directory - where the files go.
   * @returns the arguments and the log's verifier key.
   */
  function args(directory: string): { args: string[], logVkey: string } {
    const keys = throwawayKeys()
    const write = (name: string, key: KeyObject): string => {
      const path = join(directory, name)
      writeFileSync(path, createPublicKey(key).export({ format: 'pem', type: 'spki' }))
      return path
    }
    const logVkey = verifierKey('log2026-1.example.test', NOTE_ED25519, generateKeyPairSync('ed25519').privateKey)
    return {
      logVkey,
      args: [
        '--version', '2', '--root-key', write('root.pub.pem', keys.root), '--targets-key', write('targets.pub.pem', keys.targets), '--timestamp-key', write('timestamp.pub.pem', keys.timestamp),
        '--catalogue-key', write('catalogue.pub.pem', keys.catalogue), '--log-origin', 'log2026-1.example.test', '--log-vkey', logVkey,
        '--witness', verifierKey('witness.example.test', NOTE_COSIGNATURE, generateKeyPairSync('ed25519').privateKey),
        '--log-entry-key', `PKIX_ED25519_PH=${write('targets.pub.pem', keys.targets)}`,
      ],
    }
  }

  it('lists each --log-entry-key as an active key in the order given, and each --earlier-log after the current log', (test) => {
    const directory = scratch(test)
    const { args: base, logVkey } = args(directory)
    const ecdsa = join(directory, 'log-entry-ecdsa.pub.pem')
    writeFileSync(ecdsa, EC.export({ format: 'pem', type: 'spki' }))
    const earlier = verifierKey('log2025-1.example.test', NOTE_ED25519, generateKeyPairSync('ed25519').privateKey)
    const draft = draftRoot([...base, '--log-entry-key', `PKIX_ECDSA_P256_SHA_256=${ecdsa}`, '--earlier-log', earlier], Math.floor(Date.now() / 1000))
    expect(draft.logEntryKeys?.map(key => [key.keyDetails, key.status])).toEqual([['PKIX_ED25519_PH', 'active'], ['PKIX_ECDSA_P256_SHA_256', 'active']])
    expect(draft.logEntryKeys?.[1]?.public).toBe(der(EC))
    expect(draft.logs).toEqual([{ origin: 'log2026-1.example.test', vkey: logVkey }, { origin: 'log2025-1.example.test', vkey: earlier }])
  })

  it('refuses a private key, a key of another kind and a type it does not implement', (test) => {
    const directory = scratch(test)
    const { args: base } = args(directory)
    const now = Math.floor(Date.now() / 1000)
    const privateFile = join(directory, 'ecdsa.pem')
    writeFileSync(privateFile, generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
    expect(() => draftRoot([...base, '--log-entry-key', `PKIX_ECDSA_P256_SHA_256=${privateFile}`], now)).toThrow('holds a private key')
    const edFile = join(directory, 'ed.pub.pem')
    writeFileSync(edFile, ED.export({ format: 'pem', type: 'spki' }))
    expect(() => draftRoot([...base, '--log-entry-key', `PKIX_ECDSA_P256_SHA_256=${edFile}`], now)).toThrow('holds no PKIX_ECDSA_P256_SHA_256 public key')
    expect(() => draftRoot([...base, '--log-entry-key', `PKIX_FUTURE=${edFile}`], now)).toThrow('is not <type>=<public.pem>')
    expect(() => draftRoot([...base, '--log-entry-key', edFile], now)).toThrow('is not <type>=<public.pem>')
    const withoutEntryKey = base.slice(0, base.indexOf('--log-entry-key'))
    expect(() => draftRoot(withoutEntryKey, now)).toThrow('at least one --log-entry-key')
  })

  it('writes logs with the current log alone when no --earlier-log is given', (test) => {
    const { args: base, logVkey } = args(scratch(test))
    expect(draftRoot(base, Math.floor(Date.now() / 1000)).logs).toEqual([{ origin: 'log2026-1.example.test', vkey: logVkey }])
  })
})
