/**
 * The release workflow's logging step against local HTTP stand-ins of the log and the checkpoint distributor: it
 * waits until a listed witness has cosigned a checkpoint that covers the entry, and returns a bundle that verifies;
 * without a cosignature it gives up and the release is not published; a refusal names the log's reason.
 */
import { createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, type TestContext } from 'vitest'
import type { HashedRekordRequest } from '@delorun/contract-release-log'
import { verifyBundle } from '@delorun/release-formats/log/bundle'
import { logFirstAccepted, logRelease, REFUSAL_EXCERPT_CHARACTERS, type LogEndpoints } from '../../src/log/client.ts'
import { entryRequest, readEntryRequest } from '@delorun/release-formats/log/entry'
import { rootFile, throwawayKeys } from '../sign/fixture.ts'
import { LogStandIn, WitnessStandIn } from './standin.ts'

const MANIFEST = Buffer.from('{"signed":{"schema":"delorun.release-manifest/1"},"signatures":[]}\n')

async function serve(test: TestContext, log: LogStandIn, cosign: (checkpoint: string, poll: number) => string, tamper: (path: string, tile: Buffer | undefined) => Buffer | undefined = (_, tile) => tile, refuse: (request: HashedRekordRequest) => { status: number, body: string } | undefined = () => undefined, submitted: string[] = []): Promise<LogEndpoints> {
  let polls = 0
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://stand-in')
      if (url.pathname === '/api/v2/log/entries') {
        const submittedRequest = readEntryRequest(Buffer.concat(chunks))
        submitted.push(submittedRequest.hashedRekordRequestV002.signature.verifier.keyDetails)
        const refusal = refuse(submittedRequest)
        if (refusal !== undefined) {
          response.writeHead(refusal.status, { 'content-type': 'application/json' })
          response.end(refusal.body)
          return
        }
        const logIndex = log.submit(submittedRequest)
        // A TransparencyLogEntry in protobuf JSON: int64 values are strings, and a zero one is omitted.
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ...(logIndex === 0 ? {} : { logIndex: String(logIndex) }), kindVersion: { kind: 'hashedrekord', version: '0.0.2' }, canonicalizedBody: log.body(logIndex).toString('base64') }))
      } else if (url.pathname === '/checkpoint') {
        polls++
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        response.end(cosign(log.checkpoint(), polls))
      } else {
        const tile = url.pathname.startsWith('/tiles/') ? tamper(url.pathname.slice('/tiles/'.length), log.tile(url.pathname.slice('/tiles/'.length))) : undefined
        response.writeHead(tile === undefined ? 404 : 200, { 'content-type': 'application/octet-stream' })
        response.end(tile)
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  test.onTestFinished(() => new Promise<void>(resolve => server.close(() => resolve())))
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  return { submit: `${origin}/api/v2/log/entries`, checkpoint: `${origin}/checkpoint`, tiles: `${origin}/tiles/` }
}

function setup(): { keys: ReturnType<typeof throwawayKeys>, log: LogStandIn, witness: WitnessStandIn, root: ReturnType<typeof rootFile>['metadata'], entry: HashedRekordRequest } {
  const keys = throwawayKeys()
  const log = new LogStandIn()
  const witness = new WitnessStandIn()
  const root = rootFile(keys, { log: { origin: log.origin, vkey: log.vkey }, witnesses: { keys: [{ name: witness.name, vkey: witness.vkey }], threshold: 1 } }).metadata
  const entry = entryRequest(MANIFEST, keys.targets)
  return { keys, log, witness, root, entry }
}

describe('logRelease', () => {
  it('waits for a cosigned checkpoint covering the entry and returns a bundle that verifies', async (test) => {
    const { log, witness, root, entry } = setup()
    const endpoints = await serve(test, log, (checkpoint, poll) => (poll < 3 ? checkpoint : witness.cosign(checkpoint, 1_793_981_760)))
    let waits = 0
    const bundle = await logRelease(endpoints, root, 'delorun-0.1.0.manifest.json', MANIFEST, '0.1.0', entry, 5, async () => { waits++ })
    expect(waits).toBe(2)
    expect(bundle.entry).toMatchObject({ logIndex: 0, integratedTime: 0 })
    expect(verifyBundle(root, MANIFEST, '0.1.0', bundle).cosigned).toBe(1_793_981_760)
  })

  it('reads the log index as a protobuf JSON string and computes the proof from full and partial tiles', async (test) => {
    const { log, witness, root, entry } = setup()
    log.grow(300)
    const endpoints = await serve(test, log, checkpoint => witness.cosign(checkpoint, 1_793_981_760))
    const bundle = await logRelease(endpoints, root, 'delorun-0.1.0.manifest.json', MANIFEST, '0.1.0', entry, 1, async () => {})
    expect(bundle.entry.logIndex).toBe(300)
    expect(verifyBundle(root, MANIFEST, '0.1.0', bundle).treeSize).toBe(301)
    expect(log.tileRequests).toEqual(['tile/0/001.p/45', 'tile/1/000.p/1'])
  })

  it('refuses a bundle whose proof a tampered tile changed', async (test) => {
    const { log, witness, root, entry } = setup()
    log.grow(300)
    const endpoints = await serve(test, log, checkpoint => witness.cosign(checkpoint, 1_793_981_760), (path, tile) => (path === 'tile/1/000.p/1' && tile !== undefined ? Buffer.alloc(32) : tile))
    await expect(logRelease(endpoints, root, 'delorun-0.1.0.manifest.json', MANIFEST, '0.1.0', entry, 1, async () => {})).rejects.toThrow(/inclusion proof does not reproduce/u)
  })

  it('gives up without publishing when no listed witness cosigns', async (test) => {
    const { log, root, entry } = setup()
    const stranger = new WitnessStandIn()
    const endpoints = await serve(test, log, checkpoint => stranger.cosign(checkpoint, 1_793_981_760))
    await expect(logRelease(endpoints, root, 'delorun-0.1.0.manifest.json', MANIFEST, '0.1.0', entry, 3, async () => {})).rejects.toThrow(/after 3 attempts; the release is not published/u)
  })
})

describe('logging pre-signed entry requests in the root\'s order, as log-release does', () => {
  const ECDSA = 'PKIX_ECDSA_P256_SHA_256'
  const TYPE_REFUSAL = { status: 400, body: JSON.stringify({ code: 3, message: 'invalid hashedrekord request', details: [] }) }
  const listed = (keyDetails: string, key: KeyObject): { keyDetails: string, public: string, status: 'active' } => ({ keyDetails, public: createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64'), status: 'active' })

  /**
   * A root listing an ECDSA P-256 key first and the targets key as Ed25519ph second, with both requests signed.
   * @returns the setup and the two requests, in the root's order.
   */
  function ordered(): ReturnType<typeof setup> & { entries: HashedRekordRequest[] } {
    const keys = throwawayKeys()
    const ecdsa = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
    const log = new LogStandIn()
    const witness = new WitnessStandIn()
    const root = rootFile(keys, { log: { origin: log.origin, vkey: log.vkey }, witnesses: { keys: [{ name: witness.name, vkey: witness.vkey }], threshold: 1 }, logEntryKeys: [listed(ECDSA, ecdsa), listed('PKIX_ED25519_PH', keys.targets)] }).metadata
    const entries = [entryRequest(MANIFEST, ecdsa, ECDSA), entryRequest(MANIFEST, keys.targets, 'PKIX_ED25519_PH')]
    return { keys, log, witness, root, entry: entries[0]!, entries }
  }

  it('log-release-fallback-on-type-refusal: submits the next request only after the log refuses the first one\'s key type, and its bundle verifies', async (test) => {
    const { log, witness, root, entries } = ordered()
    const submitted: string[] = []
    const endpoints = await serve(test, log, checkpoint => witness.cosign(checkpoint, 1_793_981_760), undefined, request => (request.hashedRekordRequestV002.signature.verifier.keyDetails === ECDSA ? TYPE_REFUSAL : undefined), submitted)
    const warnings: string[] = []
    const logged = await logFirstAccepted(endpoints, root, 'delorun-0.1.0.manifest.json', MANIFEST, '0.1.0', entries, 1, async () => {}, 'manifest', line => warnings.push(line))
    expect(submitted).toEqual([ECDSA, 'PKIX_ED25519_PH'])
    expect(logged.signer).toBe(1)
    expect(warnings).toEqual([expect.stringContaining(`refused the ${ECDSA} entry of delorun-0.1.0.manifest.json`)])
    expect(verifyBundle(root, MANIFEST, '0.1.0', logged.bundle).treeSize).toBe(1)
  })

  it('log-release-only-on-type-refusal: stops at a 400 with another body, or a 500, and submits no later request', async (test) => {
    for (const answer of [{ status: 400, body: JSON.stringify({ code: 3, message: 'invalid argument' }) }, { status: 500, body: TYPE_REFUSAL.body }]) {
      const { log, witness, root, entries } = ordered()
      const submitted: string[] = []
      const endpoints = await serve(test, log, checkpoint => witness.cosign(checkpoint, 1_793_981_760), undefined, () => answer, submitted)
      await expect(logFirstAccepted(endpoints, root, 'delorun-0.1.0.manifest.json', MANIFEST, '0.1.0', entries, 1, async () => {}, 'manifest', () => undefined)).rejects.toThrow(`answered HTTP ${String(answer.status)}`)
      expect(submitted).toEqual([ECDSA])
    }
  })

  it('log-release-refuses-other-digest: submits no request that does not verify under the root: one for another file\'s digest, or by a key the root does not list', async (test) => {
    const { keys, log, witness, root } = ordered()
    const submitted: string[] = []
    const endpoints = await serve(test, log, checkpoint => witness.cosign(checkpoint, 1_793_981_760), undefined, () => undefined, submitted)
    const otherFile = entryRequest(Buffer.from('another manifest'), keys.targets, 'PKIX_ED25519_PH')
    await expect(logFirstAccepted(endpoints, root, 'delorun-0.1.0.manifest.json', MANIFEST, '0.1.0', [otherFile], 1, async () => {}, 'manifest', () => undefined)).rejects.toThrow(/does not verify under root 1, so it was not submitted: .*digest/u)
    await expect(logFirstAccepted(endpoints, root, 'delorun-0.1.0.packs.json', MANIFEST, '0.1.0', [otherFile], 1, async () => {}, 'packs', () => undefined)).rejects.toThrow('does not verify under root 1, so it was not submitted')
    const unlisted = entryRequest(MANIFEST, generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey, ECDSA)
    await expect(logFirstAccepted(endpoints, root, 'delorun-0.1.0.manifest.json', MANIFEST, '0.1.0', [unlisted], 1, async () => {}, 'manifest', () => undefined)).rejects.toThrow('does not verify under root 1, so it was not submitted')
    expect(submitted).toEqual([])
  })
})

async function refusing(test: TestContext, status: number, body: string | Buffer): Promise<LogEndpoints> {
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(body)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  test.onTestFinished(() => new Promise<void>(resolve => server.close(() => resolve())))
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  return { submit: `${origin}/api/v2/log/entries`, checkpoint: `${origin}/checkpoint`, tiles: `${origin}/tiles/` }
}

async function refusalOf(endpoints: LogEndpoints): Promise<string> {
  const { root, entry } = setup()
  const error: unknown = await logRelease(endpoints, root, 'delorun-0.1.0.manifest.json', MANIFEST, '0.1.0', entry, 1, async () => {}).then(() => undefined, (failure: unknown) => failure)
  if (!(error instanceof Error)) throw new Error('the log refused the entry, yet logRelease did not fail')
  return error.message
}

describe('logRelease when the log refuses the entry', () => {
  it('names the status and the reason the log gives in its body', async (test) => {
    const endpoints = await refusing(test, 400, '{"code":3,"message":"invalid hashedrekord request","details":[]}')
    expect(await refusalOf(endpoints)).toBe(`${endpoints.submit} answered HTTP 400: {"code":3,"message":"invalid hashedrekord request","details":[]}`)
  })

  it('quotes at most the first 500 characters, with control and format characters shown as spaces', async (test) => {
    const endpoints = await refusing(test, 400, `\u001B[31mrefused\r\n\u202Eby\u0007the log ${'x'.repeat(10_000)}`)
    const message = await refusalOf(endpoints)
    const excerpt = message.slice(`${endpoints.submit} answered HTTP 400: `.length)
    expect(excerpt.startsWith('[31mrefused by the log x')).toBe(true)
    expect([...excerpt]).toHaveLength(REFUSAL_EXCERPT_CHARACTERS)
    expect(message).not.toMatch(/[\p{Cc}\p{Cf}]/u)
  })

  it('ends at the status when the body is empty', async (test) => {
    const endpoints = await refusing(test, 503, '')
    expect(await refusalOf(endpoints)).toBe(`${endpoints.submit} answered HTTP 503`)
  })
})
