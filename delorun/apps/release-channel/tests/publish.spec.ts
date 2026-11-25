/**
 * Publishing: order, create-only refusal naming the key, the conditional timestamp, the mocked GitHub mirror, and the
 * retry of a dropped connection, which never retries an HTTP answer.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isSocketClosed, mirrorToGithub, parseMarkUrl, publishChannel, publishPlan, PublishRefusal, retryingStore, SOCKET_ATTEMPTS } from '../src/publish-release.ts'
import type { PublishStore, StoredObject } from '../src/store.ts'
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

/** The error undici raises when the other side closed the connection: `TypeError: fetch failed` over the socket error. */
function socketClosed(): TypeError {
  return new TypeError('fetch failed', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) })
}

/** A store that raises the given errors before answering from a memory store. */
function flakyStore(errors: readonly unknown[], inner = new MemoryStore()): { store: PublishStore, calls: string[] } {
  const calls: string[] = []
  const next = (what: string): void => {
    calls.push(what)
    const error = errors[calls.length - 1]
    if (error !== undefined) throw error
  }
  return {
    calls,
    store: {
      read: async (key): Promise<StoredObject | undefined> => { next(`read ${key}`); return inner.read(key) },
      list: async (prefix): Promise<string[]> => { next(`list ${prefix}`); return inner.list(prefix) },
      putIfAbsent: async (key, bytes): Promise<boolean> => { next(`putIfAbsent ${key}`); return inner.putIfAbsent(key, bytes) },
      putIfMatch: async (key, bytes, etag): Promise<boolean> => { next(`putIfMatch ${key}`); return inner.putIfMatch(key, bytes, etag) },
    },
  }
}

describe('a dropped connection', () => {
  it('is recognised through the cause chain undici reports it in', () => {
    expect(isSocketClosed(socketClosed())).toBe(true)
    expect(isSocketClosed(Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }))).toBe(true)
    expect(isSocketClosed(new Error('PUT k answered 403: denied'))).toBe(false)
    expect(isSocketClosed(new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') }))).toBe(false)
    expect(isSocketClosed('other side closed')).toBe(false)
  })

  it('is retried, so a socket error then success uploads once', async () => {
    const inner = new MemoryStore()
    const flaky = flakyStore([socketClosed()], inner)
    const pauses: number[] = []
    const lines: string[] = []
    const store = retryingStore(flaky.store, { sleep: async (milliseconds) => { pauses.push(milliseconds) }, log: line => lines.push(line) })
    expect(await store.putIfAbsent('releases/download/v0.1.0/a.tar.gz', Buffer.from('archive'))).toBe(true)
    expect(flaky.calls).toEqual(['putIfAbsent releases/download/v0.1.0/a.tar.gz', 'putIfAbsent releases/download/v0.1.0/a.tar.gz'])
    expect(inner.writes).toEqual(['releases/download/v0.1.0/a.tar.gz'])
    expect(pauses).toHaveLength(1)
    expect(lines[0]).toMatch(/retrying PUT releases\/download\/v0\.1\.0\/a\.tar\.gz after a dropped connection/u)
  })

  it('is retried on a read and a list too, with a growing pause', async () => {
    const flaky = flakyStore([socketClosed(), socketClosed()])
    const pauses: number[] = []
    const store = retryingStore(flaky.store, { sleep: async (milliseconds) => { pauses.push(milliseconds) } })
    expect(await store.read('timestamp.json')).toBeUndefined()
    expect(flaky.calls).toHaveLength(3)
    expect(pauses[1]).toBeGreaterThan(pauses[0]!)
  })

  it('is not retried when the bucket answers: a 403 or a 412 is an answer, not a dropped connection', async () => {
    for (const answer of [new Error('PUT k answered 403: denied'), new Error('GET k answered 412')]) {
      const flaky = flakyStore([answer])
      const store = retryingStore(flaky.store, { sleep: async () => {} })
      await expect(store.putIfAbsent('k', Buffer.from('x'))).rejects.toThrow(answer.message)
      expect(flaky.calls).toHaveLength(1)
    }
  })

  it('fails with the original error after three dropped connections, not a wrapped one', async () => {
    const first = socketClosed()
    const flaky = flakyStore([first, socketClosed(), socketClosed()])
    const store = retryingStore(flaky.store, { sleep: async () => {} })
    await expect(store.putIfAbsent('k', Buffer.from('x'))).rejects.toBe(first)
    expect(flaky.calls).toHaveLength(SOCKET_ATTEMPTS)
  })

  it('publishes the whole channel through the wrapper, retrying each dropped call once', async () => {
    const inner = new MemoryStore()
    const flaky = flakyStore([socketClosed(), socketClosed()], inner)
    const store = retryingStore(flaky.store, { sleep: async () => {} })
    const written = await publishChannel(store, channelDir())
    expect(written).toEqual(['releases/download/v0.1.0/a.tar.gz', 'releases/download/v0.1.0/b.manifest.json', 'root/1.root.json', 'timestamp.json'])
    expect(inner.writes).toEqual(written)
  })
})

describe('--mark-url', () => {
  it.each(['https://resign.example.test/mark', 'http://127.0.0.1:8787/mark', 'https://example.test/api/mark'])('accepts %s', (url) => {
    expect(parseMarkUrl(url)).toBe(url)
  })

  it.each(['https://resign.example.test', 'https://resign.example.test/', 'https://resign.example.test/mark/', 'https://resign.example.test/marks', 'https://resign.example.test/mark?x=1', 'https://resign.example.test/mark#top', 'ftp://resign.example.test/mark', 'http://resign.example.test/mark', 'resign.example.test/mark'])('refuses %s at parse time', (url) => {
    expect(() => parseMarkUrl(url)).toThrow(/--mark-url must be the Resign Worker's \/mark address/u)
  })
})
