/**
 * The local RC channel: the static server serves a channel directory on loopback and nothing outside it, and the
 * re-signing job writes a timestamp the client's verifier accepts, newer than the last, from the signer's state.
 */
import { request } from 'node:http'
import { readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readEnvelope } from '@delorun/release-formats/sign/schemas'
import { trustRootChain, verifyTimestamp } from '@delorun/release-formats/sign/verify'
import { buildLocalRelease, type LocalReleaseRequest } from '../../src/local/release.ts'
import { PRODUCTION_KEYS_PATH, readProductionKeysFile } from '../../src/local/production-keys.ts'
import { channelFile, resignChannel, serveChannel } from '../../scripts/local-channel.ts'
import { REPO, scratch } from '../support.ts'
import { fixtureClosure, serveLog, trust, type Trust } from './support.ts'

/** A local release of `version` into `directory/channel`, with the signer state in `directory/state.json`. */
async function release(test: Parameters<typeof scratch>[0], directory: string, trusted: Trust, version: string, now = new Date()): Promise<void> {
  const log = await serveLog(test, trusted)
  const built: LocalReleaseRequest = {
    commit: 'a'.repeat(40),
    version,
    dsh: '0.2.2-rc.1',
    security: false,
    summary: 'A local fixture release.',
    channel: join(directory, 'channel'),
    roots: [trusted.root],
    targetsKey: trusted.keys.targets,
    timestampKey: trusted.keys.timestamp,
    productionKeys: readProductionKeysFile(join(REPO, PRODUCTION_KEYS_PATH)),
    platforms: ['linux-x64'],
    state: join(directory, 'state.json'),
    log: log.endpoints,
    logAttempts: 1,
    logWait: () => Promise.resolve(),
    closures: fixtureClosure(test, version),
    // The fixture closure names this process's Node, which may lie under the real user's home.
    allowBuilderPaths: true,
    now,
  }
  await buildLocalRelease(built)
}

/** One raw GET, so the client does not normalise the path. */
function get(port: number, path: string, method = 'GET'): Promise<{ status: number, headers: Record<string, string | string[] | undefined>, body: string }> {
  return new Promise((done, failed) => {
    const outgoing = request({ host: '127.0.0.1', port, path, method }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => done({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString() }))
    })
    outgoing.on('error', failed)
    outgoing.end()
  })
}

async function serve(test: Parameters<typeof scratch>[0], channel: string): Promise<{ port: number, lines: string[] }> {
  const lines: string[] = []
  const { server, port } = await serveChannel({ channel, port: 0, host: '127.0.0.1', log: line => lines.push(line) })
  test.onTestFinished(() => new Promise<void>(done => server.close(() => done())))
  return { port, lines }
}

describe('the local channel server', () => {
  it('serves a channel file with its content type, and the timestamp uncached', async (test) => {
    const directory = scratch(test)
    await release(test, directory, trust(), '0.1.0')
    const { port } = await serve(test, join(directory, 'channel'))
    const timestamp = await get(port, '/timestamp.json')
    expect(timestamp.status).toBe(200)
    expect(timestamp.headers['content-type']).toBe('application/json')
    expect(timestamp.headers['cache-control']).toBe('no-store')
    expect(timestamp.body).toBe(readFileSync(join(directory, 'channel', 'timestamp.json'), 'utf8'))
    const archive = await get(port, '/releases/download/v0.1.0/delorun-0.1.0-linux-x64.tar.gz', 'HEAD')
    expect(archive.status).toBe(200)
    expect(archive.headers['content-type']).toBe('application/gzip')
    expect(archive.headers['cache-control']).toBeUndefined()
  })

  it('refuses traversal, encoded traversal, a symlink out of the directory, a listing and other methods', async (test) => {
    const directory = scratch(test)
    await release(test, directory, trust(), '0.1.0')
    const channel = join(directory, 'channel')
    writeFileSync(join(directory, 'secret.txt'), 'outside')
    symlinkSync(join(directory, 'secret.txt'), join(channel, 'link.txt'))
    symlinkSync(directory, join(channel, 'up'))
    const { port, lines } = await serve(test, channel)
    for (const path of ['/../secret.txt', '/%2e%2e/secret.txt', '/%2E%2E%2Fsecret.txt', '/root/../../secret.txt', '/..%5csecret.txt', '/%00', '/link.txt', '/up/secret.txt', '/root', '/root/', '/', '/%zz']) {
      const answer = await get(port, path)
      expect(answer.status, path).toBe(404)
      expect(answer.body, path).not.toContain('outside')
    }
    expect((await get(port, '/timestamp.json', 'POST')).status).toBe(405)
    expect(lines.length).toBeGreaterThan(0)
  })

  it('binds loopback only', async (test) => {
    const directory = scratch(test)
    await expect(serveChannel({ channel: directory, port: 0, host: '0.0.0.0', log: () => undefined })).rejects.toThrow('not loopback')
    await expect(serveChannel({ channel: directory, port: 0, host: 'example.com', log: () => undefined })).rejects.toThrow('not loopback')
    const { server } = await serveChannel({ channel: directory, port: 0, host: '127.0.0.1', log: () => undefined })
    test.onTestFinished(() => new Promise<void>(done => server.close(() => done())))
    expect(server.address()).toMatchObject({ address: '127.0.0.1' })
  })

  it('maps a path to a file below the directory only', async (test) => {
    const directory = scratch(test)
    writeFileSync(join(directory, 'a.json'), '{}')
    expect(await channelFile(directory, '/a.json')).toBe(join(directory, 'a.json'))
    expect(await channelFile(directory, '/../a.json')).toBeUndefined()
  })
})

describe('the local channel re-signing', () => {
  it('writes a newer timestamp that the client verifier accepts and that names the same releases', async (test) => {
    const directory = scratch(test)
    const trusted = trust()
    await release(test, directory, trusted, '0.1.0')
    const channel = join(directory, 'channel')
    const before = readFileSync(join(channel, 'timestamp.json'))
    const later = Math.floor(Date.now() / 1000) + 24 * 3600
    const result = await resignChannel({ channel, state: join(directory, 'state.json'), key: trusted.keys.timestamp, now: later })
    const after = readFileSync(join(channel, 'timestamp.json'))
    const root = trustRootChain([trusted.root], later).at(-1)!
    const verified = verifyTimestamp(root, after, later)
    expect(verified.version).toBe(readEnvelope('timestamp', before).signed.version + 1)
    expect(result.version).toBe(verified.version)
    expect(verified.channels).toEqual(readEnvelope('timestamp', before).signed.channels)
    expect(Date.parse(verified.expires)).toBeGreaterThan(Date.parse(readEnvelope('timestamp', before).signed.expires))
    // The signer state moved with it, so the next release continues from the same versions.
    await release(test, directory, trusted, '0.1.1', new Date(later * 1000))
    expect(verifyTimestamp(root, readFileSync(join(channel, 'timestamp.json')), later).version).toBe(verified.version + 1)
  })

  it('leaves the old timestamp and state in place when the signing fails', async (test) => {
    const directory = scratch(test)
    const trusted = trust()
    await release(test, directory, trusted, '0.1.0')
    const channel = join(directory, 'channel')
    const state = join(directory, 'state.json')
    const [timestamp, stateBefore] = [readFileSync(join(channel, 'timestamp.json')), readFileSync(state)]
    // The targets key is not a timestamp key of the root, so the new file does not verify.
    await expect(resignChannel({ channel, state, key: trusted.keys.targets, now: Math.floor(Date.now() / 1000) })).rejects.toThrow()
    expect(readFileSync(join(channel, 'timestamp.json'))).toEqual(timestamp)
    expect(readFileSync(state)).toEqual(stateBefore)
  })
})
