/**
 * The signing tool's choice of log-entry key (contract C18): it signs with the root's listed keys in order and moves to
 * the next only when the log refuses the entry's key type with one of the two refusal answers, after its own request
 * verified locally. Any other answer stops it, and a log that accepts an entry still has to give a bundle that verifies
 * under the root. Every log here is a local stand-in and every key a throwaway one.
 */
import { createPublicKey, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { LogEntryKey, RootMetadata } from '@delorun/contract-release-manifest'
import { entryBody, entryRequest } from '@delorun/release-formats/log/entry'
import { checkBundle } from '@delorun/release-verify/bundle'
import { buildLocalRelease, releaseDirectory, type LocalReleaseRequest } from '../../src/local/release.ts'
import { isEntryTypeRefusal, LogSubmitError, logWithFallback } from '../../src/log/client.ts'
import { readProductionKeysFile, PRODUCTION_KEYS_PATH } from '../../src/local/production-keys.ts'
import { rootFile, throwawayKeys } from '../sign/fixture.ts'
import { fixtureClosure, serveLog, type ServeLogOptions, type Trust } from '../local/support.ts'
import { LogStandIn, WitnessStandIn } from './standin.ts'
import { REPO, scratch } from '../support.ts'

const ECDSA_TYPE = 'PKIX_ECDSA_P256_SHA_256'

/**
 * A log-entry key as a root lists it.
 * @param keyDetails - the entry key type.
 * @param key - the key.
 * @returns the entry.
 */
function listed(keyDetails: string, key: KeyObject): LogEntryKey {
  return { keyDetails, public: createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64'), status: 'active' }
}

/**
 * Throwaway keys, a stand-in log and witness, and a root that lists the given log-entry keys and the log.
 * @param entryKeys - the root's `logEntryKeys` over the targets key and an ECDSA key; `bare` for a root without either
 *   field, as `1.root.json` is.
 * @returns the trust and the ECDSA key.
 */
function trustWith(entryKeys: ((targets: KeyObject, ecdsa: KeyObject) => readonly LogEntryKey[]) | 'bare'): { trusted: Trust, ecdsa: KeyObject, root: RootMetadata } {
  const keys = throwawayKeys()
  const ecdsa = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
  const log = new LogStandIn()
  const witness = new WitnessStandIn()
  const fields = { log: { origin: log.origin, vkey: log.vkey }, witnesses: { keys: [{ name: witness.name, vkey: witness.vkey }], threshold: 1 } }
  const file = entryKeys === 'bare' ? rootFile(keys, fields, [keys.root], true) : rootFile(keys, { ...fields, logEntryKeys: entryKeys(keys.targets, ecdsa) })
  return { trusted: { keys, log, witness, root: file.bytes }, ecdsa, root: file.metadata }
}

/** Both types as the production root lists them: ECDSA P-256 first, Ed25519ph by the targets key the alternative. */
const BOTH = (targets: KeyObject, ecdsa: KeyObject): readonly LogEntryKey[] => [listed(ECDSA_TYPE, ecdsa), listed('PKIX_ED25519_PH', targets)]

/**
 * A local release request against a served stand-in log.
 * @param test - the running test.
 * @param trusted - the keys, log and root.
 * @param ecdsa - the ECDSA log-entry key the signer holds.
 * @param options - how the served log answers.
 * @returns the request, its channel and the warnings it reported.
 */
async function request(test: Parameters<typeof scratch>[0], trusted: Trust, ecdsa: KeyObject, options: ServeLogOptions = {}): Promise<{ request: LocalReleaseRequest, channel: string, warnings: string[] }> {
  const directory = scratch(test)
  const log = await serveLog(test, trusted, options)
  const warnings: string[] = []
  const channel = join(directory, 'channel')
  return {
    channel,
    warnings,
    request: {
      commit: 'a'.repeat(40),
      version: '0.1.0',
      dsh: '0.2.2-rc.1',
      security: false,
      summary: 'A local fixture release.',
      channel,
      roots: [trusted.root],
      targetsKey: trusted.keys.targets,
      timestampKey: trusted.keys.timestamp,
      logEntryKeys: [{ keyDetails: ECDSA_TYPE, key: ecdsa }],
      productionKeys: readProductionKeysFile(join(REPO, PRODUCTION_KEYS_PATH)),
      platforms: ['linux-x64'],
      state: join(directory, 'state.json'),
      log: log.endpoints,
      logAttempts: 1,
      logWait: () => Promise.resolve(),
      closures: fixtureClosure(test, '0.1.0'),
      builder: { home: '/home/no-such-builder', username: 'no-such-builder' },
      warn: line => warnings.push(line),
      now: new Date(),
    },
  }
}

describe('a log that refuses the first listed type', () => {
  it('log-fallback-on-type-refusal: signs the entry with the next listed key, and the bundle verifies under the root', async (test) => {
    const { trusted, ecdsa, root } = trustWith(BOTH)
    trusted.log.accepts.delete(ECDSA_TYPE)
    const { request: built, channel, warnings } = await request(test, trusted, ecdsa)
    await buildLocalRelease(built)
    expect(trusted.log.submitted.slice(0, 2)).toEqual([ECDSA_TYPE, 'PKIX_ED25519_PH'])
    expect(warnings[0]).toContain(`refused the ${ECDSA_TYPE} entry of delorun-0.1.0.manifest.json`)
    const release = releaseDirectory(channel, '0.1.0')
    const entry = JSON.parse(readFileSync(join(release, 'delorun-0.1.0.manifest.entry.json'), 'utf8')) as { hashedRekordRequestV002: { signature: { verifier: { keyDetails: string } } } }
    expect(entry.hashedRekordRequestV002.signature.verifier.keyDetails).toBe('PKIX_ED25519_PH')
    const verdict = checkBundle(root, '0.1.0', readFileSync(join(release, 'delorun-0.1.0.manifest.json')), readFileSync(join(release, 'delorun-0.1.0.manifest.log.json')))
    expect(verdict.ok).toBe(true)
  })

  it('logs with the first listed type when the log accepts it, and tries no other', async (test) => {
    const { trusted, ecdsa } = trustWith(BOTH)
    const { request: built } = await request(test, trusted, ecdsa)
    await buildLocalRelease(built)
    expect(new Set(trusted.log.submitted)).toEqual(new Set([ECDSA_TYPE]))
  })
})

describe('an answer that is not a type refusal', () => {
  it.for([
    ['a 400 with another message', 400, JSON.stringify({ code: 3, message: 'invalid argument', details: [] })],
    ['a 400 whose message only contains the refusal', 400, JSON.stringify({ code: 3, message: 'invalid hashedrekord request: signature', details: [] })],
    ['a 400 that is not JSON', 400, 'invalid hashedrekord request'],
    ['a 500 with the refusal message', 500, JSON.stringify({ code: 13, message: 'invalid hashedrekord request' })],
    ['a 503', 503, 'unavailable'],
    ['a 409', 409, JSON.stringify({ code: 6, message: 'entry already exists' })],
  ] as const)('log-fallback-only-on-type-refusal: stops at %s, with no other key tried and the channel unchanged', async ([, status, body], test) => {
    const { trusted, ecdsa } = trustWith(BOTH)
    const { request: built, channel } = await request(test, trusted, ecdsa, { answer: details => details === ECDSA_TYPE ? { status, body } : undefined })
    await expect(buildLocalRelease(built)).rejects.toThrow(`answered HTTP ${String(status)}`)
    expect(trusted.log.submitted).toEqual([ECDSA_TYPE])
    expect(existsSync(join(channel, 'timestamp.json'))).toBe(false)
  })

  it('reads only the two exact refusal messages at status 400 as a type refusal', () => {
    const refusal = (status: number, body: string): boolean => isEntryTypeRefusal(new LogSubmitError('https://log.example.test', status, body))
    expect(refusal(400, '{"code":3,"message":"invalid hashedrekord request","details":[]}')).toBe(true)
    expect(refusal(400, '{"code":400,"message":"entry algorithms are not allowed"}')).toBe(true)
    expect(refusal(400, '{"message":"Invalid hashedrekord request"}')).toBe(false)
    expect(refusal(400, '{"message":["invalid hashedrekord request"]}')).toBe(false)
    expect(refusal(400, 'null')).toBe(false)
    expect(refusal(401, '{"message":"invalid hashedrekord request"}')).toBe(false)
    expect(isEntryTypeRefusal(new Error('invalid hashedrekord request'))).toBe(false)
  })
})

describe('a log that accepts the fallback entry', () => {
  it('log-fallback-verifies-success: refuses a success whose entry is not ours, so the log accepting it proves nothing', async (test) => {
    const { trusted, ecdsa } = trustWith(BOTH)
    const answer: ServeLogOptions['answer'] = (details) => {
      if (details === ECDSA_TYPE) return { status: 400, body: JSON.stringify({ code: 3, message: 'invalid hashedrekord request', details: [] }) }
      const body = entryBody(entryRequest(randomBytes(64), trusted.keys.targets, 'PKIX_ED25519_PH'))
      const logIndex = trusted.log.append(body)
      return { status: 201, body: JSON.stringify({ logIndex: String(logIndex), canonicalizedBody: body.toString('base64') }) }
    }
    const { request: built, channel } = await request(test, trusted, ecdsa, { answer })
    await expect(buildLocalRelease(built)).rejects.toThrow(/manifest/u)
    expect(trusted.log.submitted).toEqual([ECDSA_TYPE, 'PKIX_ED25519_PH'])
    expect(existsSync(join(channel, 'timestamp.json'))).toBe(false)
  })
})

describe('the signers a root allows', () => {
  it('refuses before building anything under a root without logEntryKeys, as 1.root.json is', async (test) => {
    const { trusted, ecdsa } = trustWith('bare')
    const { request: built, channel } = await request(test, trusted, ecdsa)
    await expect(buildLocalRelease(built)).rejects.toThrow('root 1 lists no logEntryKeys, so no log entry of this release could verify')
    expect(trusted.log.submitted).toEqual([])
    expect(existsSync(join(channel, 'timestamp.json'))).toBe(false)
  })

  it('refuses before building anything when no held key is an active log-entry key of the root', async (test) => {
    const { trusted } = trustWith((_targets, ecdsa) => [listed(ECDSA_TYPE, ecdsa)])
    const unlisted = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
    const { request: built, channel } = await request(test, trusted, unlisted)
    await expect(buildLocalRelease(built)).rejects.toThrow('root 1 lists neither a --log-entry-key nor the targets key as an active log-entry key')
    expect(trusted.log.submitted).toEqual([])
    expect(existsSync(join(channel, 'timestamp.json'))).toBe(false)
  })

  it('submits nothing for a request that does not verify under the root', async () => {
    const { root } = trustWith((targets) => [listed('PKIX_ED25519_PH', targets)])
    const unlisted = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
    const never = (): Promise<void> => Promise.reject(new Error('no wait'))
    await expect(logWithFallback({ submit: 'http://127.0.0.1:9/never', checkpoint: 'http://127.0.0.1:9/never', tiles: 'http://127.0.0.1:9/never' }, root, 'delorun-0.1.0.manifest.json', Buffer.from('manifest'), '0.1.0', [{ keyDetails: ECDSA_TYPE, key: unlisted }], 1, never, 'manifest', () => undefined))
      .rejects.toThrow('does not verify under root 1, so it was not submitted')
  })
})
