/**
 * The pre-cut log probe: one throwaway entry over random bytes per entry key type the root lists, each signed by a key
 * made for the probe, and a report of which types the log accepts. The log is a local stand-in fetch, so nothing here
 * reaches a network.
 */
import { generateKeyPairSync } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { HashedRekordRequest } from '@delorun/contract-release-log'
import type { LogEntryKey } from '@delorun/contract-release-manifest'
import { verifyEntryBody } from '@delorun/release-formats/log/bundle'
import { entryBody } from '@delorun/release-formats/log/entry'
import { main, probedTypes, probeLog, type ProbeFetch } from '../../scripts/probe-log.ts'
import { rootFile, throwawayKeys } from '../sign/fixture.ts'
import { scratch } from '../support.ts'

/**
 * A log stand-in fetch that accepts the given key details and records each request.
 * @param accepts - the accepted key details.
 * @returns the fetch and the requests it saw.
 */
function standIn(accepts: readonly string[]): { fetch: ProbeFetch, seen: HashedRekordRequest[] } {
  const seen: HashedRekordRequest[] = []
  const fetch: ProbeFetch = async (_url, init) => {
    const request = JSON.parse(String(init.body)) as HashedRekordRequest
    seen.push(request)
    return accepts.includes(request.hashedRekordRequestV002.signature.verifier.keyDetails)
      ? new Response('{"logIndex":"7"}', { status: 201 })
      : new Response('{"code":3,"message":"invalid hashedrekord request","details":[]}\n', { status: 400 })
  }
  return { fetch, seen }
}

/**
 * A log-entry key as a root lists it.
 * @param keyDetails - the entry key type.
 * @param status - its status.
 * @returns the entry over a fresh key of the type's kind.
 */
function listed(keyDetails: 'PKIX_ED25519_PH' | 'PKIX_ECDSA_P256_SHA_256', status: LogEntryKey['status'] = 'active'): LogEntryKey {
  const key = keyDetails === 'PKIX_ED25519_PH' ? generateKeyPairSync('ed25519').publicKey : generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey
  return { keyDetails, public: key.export({ format: 'der', type: 'spki' }).toString('base64'), status }
}

describe('the probed types', () => {
  it('are none under a root without logEntryKeys, and each active implemented listed type once, in the root\'s order', () => {
    expect(probedTypes({})).toEqual([])
    expect(probedTypes({ logEntryKeys: [listed('PKIX_ECDSA_P256_SHA_256'), listed('PKIX_ED25519_PH'), listed('PKIX_ECDSA_P256_SHA_256'), listed('PKIX_ED25519_PH', 'revoked')] })).toEqual(['PKIX_ECDSA_P256_SHA_256', 'PKIX_ED25519_PH'])
    expect(probedTypes({ logEntryKeys: [listed('PKIX_ED25519_PH', 'retired'), { ...listed('PKIX_ED25519_PH'), keyDetails: 'PKIX_FUTURE' }] })).toEqual([])
  })
})

describe('probing a log', () => {
  it('sends one valid entry over random bytes per type, each by a key made for it, and reports the answers', async () => {
    const { fetch, seen } = standIn(['PKIX_ECDSA_P256_SHA_256'])
    const results = await probeLog(['PKIX_ED25519_PH', 'PKIX_ECDSA_P256_SHA_256'], 'https://log.example.test/api/v2/log/entries', fetch)
    expect(results).toEqual([
      { keyDetails: 'PKIX_ED25519_PH', accepted: false, answer: 'HTTP 400 {"code":3,"message":"invalid hashedrekord request","details":[]}' },
      { keyDetails: 'PKIX_ECDSA_P256_SHA_256', accepted: true, answer: 'HTTP 201' },
    ])
    expect(seen.map(request => request.hashedRekordRequestV002.signature.verifier.keyDetails)).toEqual(['PKIX_ED25519_PH', 'PKIX_ECDSA_P256_SHA_256'])
    // The probes are signed by keys of their own, never a release key, over different random bytes.
    expect(seen[0]!.hashedRekordRequestV002.digest).not.toEqual(seen[1]!.hashedRekordRequestV002.digest)
    const again = standIn([])
    await probeLog(['PKIX_ED25519_PH'], 'https://log.example.test/api/v2/log/entries', again.fetch)
    expect(again.seen[0]!.hashedRekordRequestV002.signature.verifier.publicKey).not.toEqual(seen[0]!.hashedRekordRequestV002.signature.verifier.publicKey)
  })

  it('reports a log it cannot reach as refusing, with the reason', async () => {
    const results = await probeLog(['PKIX_ED25519_PH'], 'https://log.example.test/api/v2/log/entries', () => Promise.reject(new TypeError('fetch failed')))
    expect(results).toEqual([{ keyDetails: 'PKIX_ED25519_PH', accepted: false, answer: 'no answer: fetch failed' }])
  })
})

describe('the probe command', () => {
  it('exits 0 when the log accepts a listed type, 1 when it accepts none, and 2 without a root that verifies', async (test) => {
    const directory = scratch(test)
    const keys = throwawayKeys()
    const ecdsa = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey
    const root = rootFile(keys, { logEntryKeys: [listed('PKIX_ED25519_PH'), { keyDetails: 'PKIX_ECDSA_P256_SHA_256', public: ecdsa.export({ format: 'der', type: 'spki' }).toString('base64'), status: 'active' }] })
    const path = join(directory, '2.root.json')
    writeFileSync(path, root.bytes)
    const lines: string[] = []
    expect(await main(['--root', path, '--log-submit', 'https://log.example.test/api/v2/log/entries'], standIn(['PKIX_ECDSA_P256_SHA_256']).fetch, line => lines.push(line))).toBe(0)
    expect(lines).toEqual([
      expect.stringMatching(/^probe-log: PKIX_ED25519_PH refused \(HTTP 400 /u),
      'probe-log: PKIX_ECDSA_P256_SHA_256 accepted (HTTP 201)',
      'probe-log: https://log.example.test/api/v2/log/entries accepts PKIX_ECDSA_P256_SHA_256',
    ])
    expect(await main(['--root', path, '--log-submit', 'https://log.example.test/api/v2/log/entries'], standIn([]).fetch, () => undefined)).toBe(1)
    const forged = join(directory, 'forged.root.json')
    writeFileSync(forged, rootFile(keys, {}, [throwawayKeys().root]).bytes)
    expect(await main(['--root', forged, '--log-submit', 'https://log.example.test/api/v2/log/entries'], standIn(['PKIX_ED25519_PH']).fetch, () => undefined)).toBe(2)
    expect(await main(['--root', path], standIn([]).fetch, () => undefined)).toBe(2)
    const bare = join(directory, '1.root.json')
    writeFileSync(bare, rootFile(keys, {}, [keys.root], true).bytes)
    const said: string[] = []
    expect(await main(['--root', bare, '--log-submit', 'https://log.example.test/api/v2/log/entries'], standIn(['PKIX_ED25519_PH']).fetch, line => said.push(line))).toBe(2)
    expect(said).toEqual(['probe-log: root 1 lists no active log-entry key of a type this tool implements, so no release can be logged under it'])
  })

  it('sends entries a root listing their throwaway keys would verify, so a refusal is the log\'s and not a malformed request', async () => {
    const { fetch, seen } = standIn([])
    await probeLog(['PKIX_ED25519_PH', 'PKIX_ECDSA_P256_SHA_256'], 'https://log.example.test/api/v2/log/entries', fetch)
    const keys = throwawayKeys()
    for (const request of seen) {
      const { signature } = request.hashedRekordRequestV002
      const root = rootFile(keys, { logEntryKeys: [{ keyDetails: signature.verifier.keyDetails, public: signature.verifier.publicKey.rawBytes, status: 'active' }] }).metadata
      // The probed bytes are unknown here, so the digest check refuses; the key and type checks before it pass.
      expect(() => verifyEntryBody(root, Buffer.from('not the probed bytes'), '0.1.0', entryBody(request))).toThrow(/digest/u)
    }
  })
})
