/**
 * The transport a pack download uses: a release channel's files by signed name, and an external package from the npm
 * registry by signed URL. It fetches nothing the signed packs file does not name, never follows a redirect, reads a
 * body in pieces and aborts the request the moment it passes the length the caller allows, so a hostile or broken
 * server cannot fill memory or disk with more than the signed size.
 *
 * @module @delorun/runtime-store/packs-fetch
 */
import { createHash } from 'node:crypto'
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
  /** Seconds a metadata file (a body bounded by `max`, such as the packs file) may take in total; defaults to the release files' request timeout. */
  readonly timeoutSeconds?: number
  /**
   * Seconds a download of a signed length (a pack archive or an external package) may go without receiving a byte,
   * counted from the request and then from each piece, so the first byte is covered and a slow download that keeps
   * receiving data is never cut off.
   */
  readonly stallSeconds: number
}

/**
 * An address as a message shows it: without any user name or password, which a channel address may carry and which
 * every device that reads the install list would otherwise see.
 * @param url - the address.
 * @returns the address without credentials.
 */
function shown(url: URL): string {
  const plain = new URL(url.href)
  plain.username = ''
  plain.password = ''
  return plain.href
}

/** The stalled download's mark: set when the stall timer, not the caller, aborted the request. */
interface Stall { stalled: boolean }

/**
 * Read a response body up to a limit, hashing it as it arrives. An exact size is read into one preallocated buffer, so
 * the body is held once, not as a list of pieces and again as their concatenation.
 * @param response - the response.
 * @param size - the most the body may have, or exactly what it must have, with the SHA-512 and SHA-256 it must have when known.
 * @param abort - aborts the request.
 * @param label - names the download in a refusal.
 * @param onPiece - called after each piece, before the next is read.
 * @param onBytes - called with the bytes read so far after each piece.
 * @returns the body.
 * @throws PackRefusal `SIZE_MISMATCH` when the body is longer than allowed, or shorter than an exact size, and
 * `DIGEST_MISMATCH` when it does not have the SHA-512 or SHA-256 `size` names.
 */
async function readBounded(response: Response, size: PackSize, abort: () => void, label: string, onPiece: () => void, onBytes?: (received: number) => void): Promise<Uint8Array> {
  const limit = 'exact' in size ? size.exact : size.max
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > limit) {
    abort()
    throw new PackRefusal(`${label} declares ${String(declared)} bytes, above the ${String(limit)} allowed`, 'SIZE_MISMATCH')
  }
  const exact = 'exact' in size ? Buffer.allocUnsafeSlow(size.exact) : undefined
  const hash = 'exact' in size && size.sha512 !== undefined ? createHash('sha512') : undefined
  const hash256 = 'exact' in size && size.sha256 !== undefined ? createHash('sha256') : undefined
  const chunks: Uint8Array[] = []
  let total = 0
  if (response.body !== null) {
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (total + value.byteLength > limit) {
        abort()
        throw new PackRefusal(`${label} sent more than the ${String(limit)} bytes allowed`, 'SIZE_MISMATCH')
      }
      if (exact === undefined) chunks.push(value)
      else exact.set(value, total)
      hash?.update(value)
      hash256?.update(value)
      total += value.byteLength
      onPiece()
      onBytes?.(total)
    }
  }
  if ('exact' in size && total !== size.exact) throw new PackRefusal(`${label} has ${String(total)} bytes; the signed packs file lists ${String(size.exact)}`, 'SIZE_MISMATCH')
  if (hash !== undefined && 'exact' in size && hash.digest('base64') !== size.sha512) throw new PackRefusal(`${label} does not match its signed SHA-512`, 'DIGEST_MISMATCH')
  if (hash256 !== undefined && 'exact' in size && hash256.digest('hex') !== size.sha256) throw new PackRefusal(`${label} does not match its signed SHA-256`, 'DIGEST_MISMATCH')
  return exact ?? Buffer.concat(chunks)
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
  // Node's fetch puts the whole address, password included, in its error text, which every device would then read; this
  // check comes first so no later refusal prints the address with them.
  if (base.username !== '' || base.password !== '') throw new PackRefusal('the pack channel address carries a user name or password, which a release channel does not need', 'FETCH_REFUSED')
  if (!secure) throw new PackRefusal(`the pack channel ${shown(base)} is not an https address`, 'FETCH_REFUSED')
  const requestSeconds = options.timeoutSeconds ?? METADATA_REQUEST_TIMEOUT_SECONDS

  async function get(url: URL, size: PackSize, label: string, missingIsUndefined: boolean, transfer: PackTransfer = {}): Promise<Uint8Array | undefined> {
    const controller = new AbortController()
    const stall: Stall = { stalled: false }
    const outer = (): void => { controller.abort() }
    if (transfer.signal?.aborted === true) controller.abort()
    transfer.signal?.addEventListener('abort', outer, { once: true })
    // A download of a signed length waits at most stallSeconds for the response and then for each next piece; a metadata
    // file has one total limit that no piece extends.
    const download = 'exact' in size
    const limitSeconds = download ? options.stallSeconds : requestSeconds
    let timer: ReturnType<typeof setTimeout> | undefined
    const arm = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => { stall.stalled = true; controller.abort() }, limitSeconds * 1000)
    }
    arm()
    try {
      let response: Response
      try {
        response = await fetcher(url, { redirect: 'error', signal: controller.signal, headers: { 'accept-encoding': 'identity' } })
      } catch (error) {
        if (stall.stalled) throw new PackRefusal(`${label} (${shown(url)}) ${download ? 'received no data' : 'did not answer'} for ${String(limitSeconds)} seconds`, 'FETCH_REFUSED', { cause: error })
        const reason = ((error as { cause?: { code?: string } }).cause)?.code
        if (reason !== undefined && NO_CONNECTION.has(reason)) throw new PackRefusal(`${label} needs a connection: ${reason}`, 'OFFLINE', { cause: error })
        throw new PackRefusal(`${label} (${shown(url)}) could not be fetched (a redirect is refused): ${(error as Error).message}`, 'FETCH_REFUSED', { cause: error })
      }
      if (response.status === 404 && missingIsUndefined) return undefined
      if (response.status !== 200) throw new PackRefusal(`${label} answered ${String(response.status)}`, 'FETCH_REFUSED')
      return await readBounded(response, size, () => { controller.abort() }, label, () => { if (download) arm() }, transfer.onBytes)
    } catch (error) {
      if (error instanceof PackRefusal) throw error
      if (stall.stalled) throw new PackRefusal(`${label} (${shown(url)}) ${download ? `received no data for ${String(limitSeconds)} seconds` : `took more than ${String(limitSeconds)} seconds in total`}`, 'FETCH_REFUSED', { cause: error })
      throw new PackRefusal(`${label} (${shown(url)}) could not be read: ${(error as Error).message}`, 'FETCH_REFUSED', { cause: error })
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
      return (await get(url, { exact: pin.length, sha512: pin.sha512 }, `${pin.name}@${pin.version}`, false, transfer))!
    },
  }
}
