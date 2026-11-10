/**
 * The release workflow's logging step against local HTTP stand-ins of the log and the checkpoint distributor: it
 * waits until a listed witness has cosigned a checkpoint that covers the entry, and returns a bundle that verifies;
 * without a cosignature it gives up and the release is not published.
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, type TestContext } from 'vitest'
import type { HashedRekordRequest } from '@delo/contract-release-log'
import { verifyBundle } from '@delo/release-formats/log/bundle'
import { logRelease, type LogEndpoints } from '../../src/log/client.ts'
import { entryRequest, readEntryRequest } from '@delo/release-formats/log/entry'
import { rootFile, throwawayKeys } from '../sign/fixture.ts'
import { LogStandIn, WitnessStandIn } from './standin.ts'

const MANIFEST = Buffer.from('{"signed":{"schema":"delo.release-manifest/1"},"signatures":[]}\n')

async function serve(test: TestContext, log: LogStandIn, cosign: (checkpoint: string, poll: number) => string, tamper: (path: string, tile: Buffer | undefined) => Buffer | undefined = (_, tile) => tile): Promise<LogEndpoints> {
  let polls = 0
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://stand-in')
      if (url.pathname === '/api/v2/log/entries') {
        const logIndex = log.submit(readEntryRequest(Buffer.concat(chunks)))
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
