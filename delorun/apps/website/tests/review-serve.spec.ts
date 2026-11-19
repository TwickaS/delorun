import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { shortfalls } from '../review/resources.ts'
import { get as httpGet } from 'node:http'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import { chooseEncoding, resolveFile, serve, TYPES } from '../review/serve.ts'

describe('review static server', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-serve-'))
  let origin = ''
  let close = (): void => undefined

  beforeAll(async () => {
    mkdirSync(join(root, 'assets'))
    writeFileSync(join(root, 'index.html'), `<h1>home</h1>${'x'.repeat(500)}`)
    writeFileSync(join(root, 'privacy.html'), '<h1>privacy</h1>')
    writeFileSync(join(root, '404.html'), '<h1>lost</h1>')
    writeFileSync(join(root, 'assets', 'a.woff2'), 'x')
    writeFileSync(join(root, 'assets', 'a.webp'), 'x')
    const server = await serve(root, 0)
    const address = server.address()
    origin = `http://127.0.0.1:${String(typeof address === 'object' && address !== null ? address.port : 0)}`
    close = () => { server.close() }
  })
  afterAll(() => { close() })

  it('sends the right type for fonts and pictures', async () => {
    expect((await fetch(`${origin}/assets/a.woff2`)).headers.get('content-type')).toBe('font/woff2')
    expect((await fetch(`${origin}/assets/a.webp`)).headers.get('content-type')).toBe('image/webp')
  })

  it('serves a clean url from its html file', async () => {
    expect(await (await fetch(`${origin}/privacy`)).text()).toContain('privacy')
  })

  it('answers an unknown address with the 404 page and status 404', async () => {
    const response = await fetch(`${origin}/nothing`)
    expect(response.status).toBe(404)
    expect(await response.text()).toContain('lost')
  })

  it('never reads outside the root', () => {
    expect(resolveFile(root, '/../../etc/passwd')).toBeUndefined()
  })

  /** The response as sent: fetch would decode the body, so this reads the raw bytes. */
  const get = (path: string, acceptEncoding: string): Promise<{ headers: Record<string, string | string[] | undefined>; bytes: Buffer }> => new Promise((done, fail) => {
    httpGet(`${origin}${path}`, { headers: { 'accept-encoding': acceptEncoding } }, response => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => { done({ headers: response.headers, bytes: Buffer.concat(chunks) }) })
    }).on('error', fail)
  })

  it('sends brotli with Content-Encoding and Vary to a browser that accepts it', async () => {
    const response = await get('/', 'br, gzip')
    expect(response.headers['content-encoding']).toBe('br')
    expect(response.headers['vary']).toBe('Accept-Encoding')
    expect(brotliDecompressSync(response.bytes).toString()).toContain('<h1>home</h1>')
  })

  it('sends gzip when brotli is not accepted and nothing when neither is', async () => {
    const zipped = await get('/', 'gzip')
    expect(zipped.headers['content-encoding']).toBe('gzip')
    expect(gunzipSync(zipped.bytes).toString()).toContain('home')
    const plain = await get('/', 'identity')
    expect(plain.headers['content-encoding']).toBeUndefined()
    expect(plain.headers['vary']).toBe('Accept-Encoding')
  })

  it('does not compress fonts or pictures', async () => {
    expect((await get('/assets/a.woff2', 'br, gzip')).headers['content-encoding']).toBeUndefined()
    expect((await get('/assets/a.webp', 'br, gzip')).headers['content-encoding']).toBeUndefined()
  })

  it('chooses brotli, then gzip, then nothing', () => {
    expect(chooseEncoding('gzip, br', '.css')).toBe('br')
    expect(chooseEncoding('gzip;q=1', '.js')).toBe('gzip')
    expect(chooseEncoding(undefined, '.html')).toBe('identity')
    expect(chooseEncoding('br', '.webp')).toBe('identity')
  })

  it('knows the types the site ships', () => {
    expect(Object.keys(TYPES)).toEqual(expect.arrayContaining(['.avif', '.json', '.svg']))
  })
})

describe('review resource wait', () => {
  it('waits for too little memory or disk and names why', () => {
    expect(shortfalls({ memoryGb: 2, diskGb: 100 })).toEqual(['2.0 GB of memory available, need 4'])
    expect(shortfalls({ memoryGb: 8, diskGb: 1 })).toEqual(['1.0 GB of disk free, need 5'])
  })

  it('goes ahead with enough of both', () => {
    expect(shortfalls({ memoryGb: 4, diskGb: 5 })).toEqual([])
  })
})
