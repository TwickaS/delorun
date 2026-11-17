/**
 * The transport a pack download uses: a release channel's files by signed name, and an external package from the npm
 * registry by signed URL. It fetches nothing the signed packs file does not name, never follows a redirect, reads a
 * body in pieces and aborts the request the moment it passes the length the caller allows, so a hostile or broken
 * server cannot fill memory or disk with more than the signed size.
 *
 * @module @delorun/runtime-store/packs-fetch
 */
import { METADATA_REQUEST_TIMEOUT_SECONDS, type PackExternal } from '@delorun/contract-release-manifest'
import { PackRefusal } from '@delorun/release-formats/packs/archive'
import type { PackFiles, PackSize, PackTransfer } from './packs-client.ts'

/** The only host an external package comes from. */
export const NPM_REGISTRY_HOST = 'registry.npmjs.org'

/** A release file name: one path segment of the signed file reference's alphabet. */
const RELEASE_FILE_NAME = /^[A-Za-z0-9._+-]{1,255}$/u

/** The network error codes that mean this computer has no connection to the host. */
const NO_CONNECTION: ReadonlySet<string> = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'])

/** What the transport needs. */
export interface PackTransportOptions {
  /** The release channel's directory URL, `https://` or loopback `http://`, where the installed release's files lie. */
  readonly channel: string
  /** The fetch every request goes through; defaults to the global one. */
  readonly fetch?: typeof globalThis.fetch
  /** Seconds before a request is abandoned; defaults to the release files' request timeout. */
  readonly timeoutSeconds?: number
}

/**
 * Read a response body up to a limit.
 * @param response - the response.
 * @param size - the most the body may have, or exactly what it must have.
 * @param abort - aborts the request.
 * @param label - names the download in a refusal.
 * @param onBytes - called with the bytes read so far after each piece.
 * @returns the body.
 * @throws PackRefusal `SIZE_MISMATCH` when the body is longer than allowed, or shorter than an exact size.
 */
async function readBounded(response: Response, size: PackSize, abort: () => void, label: string, onBytes?: (received: number) => void): Promise<Uint8Array> {
  const limit = 'exact' in size ? size.exact : size.max
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > limit) {
    abort()
    throw new PackRefusal(`${label} declares ${String(declared)} bytes, above the ${String(limit)} allowed`, 'SIZE_MISMATCH')
  }
  const chunks: Uint8Array[] = []
  let total = 0
  if (response.body !== null) {
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) {
        abort()
        throw new PackRefusal(`${label} sent more than the ${String(limit)} bytes allowed`, 'SIZE_MISMATCH')
      }
      chunks.push(value)
      onBytes?.(total)
    }
  }
  if ('exact' in size && total !== size.exact) throw new PackRefusal(`${label} has ${String(total)} bytes; the signed packs file lists ${String(size.exact)}`, 'SIZE_MISMATCH')
  return Buffer.concat(chunks)
}

/**
 * The pack files of one installed release.
 * @param options - the channel and the fetch.
 * @returns the transport {@link PackFiles} wants.
 * @throws PackRefusal `FETCH_REFUSED` (when a file is used) for a name that is not a plain file name, a URL that is not
 * the registry's, a redirect, or an answer other than 200 (404 on the channel is "no such file").
 */
export function createPackFiles(options: PackTransportOptions): PackFiles {
  const fetcher = options.fetch ?? globalThis.fetch
  const base = new URL(options.channel.endsWith('/') ? options.channel : `${options.channel}/`)
  const secure = base.protocol === 'https:' || (base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))
  if (!secure) throw new PackRefusal(`the pack channel ${options.channel} is not an https address`, 'FETCH_REFUSED')
  const timeout = (options.timeoutSeconds ?? METADATA_REQUEST_TIMEOUT_SECONDS) * 1000

  async function get(url: URL, size: PackSize, label: string, missingIsUndefined: boolean, transfer: PackTransfer = {}): Promise<Uint8Array | undefined> {
    const controller = new AbortController()
    const outer = (): void => { controller.abort() }
    if (transfer.signal?.aborted === true) controller.abort()
    transfer.signal?.addEventListener('abort', outer, { once: true })
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      let response: Response
      try {
        response = await fetcher(url, { redirect: 'error', signal: controller.signal, headers: { 'accept-encoding': 'identity' } })
      } catch (error) {
        const reason = ((error as { cause?: { code?: string } }).cause)?.code
        if (reason !== undefined && NO_CONNECTION.has(reason)) throw new PackRefusal(`${label} needs a connection: ${reason}`, 'OFFLINE', { cause: error })
        throw new PackRefusal(`${label} could not be fetched (a redirect is refused): ${(error as Error).message}`, 'FETCH_REFUSED', { cause: error })
      }
      if (response.status === 404 && missingIsUndefined) return undefined
      if (response.status !== 200) throw new PackRefusal(`${label} answered ${String(response.status)}`, 'FETCH_REFUSED')
      return await readBounded(response, size, () => { controller.abort() }, label, transfer.onBytes)
    } catch (error) {
      if (error instanceof PackRefusal) throw error
      throw new PackRefusal(`${label} could not be read: ${(error as Error).message}`, 'FETCH_REFUSED', { cause: error })
    } finally {
      clearTimeout(timer)
      transfer.signal?.removeEventListener('abort', outer)
    }
  }

  return {
    fetchRelease(name, size, transfer) {
      if (!RELEASE_FILE_NAME.test(name) || name === '.' || name === '..') return Promise.reject(new PackRefusal(`${JSON.stringify(name)} is not a release file name`, 'FETCH_REFUSED'))
      return get(new URL(encodeURIComponent(name), base), size, name, true, transfer)
    },
    async fetchExternal(pin: PackExternal, transfer?: PackTransfer) {
      const url = new URL(pin.url)
      if (url.protocol !== 'https:' || url.hostname !== NPM_REGISTRY_HOST || url.port !== '' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
        throw new PackRefusal(`${pin.name} is signed with ${pin.url}, which is not a plain ${NPM_REGISTRY_HOST} address`, 'FETCH_REFUSED')
      }
      return (await get(url, { exact: pin.length }, `${pin.name}@${pin.version}`, false, transfer))!
    },
  }
}
