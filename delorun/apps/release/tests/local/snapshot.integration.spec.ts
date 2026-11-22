/**
 * The installed smoke's channel snapshot: a timestamp one version below the live one, naming the earlier release,
 * that a client verifies under the live channel's root.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { signEnvelope } from '@delorun/release-formats/sign/envelope'
import { toJsonValue } from '@delorun/release-formats/sign/json'
import { trustRootChain, verifyTimestamp } from '@delorun/release-formats/sign/verify'
import { writeSnapshot } from '../../src/installed-smoke/snapshot.ts'
import { rootFile, throwawayKeys, type Keys } from '../sign/fixture.ts'

const NOW = Date.parse('2026-11-06T12:00:00Z') / 1000
const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/**
 * A live channel with two releases and a timestamp of the given version naming the newer one.
 * @param keys - the throwaway keys.
 * @param version - the live timestamp's version.
 * @returns the channel directory and the timestamp key's file.
 */
function liveChannel(keys: Keys, version: number): { readonly channel: string, readonly keyFile: string } {
  const channel = mkdtempSync(join(tmpdir(), 'snapshot-spec-'))
  directories.push(channel)
  mkdirSync(join(channel, 'root'))
  writeFileSync(join(channel, 'root', '1.root.json'), rootFile(keys).bytes)
  const manifests: Record<string, Buffer> = {}
  for (const release of ['0.1.0', '0.2.0']) {
    const directory = join(channel, 'releases', 'download', `v${release}`)
    mkdirSync(directory, { recursive: true })
    manifests[release] = Buffer.from(`manifest of ${release}`)
    writeFileSync(join(directory, `delorun-${release}.manifest.json`), manifests[release])
  }
  const entry = { release: '0.2.0', manifest: { name: 'delorun-0.2.0.manifest.json', length: manifests['0.2.0']!.length, sha256: createHash('sha256').update(manifests['0.2.0']!).digest('hex') } }
  const root = trustRootChain([rootFile(keys).bytes], NOW).at(-1)!
  const signed = { schema: 'delorun.release-timestamp/1', version, issued: '2026-11-06T11:00:00Z', expires: '2026-11-09T11:00:00Z', root: { version: root.metadata.version, sha256: root.sha256 }, channels: { stable: entry, beta: entry } }
  writeFileSync(join(channel, 'timestamp.json'), `${JSON.stringify(signEnvelope({ signed: toJsonValue(signed), signatures: [] }, [keys.timestamp]), undefined, 2)}\n`)
  const keyFile = join(channel, '..', `${channel.split('/').at(-1)!}.timestamp.pem`)
  writeFileSync(keyFile, keys.timestamp.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
  directories.push(keyFile)
  return { channel, keyFile }
}

describe('writeSnapshot', () => {
  it('signs a timestamp one version below the live one that names the earlier release, and copies only that release', async () => {
    const keys = throwawayKeys()
    const { channel, keyFile } = liveChannel(keys, 5)
    const directory = mkdtempSync(join(tmpdir(), 'snapshot-out-'))
    directories.push(directory)
    expect(await writeSnapshot({ channel, directory, release: '0.1.0', timestampKey: keyFile, now: NOW })).toBe(4)
    const root = trustRootChain([readFileSync(join(directory, 'root', '1.root.json'))], NOW).at(-1)!
    const stamp = verifyTimestamp(root, readFileSync(join(directory, 'timestamp.json')), NOW)
    expect(stamp.version).toBe(4)
    expect(stamp.channels.stable.release).toBe('0.1.0')
    expect(stamp.channels.beta.release).toBe('0.1.0')
    expect(readFileSync(join(directory, 'releases', 'download', 'v0.1.0', 'delorun-0.1.0.manifest.json'), 'utf8')).toBe('manifest of 0.1.0')
    expect(() => readFileSync(join(directory, 'releases', 'download', 'v0.2.0', 'delorun-0.2.0.manifest.json'))).toThrow()
  })

  it('refuses a live timestamp of version 1, which has no lower version to sign as', async () => {
    const keys = throwawayKeys()
    const { channel, keyFile } = liveChannel(keys, 1)
    const directory = mkdtempSync(join(tmpdir(), 'snapshot-out-'))
    directories.push(directory)
    await expect(writeSnapshot({ channel, directory, release: '0.1.0', timestampKey: keyFile, now: NOW })).rejects.toThrow(/no lower version/u)
  })

  it('refuses a key that is not the root\'s timestamp key', async () => {
    const keys = throwawayKeys()
    const { channel } = liveChannel(keys, 5)
    const other = throwawayKeys()
    const wrong = join(channel, '..', 'wrong.pem')
    writeFileSync(wrong, other.timestamp.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
    directories.push(wrong)
    const directory = mkdtempSync(join(tmpdir(), 'snapshot-out-'))
    directories.push(directory)
    await expect(writeSnapshot({ channel, directory, release: '0.1.0', timestampKey: wrong, now: NOW })).rejects.toThrow()
  })
})
