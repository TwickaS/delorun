/**
 * Where a person-supplied release comes from: a folder holding the release page's files, or an `https:` address that
 * serves them. The result is an ordinary {@link ReleaseSource} and {@link Downloader}, so a manual install runs the same
 * root walk, signature, file-list, digest and release-log checks as a channel install; nothing here relaxes one.
 *
 * @module @delo/install/manual-source
 */
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Downloader } from './download.ts'
import type { ReleaseSource } from './channel.ts'
import { InstallError } from './errors.ts'

/** The host name a folder is served under; `.invalid` never resolves, so no request for it can leave the computer. */
const FOLDER_HOST = 'folder.invalid'

/** A manual release source and the downloader that reads it. */
export interface ManualSource {
  /** Where the release files are named. */
  readonly source: ReleaseSource
  /** Fetches them: from the folder, or from the one `https:` host for this run only. */
  readonly downloader: Downloader
}

/**
 * Serve a folder through a `fetch` that answers 404 for a file the folder lacks, so the install's refusal names it.
 * Release files are looked up by their name at the folder's top level; `root/<n>.root.json` may also sit at the top.
 * @param directory - the folder.
 * @returns a `fetch` over the folder.
 */
function folderFetch(directory: string): typeof globalThis.fetch {
  return async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const segments = url.pathname.split('/').filter(segment => segment !== '')
    const name = segments.at(-1)
    const candidates = name === undefined || name === '..' || name === '.'
      ? []
      : segments.length > 1 && segments[0] === 'root' ? [join(directory, 'root', name), join(directory, name)] : [join(directory, name)]
    for (const path of candidates) {
      try {
        return new Response(new Uint8Array(await readFile(path)), { status: 200 })
      } catch (_missing) {
        // Not at this path: the next candidate, then a 404 that names the file.
      }
    }
    return new Response(null, { status: 404 })
  }
}

/**
 * Read a release from a folder or an `https:` address.
 * @param from - an absolute or relative folder path, or an `https:` URL of a folder-like address.
 * @returns the source and the downloader that allows exactly that source.
 * @throws {InstallError} `DOWNLOAD_REFUSED` when `from` is a URL that is not `https:`.
 */
export function manualSource(from: string): ManualSource {
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(from)) {
    const url = new URL(from)
    if (url.protocol !== 'https:') throw new InstallError('DOWNLOAD_REFUSED', from, `a release address must be https:, not ${url.protocol}`)
    const base = `${url.origin}${url.pathname.replace(/\/+$/u, '')}`
    return {
      source: { metadata: base, files: (_version, name) => `${base}/${name}` },
      downloader: new Downloader({ hosts: { scheme: 'https:', hosts: [url.hostname.toLowerCase()], maxRedirects: 0 } }),
    }
  }
  const origin = `https://${FOLDER_HOST}`
  return {
    source: { metadata: origin, files: (_version, name) => `${origin}/${name}` },
    downloader: new Downloader({ hosts: { scheme: 'https:', hosts: [FOLDER_HOST], maxRedirects: 0 }, fetch: folderFetch(resolve(from)) }),
  }
}
