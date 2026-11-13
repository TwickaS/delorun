/** The S3 store sends conditional writes and reads a 412 as a lost condition, through a stand-in `fetch`. */
import { describe, expect, it } from 'vitest'
import { s3Store } from '../src/s3-store.ts'

interface Seen { readonly method: string, readonly url: string, readonly headers: Headers }

function store(respond: (seen: Seen) => Response): { store: ReturnType<typeof s3Store>, seen: Seen[] } {
  const seen: Seen[] = []
  const fetcher = (async (input: Request): Promise<Response> => {
    const entry = { method: input.method, url: input.url, headers: input.headers }
    seen.push(entry)
    return respond(entry)
  }) as typeof fetch
  return { store: s3Store({ accountId: 'acct', bucket: 'delo-releases-staging', accessKeyId: 'AKIA', secretAccessKey: 'secret', fetch: fetcher }), seen }
}

describe('S3 release store', () => {
  it('creates with If-None-Match and replaces with If-Match, both signed, and reads 412 as a lost condition', async () => {
    const { store: s3, seen } = store(request => new Response(null, { status: request.headers.get('If-Match') === '"stale"' ? 412 : 200 }))
    expect(await s3.putIfAbsent('releases/download/v0.1.0/a b.json', Buffer.from('x'))).toBe(true)
    expect(seen[0]!.url).toBe('https://acct.r2.cloudflarestorage.com/delo-releases-staging/releases/download/v0.1.0/a%20b.json')
    expect(seen[0]!.headers.get('If-None-Match')).toBe('*')
    expect(seen[0]!.headers.get('Authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIA\//u)
    expect(await s3.putIfMatch('timestamp.json', Buffer.from('x'), '"fresh"')).toBe(true)
    expect(await s3.putIfMatch('timestamp.json', Buffer.from('x'), '"stale"')).toBe(false)
  })

  it('fails loudly on other errors', async () => {
    const { store: s3 } = store(() => new Response('denied', { status: 403 }))
    await expect(s3.putIfAbsent('k', Buffer.from('x'))).rejects.toThrow(/answered 403/u)
    await expect(s3.read('k')).rejects.toThrow(/answered 403/u)
  })

  it('reads an object with its entity tag, a missing one as undefined, and lists across pages', async () => {
    const { store: s3, seen } = store(request => {
      const url = new URL(request.url)
      if (url.searchParams.get('list-type') === '2') {
        return url.searchParams.has('continuation-token')
          ? new Response('<ListBucketResult><Contents><Key>root/2.root.json</Key></Contents><IsTruncated>false</IsTruncated></ListBucketResult>')
          : new Response('<ListBucketResult><Contents><Key>root/1.root.json</Key></Contents><IsTruncated>true</IsTruncated><NextContinuationToken>t1</NextContinuationToken></ListBucketResult>')
      }
      return url.pathname.endsWith('/missing') ? new Response(null, { status: 404 }) : new Response('body', { headers: { ETag: '"abc"' } })
    })
    expect(await s3.read('timestamp.json')).toEqual({ bytes: new TextEncoder().encode('body'), etag: '"abc"' })
    expect(await s3.read('missing')).toBeUndefined()
    expect(await s3.list('root/')).toEqual(['root/1.root.json', 'root/2.root.json'])
    expect(seen.length).toBe(4)
  })
})
