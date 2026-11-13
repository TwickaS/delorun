/** The public Worker's routes: exactly the channel's paths and methods, its headers and ranges, and no write route. */
import { describe, expect, it } from 'vitest'
import { handleChannelRequest, type ObjectBody, type ObjectHead, type ReadOnlyBucket } from '../src/routes.ts'

const FILES: Record<string, Buffer> = {
  'timestamp.json': Buffer.from('{"timestamp":true}'),
  'root/2.root.json': Buffer.from('{"root":2}'),
  'releases/download/v0.1.0/delorun-0.1.0.manifest.json': Buffer.from('0123456789'),
  'releases/download/v0.1.0-rc.1/archive.tar.gz': Buffer.from('abcdefghij'),
  'secret.txt': Buffer.from('private'),
}

const writes: string[] = []
const bucket: ReadOnlyBucket & { put?: unknown } = {
  async head(key): Promise<ObjectHead | null> {
    const file = FILES[key]
    return file === undefined ? null : { size: file.byteLength, etag: `tag-${key.length}` }
  },
  async get(key, options): Promise<ObjectBody | null> {
    const file = FILES[key]
    if (file === undefined) return null
    const part = options === undefined ? file : file.subarray(options.range.offset, options.range.offset + options.range.length)
    return { size: file.byteLength, etag: 'x', body: new Blob([new Uint8Array(part)]).stream() }
  },
  put: (key: string): void => { writes.push(key) },
}

function ask(path: string, init: RequestInit = {}): Promise<Response> {
  return handleChannelRequest(new Request(`https://releases.test${path}`, init), bucket)
}

describe('release channel routes', () => {
  it('serves timestamp.json for 60 seconds', async () => {
    const response = await ask('/timestamp.json')
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=60')
    expect(response.headers.get('Content-Type')).toBe('application/json')
    expect(await response.text()).toBe('{"timestamp":true}')
  })

  it('serves roots and release files as immutable', async () => {
    for (const path of ['/root/2.root.json', '/releases/download/v0.1.0/delorun-0.1.0.manifest.json', '/releases/download/v0.1.0-rc.1/archive.tar.gz']) {
      const response = await ask(path)
      expect(response.status, path).toBe(200)
      expect(response.headers.get('Cache-Control'), path).toBe('public, max-age=31536000, immutable')
      expect(response.headers.get('Accept-Ranges')).toBe('bytes')
    }
  })

  it('answers HEAD with the headers and no body', async () => {
    const response = await ask('/releases/download/v0.1.0/delorun-0.1.0.manifest.json', { method: 'HEAD' })
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Length')).toBe('10')
    expect(await response.text()).toBe('')
  })

  it('serves byte ranges as 206 and refuses a range outside the object with 416', async () => {
    const path = '/releases/download/v0.1.0/delorun-0.1.0.manifest.json'
    const middle = await ask(path, { headers: { Range: 'bytes=2-4' } })
    expect(middle.status).toBe(206)
    expect(middle.headers.get('Content-Range')).toBe('bytes 2-4/10')
    expect(await middle.text()).toBe('234')
    const open = await ask(path, { headers: { Range: 'bytes=7-' } })
    expect(await open.text()).toBe('789')
    const suffix = await ask(path, { headers: { Range: 'bytes=-3' } })
    expect(suffix.headers.get('Content-Range')).toBe('bytes 7-9/10')
    expect(await suffix.text()).toBe('789')
    const head = await ask(path, { method: 'HEAD', headers: { Range: 'bytes=0-1' } })
    expect(head.status).toBe(206)
    for (const range of ['bytes=10-', 'bytes=-0', 'bytes=5-2']) {
      const refused = await ask(path, { headers: { Range: range } })
      expect(refused.status, range).toBe(416)
      expect(refused.headers.get('Content-Range')).toBe('bytes */10')
    }
    const ignored = await ask(path, { headers: { Range: 'items=1-2' } })
    expect(ignored.status).toBe(200)
  })

  it('answers 404 for every other path', async () => {
    for (const path of ['/', '/secret.txt', '/timestamp.json/', '/root/0.root.json', '/root/02.root.json', '/root/3.root.json', '/releases/download/v0.1.0/', '/releases/download/v0.1.0/a/b', '/releases/download/v0.1.0/..%2Fsecret.txt', '/releases/download/v0.1.0/../../secret.txt', '/releases/download/0.1.0/x', '/releases/download/v0.1.0/missing', '/releases/other']) {
      expect((await ask(path)).status, path).toBe(404)
    }
  })

  it('answers 404 to every method but GET and HEAD, and never writes', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      const response = await ask('/timestamp.json', { method, ...(method === 'POST' || method === 'PUT' || method === 'PATCH' ? { body: 'x' } : {}) })
      expect(response.status, method).toBe(404)
    }
    expect(writes).toEqual([])
  })
})
