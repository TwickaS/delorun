/**
 * The local RC channel: serves a signed release channel directory (the output of `local-release.ts`) over HTTP on
 * loopback and keeps its `timestamp.json` fresh, so a launcher built with that origin (`npm-launcher/src/build.ts
 * --channel-origin http://127.0.0.1:<port>`) updates from this computer. See "The local RC channel" in
 * `delorun/apps/release/README.md`.
 *
 * `tsx delorun/apps/release/scripts/local-channel.ts serve --channel <dir> --port <n> --state <signer state file>
 * --timestamp-key <timestamp.pem> [--host 127.0.0.1] [--resign-hours 24]`
 *
 * The server answers GET and HEAD for regular files below `--channel` and nothing else: no directory listing, no
 * path that leaves the directory by `..`, encoded separators or a symlink. It binds `127.0.0.1` (or `::1`) only.
 * On start and every `--resign-hours` it signs the next timestamp with the signer of `sign/timestamp.ts`
 * (`resignedTimestamp`): the channel entries the current timestamp names stay, the version rises by one, and the
 * lifetime restarts. The signer state in `--state` moves with it, so `local-release.ts` continues from the same
 * versions. A failed re-signing leaves the old `timestamp.json` and the old state in place and logs the reason.
 *
 * @module local-channel
 */
import { createPrivateKey, type KeyObject } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { signEnvelope } from '@delorun/release-formats/sign/envelope'
import type { JsonValue } from '@delorun/release-formats/sign/json'
import { readEnvelope } from '@delorun/release-formats/sign/schemas'
import { trustRootChain, verifyTimestamp } from '@delorun/release-formats/sign/verify'
import { resignedTimestamp, readTimestampState, stateAfter } from '../src/sign/timestamp.ts'

/** The hosts the server binds; a channel is for this computer only. */
export const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', '::1']

/** Content types by file extension; any other file is `application/octet-stream`. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.json': 'application/json',
  '.gz': 'application/gzip',
  '.tgz': 'application/gzip',
  '.zip': 'application/zip',
}

/**
 * The file a request path names inside a channel directory.
 * @param root - the channel directory's real path.
 * @param urlPath - the request target's path, still percent-encoded.
 * @returns the file's real path, or `undefined` when the path is malformed, leaves the directory or names no regular file.
 */
export async function channelFile(root: string, urlPath: string): Promise<string | undefined> {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    // A malformed percent escape names no file.
    return undefined
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return undefined
  const segments = decoded.split('/').filter(segment => segment !== '')
  if (segments.some(segment => segment === '..' || segment === '.')) return undefined
  const candidate = resolve(root, ...segments)
  let real: string
  try {
    real = await realpath(candidate)
  } catch {
    // A missing path names no file.
    return undefined
  }
  if (!real.startsWith(`${root}${sep}`)) return undefined
  return (await stat(real)).isFile() ? real : undefined
}

/** What the server needs. */
export interface ServeRequest {
  /** The channel directory. */
  readonly channel: string
  /** The port; 0 picks a free one. */
  readonly port: number
  /** The address to bind; one of {@link LOOPBACK_HOSTS}. */
  readonly host: string
  /** Logs one line. */
  readonly log: (line: string) => void
}

/**
 * Start the static server.
 * @param request - the directory, port, host and log.
 * @returns the listening server and the port it bound.
 * @throws Error when the host is not loopback or the directory does not exist.
 */
export async function serveChannel(request: ServeRequest): Promise<{ readonly server: Server, readonly port: number }> {
  if (!LOOPBACK_HOSTS.includes(request.host)) throw new Error(`--host ${request.host} is not loopback; the local channel binds ${LOOPBACK_HOSTS.join(' or ')} only`)
  const root = await realpath(resolve(request.channel))
  const server = createServer((incoming, response) => {
    const fail = (status: number, reason: string): void => {
      request.log(`${incoming.method ?? '?'} ${incoming.url ?? '?'} -> ${String(status)} ${reason}`)
      response.writeHead(status, { 'content-type': 'text/plain' }).end(`${reason}\n`)
    }
    if (incoming.method !== 'GET' && incoming.method !== 'HEAD') {
      response.setHeader('allow', 'GET, HEAD')
      fail(405, 'method not allowed')
      return
    }
    // The request target's path only: a query or fragment never selects a file.
    const urlPath = (incoming.url ?? '/').split(/[?#]/u)[0]!
    channelFile(root, urlPath).then(async (file) => {
      if (file === undefined) {
        fail(404, 'not found')
        return
      }
      const { size } = await stat(file)
      const headers: Record<string, string | number> = { 'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream', 'content-length': size }
      if (file === join(root, 'timestamp.json')) headers['cache-control'] = 'no-store'
      response.writeHead(200, headers)
      if (incoming.method === 'HEAD') {
        response.end()
        return
      }
      const stream = createReadStream(file)
      stream.on('error', (error) => {
        request.log(`GET ${urlPath} -> read error ${error.message}`)
        response.destroy(error)
      })
      stream.pipe(response)
    }).catch((error: unknown) => {
      fail(500, 'internal error')
      request.log(`error ${error instanceof Error ? error.message : String(error)}`)
    })
  })
  await new Promise<void>((done, failed) => {
    server.once('error', failed)
    server.listen(request.port, request.host, done)
  })
  return { server, port: (server.address() as AddressInfo).port }
}

/** What re-signing needs. */
export interface ResignRequest {
  /** The channel directory, holding `timestamp.json` and `root/<n>.root.json`. */
  readonly channel: string
  /** The signer's state file, the one `local-release.ts` keeps. */
  readonly state: string
  /** The timestamp private key. */
  readonly key: KeyObject
  /** The signing time, in Unix seconds. */
  readonly now: number
}

/**
 * Re-sign the channel's timestamp: the next version over the same channel entries, with a fresh lifetime. The state is
 * written first and the timestamp last, each through a temporary file renamed into place.
 * @param request - the channel, state, key and time.
 * @returns the new timestamp's version and expiry.
 * @throws Error when the roots do not chain, the current timestamp is not the state's last, or the key is not the root's timestamp key; nothing is written then.
 */
export async function resignChannel(request: ResignRequest): Promise<{ readonly version: number, readonly expires: string }> {
  const { channel, state, key, now } = request
  const stored = readTimestampState(await readFile(state))
  const roots = trustRootChain(await Promise.all(Array.from({ length: stored.root.version }, (_, index) => readFile(join(channel, 'root', `${String(index + 1)}.root.json`)))), now)
  const root = roots.at(-1)!
  const currentBytes = await readFile(join(channel, 'timestamp.json'))
  // The state's last timestamp must be the served one, so the re-signing continues what clients saw.
  if (stored.timestamp === null || Buffer.compare(Buffer.from(stored.timestamp.file, 'base64'), currentBytes) !== 0) {
    throw new Error(`${join(channel, 'timestamp.json')} is not the last timestamp the state records; the state and the channel have diverged`)
  }
  const previous = verifyTimestamp(root, currentBytes, now, undefined, { allowExpired: true })
  const content = resignedTimestamp(previous, now)
  const raw = readEnvelope('timestamp', currentBytes).signedJson as { readonly [key: string]: JsonValue }
  const signed = { ...raw, version: content.version, issued: content.issued, expires: content.expires }
  const bytes = Buffer.from(`${JSON.stringify(signEnvelope({ signed, signatures: [] }, [key]), undefined, 2)}\n`)
  // Verifying the new file also proves the key is one of the root's timestamp keys.
  verifyTimestamp(root, bytes, now)
  const replace = async (path: string, content: Uint8Array | string): Promise<void> => {
    await writeFile(`${path}.signing`, content, { mode: 0o644 })
    await rename(`${path}.signing`, path)
  }
  await replace(state, `${JSON.stringify(stateAfter(root, bytes, content.version), undefined, 2)}\n`)
  await replace(join(channel, 'timestamp.json'), bytes)
  return { version: content.version, expires: content.expires }
}

/**
 * Run the command.
 * @param argv - the arguments after the script.
 * @returns the exit code once the server stops: 1 when the command refused to start.
 */
export async function main(argv: readonly string[]): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        'channel': { type: 'string' },
        'port': { type: 'string' },
        'host': { type: 'string', default: '127.0.0.1' },
        'state': { type: 'string' },
        'timestamp-key': { type: 'string' },
        'resign-hours': { type: 'string', default: '24' },
      },
    })
    if (positionals.length !== 1 || positionals[0] !== 'serve') throw new Error('the one command is `serve`')
    if (values.channel === undefined || values.port === undefined || values.state === undefined || values['timestamp-key'] === undefined) {
      throw new Error('pass --channel, --port, --state and --timestamp-key')
    }
    const port = Number(values.port)
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port ${values.port} is not a port`)
    const hours = Number(values['resign-hours'])
    if (!Number.isFinite(hours) || hours <= 0 || hours > 48) throw new Error(`--resign-hours ${values['resign-hours']} is not between 0 and 48; the timestamp lives 72 hours`)
    const key = createPrivateKey(await readFile(resolve(values['timestamp-key'])))
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('--timestamp-key is not an Ed25519 key')
    const log = (line: string): void => console.log(`${new Date().toISOString()} local-channel: ${line}`)
    const channel = resolve(values.channel)
    const resign = async (): Promise<void> => {
      try {
        const result = await resignChannel({ channel, state: resolve(values.state!), key, now: Math.floor(Date.now() / 1000) })
        log(`re-signed timestamp.json: version ${String(result.version)}, expires ${result.expires}`)
      } catch (error) {
        log(`re-signing failed, the old timestamp.json stays: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    await resign()
    const { server, port: bound } = await serveChannel({ channel, port, host: values.host, log })
    log(`serving ${channel} on http://${values.host}:${String(bound)}`)
    const timer = setInterval(() => void resign(), hours * 3600 * 1000)
    await new Promise<void>((done) => {
      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.once(signal, () => {
          clearInterval(timer)
          server.close(() => done())
        })
      }
    })
    return 0
  } catch (error) {
    console.error(`local-channel: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
