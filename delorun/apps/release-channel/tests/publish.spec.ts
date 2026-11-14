/** Publishing: order, create-only refusal naming the key, the conditional timestamp, and the mocked GitHub mirror. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { mirrorToGithub, publishChannel, publishPlan, PublishRefusal } from '../src/publish-release.ts'
import { MemoryStore, signedChannel } from './support.ts'

const keys = signedChannel().keys
const timestampAt = (version: number): string => signedChannel({ keys, version }).timestamp.bytes.toString()

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

function channelDir(extra: Record<string, string> = {}): string {
  const directory = mkdtempSync(join(tmpdir(), 'release-channel-'))
  directories.push(directory)
  const tree: Record<string, string> = {
    'timestamp.json': timestampAt(2),
    'root/1.root.json': 'root one',
    'releases/download/v0.1.0/b.manifest.json': 'manifest',
    'releases/download/v0.1.0/a.tar.gz': 'archive',
    'releases/download/.building-x/partial': 'ignored',
    ...extra,
  }
  for (const [name, text] of Object.entries(tree)) {
    mkdirSync(join(directory, name, '..'), { recursive: true })
    writeFileSync(join(directory, name), text)
  }
  return directory
}

describe('release publishing', () => {
  it('uploads release files, then roots, then timestamp.json last', async () => {
    const store = new MemoryStore()
    const written = await publishChannel(store, channelDir())
    expect(written).toEqual(['releases/download/v0.1.0/a.tar.gz', 'releases/download/v0.1.0/b.manifest.json', 'root/1.root.json', 'timestamp.json'])
    expect(store.writes).toEqual(written)
  })

  it('refuses to replace a published release file and names the key, writing no root or timestamp', async () => {
    const store = new MemoryStore()
    store.force('releases/download/v0.1.0/a.tar.gz', Buffer.from('other bytes'))
    await expect(publishChannel(store, channelDir())).rejects.toThrow(new PublishRefusal('releases/download/v0.1.0/a.tar.gz is already published with other bytes; a published object is never replaced'))
    expect(store.writes).toEqual([])
  })

  it('refuses to replace a published root', async () => {
    const store = new MemoryStore()
    store.force('root/1.root.json', Buffer.from('another root'))
    await expect(publishChannel(store, channelDir())).rejects.toThrow(/root\/1\.root\.json is already published/u)
    expect(store.objects.has('timestamp.json')).toBe(false)
  })

  it('resumes an interrupted publish by skipping identical objects', async () => {
    const store = new MemoryStore()
    store.force('releases/download/v0.1.0/a.tar.gz', Buffer.from('archive'))
    const lines: string[] = []
    const written = await publishChannel(store, channelDir(), line => lines.push(line))
    expect(written).not.toContain('releases/download/v0.1.0/a.tar.gz')
    expect(lines[0]).toMatch(/skipped releases\/download\/v0\.1\.0\/a\.tar\.gz/u)
  })

  it('replaces timestamp.json conditionally and keeps a racing re-signing', async () => {
    const store = new MemoryStore()
    store.force('timestamp.json', Buffer.from(timestampAt(1)))
    expect(await publishChannel(store, channelDir())).toContain('timestamp.json')
    expect(Buffer.from(store.objects.get('timestamp.json')!.bytes).toString()).toBe(timestampAt(2))
    const racing = new MemoryStore()
    racing.force('timestamp.json', Buffer.from(timestampAt(1)))
    racing.beforeWrite = key => { if (key === 'timestamp.json') racing.force(key, Buffer.from('re-signed')) }
    await expect(publishChannel(racing, channelDir())).rejects.toThrow(/timestamp\.json was replaced by another writer/u)
    expect(Buffer.from(racing.objects.get('timestamp.json')!.bytes).toString()).toBe('re-signed')
  })

  it.each([2, 3])('refuses a timestamp.json whose version is not higher than the stored version %i, and replaces nothing', async stored => {
    const store = new MemoryStore()
    store.force('timestamp.json', Buffer.from(timestampAt(stored)))
    await expect(publishChannel(store, channelDir())).rejects.toThrow(new RegExp(`is version ${String(stored)}; the new one is version 2`, 'u'))
    expect(Buffer.from(store.objects.get('timestamp.json')!.bytes).toString()).toBe(timestampAt(stored))
    expect(store.writes).not.toContain('timestamp.json')
  })

  it('refuses a stored timestamp.json that is not a timestamp file', async () => {
    const store = new MemoryStore()
    store.force('timestamp.json', Buffer.from('not json'))
    await expect(publishChannel(store, channelDir())).rejects.toThrow(/JSON/u)
    expect(store.writes).not.toContain('timestamp.json')
  })

  it('refuses a directory with a stray file or no timestamp', async () => {
    await expect(publishPlan(channelDir({ 'notes.txt': 'x' }))).rejects.toThrow(/notes\.txt is not a channel file/u)
    const empty = mkdtempSync(join(tmpdir(), 'release-channel-'))
    directories.push(empty)
    await expect(publishPlan(empty)).rejects.toThrow(/no timestamp\.json/u)
  })

  it('mirrors the tag\'s release files with gh release upload and no --clobber, through the mocked command', async () => {
    const calls: (readonly string[])[] = []
    const directory = channelDir()
    const uploaded = await mirrorToGithub({ channel: directory, tag: 'v0.1.0', repo: 'owner/repo', run: async args => { calls.push(args) } })
    expect(uploaded).toEqual([join(directory, 'releases/download/v0.1.0/a.tar.gz'), join(directory, 'releases/download/v0.1.0/b.manifest.json')])
    expect(calls).toEqual([['release', 'upload', 'v0.1.0', ...uploaded, '--repo', 'owner/repo']])
    expect(calls[0]).not.toContain('--clobber')
    await expect(mirrorToGithub({ channel: directory, tag: 'v9.9.9', repo: 'owner/repo', run: async () => {} })).rejects.toThrow(/no files under/u)
  })
})
