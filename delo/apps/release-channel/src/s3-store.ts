/**
 * {@link PublishStore} over R2's S3 API with conditional writes (`If-None-Match: *` creates, `If-Match` replaces; a
 * failed condition answers 412). The S3 token is scoped to Object Read and Write on the one bucket and lives with the
 * person or workflow that publishes, never on a Worker.
 *
 * @module @delo/release-channel/s3-store
 */
import { AwsClient } from 'aws4fetch'
import type { PublishStore, StoredObject } from './store.ts'

/** Where and as whom the S3 store connects. */
export interface S3StoreConfig {
  /** The Cloudflare account id, which names the endpoint `<id>.r2.cloudflarestorage.com`. */
  readonly accountId: string
  /** The bucket name. */
  readonly bucket: string
  /** The S3 API token's access key id. */
  readonly accessKeyId: string
  /** The S3 API token's secret access key. */
  readonly secretAccessKey: string
  /** The endpoint, for a local S3 stand-in; derived from the account id by default. */
  readonly endpoint?: string
  /** The request function, for tests; the global `fetch` by default. */
  readonly fetch?: typeof fetch
}

function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/')
}

/**
 * The store over R2's S3 API.
 * @param config - the endpoint and credentials.
 * @returns the store.
 */
export function s3Store(config: S3StoreConfig): PublishStore {
  const client = new AwsClient({ accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, service: 's3', region: 'auto' })
  const base = `${config.endpoint ?? `https://${config.accountId}.r2.cloudflarestorage.com`}/${config.bucket}`
  const send = async (url: string, init: RequestInit): Promise<Response> => {
    const signed = await client.sign(url, init)
    return await (config.fetch ?? fetch)(signed)
  }
  const put = async (key: string, bytes: Uint8Array, condition: Record<string, string>): Promise<boolean> => {
    const response = await send(`${base}/${encodeKey(key)}`, { method: 'PUT', body: Buffer.from(bytes), headers: condition })
    if (response.status === 412) return false
    if (!response.ok) throw new Error(`PUT ${key} answered ${String(response.status)}: ${await response.text()}`)
    return true
  }
  return {
    async read(key): Promise<StoredObject | undefined> {
      const response = await send(`${base}/${encodeKey(key)}`, { method: 'GET' })
      if (response.status === 404) return undefined
      if (!response.ok) throw new Error(`GET ${key} answered ${String(response.status)}`)
      return { bytes: new Uint8Array(await response.arrayBuffer()), etag: response.headers.get('etag') ?? '' }
    },
    async list(prefix) {
      const keys: string[] = []
      let token: string | undefined
      do {
        const query = new URLSearchParams({ 'list-type': '2', prefix })
        if (token !== undefined) query.set('continuation-token', token)
        const response = await send(`${base}?${query.toString()}`, { method: 'GET' })
        if (!response.ok) throw new Error(`LIST ${prefix} answered ${String(response.status)}`)
        const text = await response.text()
        for (const match of text.matchAll(/<Key>([^<]*)<\/Key>/gu)) keys.push(match[1]!.replaceAll('&amp;', '&'))
        token = /<IsTruncated>true<\/IsTruncated>/u.test(text) ? /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/u.exec(text)?.[1] : undefined
      } while (token !== undefined)
      return keys
    },
    putIfAbsent: async (key, bytes) => await put(key, bytes, { 'If-None-Match': '*' }),
    putIfMatch: async (key, bytes, etag) => await put(key, bytes, { 'If-Match': etag }),
  }
}
