/**
 * The one way the launcher fetches a release file (contract C1, "The npm launcher and the install script"): HTTPS
 * only, the hosts of contract C1's list and no other, redirects followed only to those hosts, contract C1's two
 * timeouts, and a byte limit enforced while the body arrives rather than after it. A refusal of the rule is C1's
 * `DOWNLOAD_REFUSED`; a connection, stall, status or size failure is `DOWNLOAD_FAILED`.
 *
 * A rule covers one service. {@link RELEASE_HOSTS} is contract C1's, for release files; another service that the same
 * launcher reads, such as the release log of contract C18, takes its own rule through {@link Downloader.withHosts}, so
 * that neither list has to name the other's hosts and neither widens the other.
 *
 * @module @delorun/install/download
 */
import { createHash } from 'node:crypto'
import { open as openFile, rm, type FileHandle } from 'node:fs/promises'
import { DOWNLOAD_CONNECT_TIMEOUT_MS, DOWNLOAD_STALL_TIMEOUT_MS, RELEASE_DOWNLOAD_HOSTS } from '@delorun/contract-home-layout'
import { InstallError, messageOf } from './errors.ts'

type Fetch = typeof globalThis.fetch
type FetchResponse = Awaited<ReturnType<Fetch>>

/**
 * Where one service's files may be fetched from. One rule covers one service: contract C1's release files and contract
 * C18's release log have a rule each, and neither rule names the other's hosts.
 */
export interface HostRule {
  /** The one scheme this service's files travel over. */
  readonly scheme: string
  /** The hosts a request may name, its redirects included. */
  readonly hosts: readonly string[]
  /** Redirects followed before the download is refused. */
  readonly maxRedirects: number
}

/** Contract C1's download rule: HTTPS to the release and GitHub asset hosts, redirects included. */
export const RELEASE_HOSTS: HostRule = { scheme: 'https:', hosts: RELEASE_DOWNLOAD_HOSTS, maxRedirects: 5 }

/** The two timeouts contract C1 sets on a download. */
export interface DownloadTimings {
  /** How long a connection may take to open. */
  readonly connectMs: number
  /** How long the body may deliver no byte. */
  readonly stallMs: number
  /** How long one download may take in all, redirects and body included; unbounded when absent. */
  readonly totalMs?: number
}

/** Contract C1's timings: 30 seconds to connect, 60 seconds without a byte. */
export const RELEASE_TIMINGS: DownloadTimings = { connectMs: DOWNLOAD_CONNECT_TIMEOUT_MS, stallMs: DOWNLOAD_STALL_TIMEOUT_MS }

/** What a {@link Downloader} needs. */
export interface DownloaderOptions {
  /** The hosts and redirects allowed; {@link RELEASE_HOSTS} by default. */
  readonly hosts?: HostRule
  /** The two timeouts; {@link RELEASE_TIMINGS} by default. */
  readonly timings?: DownloadTimings
  /** The fetch to use, this process's by default. */
  readonly fetch?: Fetch
  /** The file opener a download into a file writes through; {@link openFile} by default. */
  readonly openFile?: typeof openFile
}

/** A file a download produced. */
export interface Downloaded {
  /** The URL that answered, after its redirects. */
  readonly url: string
  /** The file's bytes. */
  readonly bytes: Buffer
}

/** An open response, with the controller its body reads under. */
interface Open {
  readonly response: FetchResponse
  readonly url: string
  readonly controller: AbortController
  /** Aborts when the download's total deadline passes. */
  readonly whole: AbortSignal
}

/**
 * The refusal for a file that opened but could not be written to completion, such as a filesystem that filled
 * (`ENOSPC`) or a file that passed its size limit (`EFBIG`): the same typed refusal a file that cannot be created
 * raises, so no raw `fs` error reaches a caller.
 * @param url - the URL the body came from.
 * @param path - the file being written.
 * @param error - what the write raised.
 * @returns the refusal, or the error itself when it is already one.
 */
function writeRefused(url: string, path: string, error: unknown): InstallError {
  return error instanceof InstallError ? error : new InstallError('DOWNLOAD_FAILED', url, `${path} cannot be written: ${messageOf(error)}`, { cause: error })
}

/**
 * Contract C1's downloader. One instance serves one service's files, so they share its host rule and timings; a caller
 * that fetches from another service takes {@link Downloader.withHosts} rather than widening this rule.
 */
export class Downloader {
  private readonly hosts: HostRule
  private readonly timings: DownloadTimings
  private readonly fetch: Fetch
  private readonly openFile: typeof openFile

  /**
   * @param options - the hosts, the timings and the fetch; contract C1's values by default.
   */
  constructor(options: DownloaderOptions = {}) {
    this.hosts = options.hosts ?? RELEASE_HOSTS
    this.timings = options.timings ?? RELEASE_TIMINGS
    this.fetch = options.fetch ?? globalThis.fetch
    this.openFile = options.openFile ?? openFile
  }

  /**
   * Another service's downloader: this one's fetch, timings and file opener, under the given host rule. The rule is a
   * value rather than a widening, so the downloader this was taken from keeps refusing the hosts the new rule names.
   * @param hosts - the rule the derived downloader applies.
   * @param options - `totalMs`, the total deadline of each download of the derived downloader; none by default.
   * @returns a downloader whose rule is the one given and whose fetch and timeouts are this one's.
   */
  withHosts(hosts: HostRule, options: { readonly totalMs?: number } = {}): Downloader {
    const timings = options.totalMs === undefined ? this.timings : { ...this.timings, totalMs: options.totalMs }
    return new Downloader({ hosts, timings, fetch: this.fetch, openFile: this.openFile })
  }

  /**
   * Download a file into memory, refusing it past `limit` bytes while it arrives.
   * @param url - the file's URL.
   * @param limit - its largest allowed length in bytes.
   * @returns the answering URL and the bytes.
   * @throws {InstallError} `DOWNLOAD_REFUSED` for a URL or redirect outside the host rule; `DOWNLOAD_FAILED` for a
   *   connection, stall, status or size failure.
   */
  async bytes(url: string, limit: number): Promise<Downloaded> {
    const total = this.deadline()
    try {
      const open = await this.open(url, total.signal)
      try {
        return { url: open.url, bytes: await this.read(open, limit) }
      } finally {
        open.controller.abort()
      }
    } finally {
      total.clear()
    }
  }

  /**
   * Start the total deadline of one download.
   * @returns a signal that aborts when {@link DownloadTimings.totalMs} passes, and the function that stops the clock.
   */
  private deadline(): { readonly signal: AbortSignal, readonly clear: () => void } {
    const controller = new AbortController()
    const totalMs = this.timings.totalMs
    if (totalMs === undefined) return { signal: controller.signal, clear: () => undefined }
    const timer = setTimeout(() => controller.abort(new Error(`the download did not finish within ${String(totalMs)} ms`)), totalMs)
    return { signal: controller.signal, clear: () => { clearTimeout(timer) } }
  }

  /**
   * Download a file into a new file, refusing it past `limit` bytes while it arrives and removing the file when
   * anything fails.
   * @param url - the file's URL.
   * @param limit - its largest allowed length in bytes.
   * @param path - the file to write; it must not exist.
   * @param onBytes - told how many bytes are on disk after each piece; a display only, which decides nothing.
   * @returns the answering URL, the length and the SHA-256 of what was written.
   * @throws {InstallError} `DOWNLOAD_REFUSED` or `DOWNLOAD_FAILED`, as {@link Downloader.bytes} does; a file that
   *   cannot be created, written to completion or closed is the same `DOWNLOAD_FAILED`.
   */
  async file(url: string, limit: number, path: string, onBytes?: (written: number) => void): Promise<{ readonly url: string, readonly length: number, readonly sha256: string }> {
    const total = this.deadline()
    try {
      return await this.fileUnder(url, limit, path, total.signal, onBytes)
    } finally {
      total.clear()
    }
  }

  /**
   * {@link Downloader.file} under a total deadline.
   * @param url - the file's URL.
   * @param limit - its largest allowed length in bytes.
   * @param path - the file to write.
   * @param whole - aborts when the total deadline passes.
   * @param onBytes - told how many bytes are on disk after each piece.
   * @returns the answering URL, the length and the SHA-256 of what was written.
   */
  private async fileUnder(url: string, limit: number, path: string, whole: AbortSignal, onBytes: ((written: number) => void) | undefined): Promise<{ readonly url: string, readonly length: number, readonly sha256: string }> {
    const open = await this.open(url, whole)
    const hash = createHash('sha256')
    // The file is opened before its body is read, so a failure that arrives while the body is read removes a file this
    // call created, and a file another call already wrote is never removed.
    let out: FileHandle
    try {
      out = await this.openFile(path, 'wx', 0o600)
    } catch (error) {
      open.controller.abort()
      throw writeRefused(open.url, path, error)
    }
    let written = 0
    try {
      for await (const chunk of this.chunks(open, limit)) {
        written += chunk.byteLength
        hash.update(chunk)
        // A full filesystem or a file-size limit fails here rather than at the open, so the write is wrapped too:
        // a caller sees one typed refusal, never a raw `fs` error.
        try {
          await out.write(chunk)
        } catch (error) {
          throw writeRefused(open.url, path, error)
        }
        onBytes?.(written)
      }
      try {
        await out.close()
      } catch (error) {
        throw writeRefused(open.url, path, error)
      }
      return { url: open.url, length: written, sha256: hash.digest('hex') }
    } catch (error) {
      await out.close().catch(() => undefined)
      await rm(path, { force: true })
      throw error
    } finally {
      open.controller.abort()
    }
  }

  /**
   * Open a URL, following redirects as long as each hop is allowed.
   * @param url - the URL.
   * @param whole - aborts when the download's total deadline passes.
   * @returns the response, its URL and the controller that aborts its body.
   * @throws {InstallError} `DOWNLOAD_REFUSED` for a hop outside the rule; `DOWNLOAD_FAILED` for a failed connection or
   *   a response other than 200.
   */
  private async open(url: string, whole: AbortSignal): Promise<Open> {
    let current = url
    for (let hop = 0; hop <= this.hosts.maxRedirects; hop++) {
      this.allow(current)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error(`the connection did not open within ${String(this.timings.connectMs)} ms`)), this.timings.connectMs)
      let response: FetchResponse
      try {
        response = await this.fetch(current, { redirect: 'manual', signal: AbortSignal.any([controller.signal, whole]) })
      } catch (error) {
        throw new InstallError('DOWNLOAD_FAILED', current, `the connection did not open: ${messageOf(error)}`, { cause: error })
      } finally {
        clearTimeout(timer)
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        await response.body?.cancel().catch(() => undefined)
        controller.abort()
        if (location === null) throw new InstallError('DOWNLOAD_FAILED', current, `the host answered ${String(response.status)} without a location`)
        current = new URL(location, current).href
        continue
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined)
        controller.abort()
        throw new InstallError('DOWNLOAD_FAILED', current, `the host answered ${String(response.status)}`, { status: response.status })
      }
      return { response, url: current, controller, whole }
    }
    throw new InstallError('DOWNLOAD_REFUSED', url, `the download followed more than ${String(this.hosts.maxRedirects)} redirects`)
  }

  /**
   * Refuse a URL the host rule does not allow.
   * @param url - the URL of one hop.
   * @throws {InstallError} `DOWNLOAD_REFUSED` naming the URL and the reason.
   */
  private allow(url: string): void {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch (error) {
      throw new InstallError('DOWNLOAD_REFUSED', url, 'the URL does not parse', { cause: error })
    }
    if (parsed.protocol !== this.hosts.scheme) {
      throw new InstallError('DOWNLOAD_REFUSED', url, `a download travels over ${this.hosts.scheme}, not ${parsed.protocol}`)
    }
    if (!this.hosts.hosts.includes(parsed.hostname.toLowerCase())) {
      throw new InstallError('DOWNLOAD_REFUSED', url, `${parsed.hostname} is not an allowed host; downloads come from ${this.hosts.hosts.join(', ')}`)
    }
  }

  /**
   * Read a response's body in memory under the stall timeout and the size limit.
   * @param open - the open response.
   * @param limit - the largest allowed length in bytes.
   * @returns the bytes.
   * @throws {InstallError} `DOWNLOAD_FAILED` for a stall or a size failure.
   */
  private async read(open: Open, limit: number): Promise<Buffer> {
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of this.chunks(open, limit)) {
      total += chunk.byteLength
      chunks.push(chunk)
    }
    return Buffer.concat(chunks, total)
  }

  /**
   * A response's body in chunks, refusing the declared length before reading and the counted length while reading,
   * and aborting a body that delivers no byte for the stall timeout.
   * @param open - the open response.
   * @param limit - the largest allowed length in bytes.
   * @returns the chunks.
   * @throws {InstallError} `DOWNLOAD_FAILED` for a size or stall failure.
   */
  private async *chunks(open: Open, limit: number): AsyncGenerator<Buffer> {
    const declared = open.response.headers.get('content-length')
    if (declared !== null && Number(declared) > limit) {
      throw new InstallError('DOWNLOAD_FAILED', open.url, `the file is ${declared} bytes, above its limit of ${String(limit)}`, { oversize: true })
    }
    const body = open.response.body
    if (body === null) return
    const reader = body.getReader()
    let stalled = false
    let total = 0
    let timer = setTimeout(() => {
      stalled = true
      open.controller.abort()
    }, this.timings.stallMs)
    try {
      for (;;) {
        let result: Awaited<ReturnType<typeof reader.read>>
        try {
          result = await reader.read()
        } catch (error) {
          if (open.whole.aborted) throw new InstallError('DOWNLOAD_FAILED', open.url, messageOf(open.whole.reason), { cause: error })
          if (stalled) throw new InstallError('DOWNLOAD_FAILED', open.url, `the download delivered no byte for ${String(this.timings.stallMs)} ms`, { cause: error })
          throw new InstallError('DOWNLOAD_FAILED', open.url, `the download stopped: ${messageOf(error)}`, { cause: error })
        }
        clearTimeout(timer)
        if (result.done) return
        total += result.value.byteLength
        if (total > limit) throw new InstallError('DOWNLOAD_FAILED', open.url, `the file passed its limit of ${String(limit)} bytes`, { oversize: true })
        timer = setTimeout(() => {
          stalled = true
          open.controller.abort()
        }, this.timings.stallMs)
        yield Buffer.from(result.value)
      }
    } finally {
      clearTimeout(timer)
      await reader.cancel().catch(() => undefined)
    }
  }
}
