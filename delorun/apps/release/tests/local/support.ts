/**
 * Fixtures for the local release specs: throwaway keys and a root over them that lists a stand-in log and witness, the
 * stand-in log served over HTTP, a runtime closure fixture archived by the release tooling's own writer, and a static
 * server for a channel directory. Every key is generated in the spec and removed with its temporary directory.
 */
import { execFile } from 'node:child_process'
import { createReadStream, existsSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { TestContext } from 'vitest'
import type { KeyObject } from 'node:crypto'
import type { RuntimePlatform } from '@delorun/contract-release-manifest'
import { archiveClosure } from '../../src/closure/archive-closure.ts'
import { stampDelorunVersion } from '../../src/closure/delorun.ts'
import { readEntryRequest } from '@delorun/release-formats/log/entry'
import type { LogEndpoints } from '../../src/log/client.ts'
import { rootFile, throwawayKeys, type Keys } from '../sign/fixture.ts'
import { EntryTypeRefused, LogStandIn, WitnessStandIn } from '../log/standin.ts'
import { REPO, scratch, writeTree, type RunResult } from '../support.ts'

/**
 * Registers a cleanup that runs when its owner ends: a Vitest test context, or a benchmark run of
 * `@delorun/benchmarks`, which reuses these fixtures.
 */
export interface CleanupScope {
  /**
   * Run a function when the owner ends.
   * @param fn - the cleanup.
   */
  onTestFinished(fn: () => void | Promise<void>): void
}

/** Throwaway keys of every role, the stand-in log and witness, and the root that lists them. */
export interface Trust {
  readonly keys: Keys
  readonly log: LogStandIn
  readonly witness: WitnessStandIn
  /** The signed root file, version 1. */
  readonly root: Buffer
}

/**
 * New throwaway keys and a root over them.
 * @returns the trust fixture.
 */
export function trust(): Trust {
  const keys = throwawayKeys()
  const log = new LogStandIn()
  const witness = new WitnessStandIn()
  const root = rootFile(keys, { log: { origin: log.origin, vkey: log.vkey }, witnesses: { keys: [{ name: witness.name, vkey: witness.vkey }], threshold: 1 } }).bytes
  return { keys, log, witness, root }
}

/**
 * Write a private key as the PKCS #8 PEM file the signing tools read, readable by its owner only.
 * @param directory - where to write it.
 * @param name - the file's name.
 * @param key - the key.
 * @returns the file's path.
 */
export function keyFile(directory: string, name: string, key: KeyObject): string {
  const path = join(directory, name)
  writeFileSync(path, key.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
  return path
}

/** What a served stand-in log changes from answering every request as the log does. */
export interface ServeLogOptions {
  /** How many checkpoint requests the log answers before its witness has cosigned. */
  readonly uncosignedPolls?: number
  /** A fixed answer to an entry submission of the given key details, in place of the log's; `undefined` lets the log answer. */
  readonly answer?: (keyDetails: string) => { readonly status: number, readonly body: string } | undefined
}

/**
 * Serve a stand-in log over HTTP, as Rekor v2 and its checkpoint distributor answer `log-release.ts`.
 * @param test - the running test.
 * @param trusted - the log and witness to serve.
 * @param options - how many checkpoint requests the log answers before its witness has cosigned, and fixed answers to
 *   entry submissions.
 * @returns the log's origin and the endpoints `log-release.ts` takes.
 */
export async function serveLog(test: CleanupScope, trusted: Trust, options: ServeLogOptions = {}): Promise<{ readonly origin: string, readonly endpoints: LogEndpoints }> {
  let polls = 0
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://stand-in')
      if (url.pathname === '/api/v2/log/entries') {
        const parsed = readEntryRequest(Buffer.concat(chunks))
        const forced = options.answer?.(parsed.hashedRekordRequestV002.signature.verifier.keyDetails)
        if (forced !== undefined) {
          trusted.log.submitted.push(parsed.hashedRekordRequestV002.signature.verifier.keyDetails)
          response.writeHead(forced.status, { 'content-type': 'application/json' })
          response.end(forced.body)
          return
        }
        let logIndex: number
        try {
          logIndex = trusted.log.submit(parsed)
        } catch (error) {
          if (!(error instanceof EntryTypeRefused)) throw error
          response.writeHead(400, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ code: 3, message: 'invalid hashedrekord request', details: [] }))
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ...(logIndex === 0 ? {} : { logIndex: String(logIndex) }), kindVersion: { kind: 'hashedrekord', version: '0.0.2' }, canonicalizedBody: trusted.log.body(logIndex).toString('base64') }))
      } else if (url.pathname === '/checkpoint') {
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        polls++
        response.end(polls <= (options.uncosignedPolls ?? 0) ? trusted.log.checkpoint() : trusted.witness.cosign(trusted.log.checkpoint(), Math.floor(Date.now() / 1000)))
      } else {
        // `/tiles/` is the prefix the release workflow's client reads below; `/tile/` is where a launcher reads tlog-tiles.
        const tile = url.pathname.startsWith('/tiles/') ? trusted.log.tile(url.pathname.slice('/tiles/'.length)) : url.pathname.startsWith('/tile/') ? trusted.log.tile(url.pathname.slice(1)) : undefined
        response.writeHead(tile === undefined ? 404 : 200, { 'content-type': 'application/octet-stream' })
        response.end(tile)
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  test.onTestFinished(() => new Promise<void>(resolve => server.close(() => resolve())))
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  return { origin, endpoints: { submit: `${origin}/api/v2/log/entries`, checkpoint: `${origin}/checkpoint`, tiles: `${origin}/tiles/` } }
}

/**
 * A port that nothing listens on.
 * @returns the port.
 */
export async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}

/**
 * Serve a directory of files read-only, as GitHub Pages and GitHub Releases serve a channel.
 * @param test - the running test.
 * @param directory - the directory to serve, or a function that names it at each request, so one origin can serve
 *   one channel after another.
 * @returns the server's origin.
 */
export async function serveChannel(test: CleanupScope, directory: string | (() => string)): Promise<string> {
  const server = createServer((request, response) => {
    const root = typeof directory === 'string' ? directory : directory()
    const path = join(root, new URL(request.url ?? '/', 'http://stand-in').pathname)
    if (!path.startsWith(root) || !existsSync(path) || !statSync(path).isFile()) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'content-length': statSync(path).size })
    createReadStream(path).pipe(response)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  test.onTestFinished(() => new Promise<void>(resolve => server.close(() => resolve())))
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
}

/** The fixture runtime's entry file: prints the version its own package carries, as `delorun --version` does. */
const ENTRY = `import { readFileSync } from 'node:fs'
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
if (process.argv[2] === '--version') process.stdout.write('Delorun ' + version + '\\n')
else process.stdout.write('arguments: ' + JSON.stringify(process.argv.slice(2)) + '\\n')
`

/**
 * Write the files of a fixture closure the way `build-closure.ts` leaves them, for Linux x64 or each platform named:
 * the runtime's own Node (a script that hands over to the Node running the spec, so the archive stays small), the
 * `delorun` entry file with the release's version stamped into its package, and the archive with its unsigned file list.
 * @param test - the running test.
 * @param version - the release version.
 * @param change - `entrySuffix`, text added to the entry file, so two closures of one version differ by it, and
 *   `platforms`, the platforms to write.
 * @returns a function that writes two files per platform into a directory, for `LocalReleaseRequest.closures`.
 */
export function fixtureClosure(test: TestContext, version: string, change: { readonly entrySuffix?: string, readonly platforms?: readonly RuntimePlatform[] } = {}): (directory: string) => Promise<void> {
  return async (directory) => {
    for (const platform of change.platforms ?? ['linux-x64']) await fixturePlatformClosure(test, version, platform, change.entrySuffix ?? '', directory)
  }
}

async function fixturePlatformClosure(test: TestContext, version: string, platform: RuntimePlatform, entrySuffix: string, directory: string): Promise<void> {
  const stage = join(scratch(test), 'stage')
  writeTree(stage, {
    [platform === 'win32-x64' ? 'node/node.exe' : 'node/bin/node']: { data: `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, executable: true },
    'app/node_modules/@delorun/cli/package.json': '{"name":"@delorun/cli","version":"0.0.0","type":"module"}\n',
    'app/node_modules/@delorun/cli/src/bin.js': `${ENTRY}${entrySuffix}`,
  })
  await stampDelorunVersion(join(stage, 'app', 'node_modules'), version)
  await archiveClosure({ stage, outDir: directory, version, platform, epoch: 1_793_981_656, pins: undefined, requireLaunchFiles: true })
}

/**
 * Run a release entry point without blocking this process, so a stand-in server in the same process can answer it.
 * @param entry - the path under `delorun/apps/release/src/`.
 * @param args - its arguments.
 * @returns its exit status and output.
 */
export function runEntryAsync(entry: string, args: readonly string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(join(REPO, 'node_modules/.bin/tsx'), [join(REPO, 'delorun/apps/release/src', entry), ...args], { cwd: REPO, env: { ...process.env, CI: '', GITHUB_ACTIONS: '' } }, (error, stdout, stderr) => {
      resolve({ status: error === null ? 0 : typeof error.code === 'number' ? error.code : null, stdout, stderr })
    })
  })
}
