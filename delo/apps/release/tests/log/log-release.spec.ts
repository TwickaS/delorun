/**
 * The release workflow's logging step against local HTTP stand-ins of the log and the checkpoint distributor: it
 * waits until a listed witness has cosigned a checkpoint that covers the entry, and returns a bundle that verifies;
 * without a cosignature it gives up and the release is not published.
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, type TestContext } from 'vitest'
import { sha256Hex } from '../../src/brands.ts'
import type { HashedRekordRequest } from '@delo/contract-release-log'
import { verifyBundle } from '../../src/log/bundle.ts'
import { logRelease, type LogEndpoints } from '../../src/log/client.ts'
import { entryRequest, readEntryRequest } from '../../src/log/entry.ts'
import { rootFile, throwawayKeys } from '../sign/fixture.ts'
import { LogStandIn, WitnessStandIn } from './standin.ts'

const MANIFEST = Buffer.from('{"signed":{"schema":"delo.release-manifest/1"},"signatures":[]}\n')

async function serve(test: TestContext, log: LogStandIn, cosign: (checkpoint: string, poll: number) => string): Promise<LogEndpoints> {
  let polls = 0
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://stand-in')
      let body: unknown
      if (url.pathname === '/entries') {
        const logIndex = log.submit(readEntryRequest(Buffer.concat(chunks)))
        // A TransparencyLogEntry in protobuf JSON: int64 values are strings, and a zero one is omitted.
        body = { ...(logIndex === 0 ? {} : { logIndex: String(logIndex) }), kindVersion: { kind: 'hashedrekord', version: '0.0.2' }, canonicalizedBody: log.body(logIndex).toString('base64') }
      } else if (url.pathname === '/checkpoint') {
        polls++
        body = cosign(log.checkpoint(), polls)
      } else {
        const index = Number(url.searchParams.get('index'))
        const bundle = log.bundle(index, { name: 'x', sha256: sha256Hex('0'.repeat(64)) }, '')
        body = { hashes: bundle.inclusion.hashes, rootHash: bundle.inclusion.rootHash }
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  test.onTestFinished(() => new Promise<void>(resolve => server.close(() => resolve())))
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  return { submit: `${origin}/entries`, checkpoint: `${origin}/checkpoint`, proof: `${origin}/proof?index={index}&size={size}` }
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

  it('reads the log index the log answers as a protobuf JSON string', async (test) => {
    const { log, witness, root, entry } = setup()
    log.append(Buffer.from('an earlier entry'))
    log.append(Buffer.from('another earlier entry'))
    const endpoints = await serve(test, log, checkpoint => witness.cosign(checkpoint, 1_793_981_760))
    const bundle = await logRelease(endpoints, root, 'delorun-0.1.0.manifest.json', MANIFEST, '0.1.0', entry, 1, async () => {})
    expect(bundle.entry.logIndex).toBe(2)
    expect(verifyBundle(root, MANIFEST, '0.1.0', bundle).treeSize).toBe(3)
  })

  it('gives up without publishing when no listed witness cosigns', async (test) => {
    const { log, root, entry } = setup()
    const stranger = new WitnessStandIn()
    const endpoints = await serve(test, log, checkpoint => stranger.cosign(checkpoint, 1_793_981_760))
    await expect(logRelease(endpoints, root, 'delorun-0.1.0.manifest.json', MANIFEST, '0.1.0', entry, 3, async () => {})).rejects.toThrow(/after 3 attempts; the release is not published/u)
  })
})
