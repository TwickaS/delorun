/**
 * Fixtures of the install check's specs: a profile directory with a hand-written pnpm lockfile and hoisted
 * `node_modules`, and a loopback stand-in for npm's bulk advisory API and the registry's package documents. No real
 * registry or feed is contacted.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { runtimeMode, tarStream } from '@delo/release-formats/archive/tar'
import type { InstallCheckSettings } from '../src/check.ts'

/** One package of a fixture profile. */
export interface FixturePackage {
  readonly name: string
  readonly version: string
  /** The lockfile resolution, as YAML flow text. */
  readonly resolution?: string
  /** The `packages` key's version or source, when it is not `version`. */
  readonly source?: string
  /** Its dependencies, by name and reference. */
  readonly dependencies?: Readonly<Record<string, string>>
  /** Whether the profile depends on it directly. */
  readonly direct?: boolean
  /** Its files besides `package.json`. */
  readonly files?: Readonly<Record<string, string>>
}

/** A good integrity value; the check reads only whether one is there. */
export const INTEGRITY = 'sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng=='

/**
 * Write a profile with these packages installed.
 * @param packages - the packages; each lies at `node_modules/<name>`.
 * @returns the profile directory, real path.
 */
export function writeProfile(packages: readonly FixturePackage[]): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'install-check-')))
  writeProfileFiles(dir, packages)
  return dir
}

/**
 * Write a profile's files over an existing directory.
 * @param dir - the profile directory.
 * @param packages - the packages.
 * @param options - `installed: false` writes the manifest and the lockfile only, as pnpm's `--lockfile-only` leaves them.
 */
export function writeProfileFiles(dir: string, packages: readonly FixturePackage[], options: { readonly installed?: boolean } = {}): void {
  const keyOf = (pkg: FixturePackage): string => `${pkg.name}@${pkg.source ?? pkg.version}`
  const direct = packages.filter(pkg => pkg.direct === true)
  const lines = ['lockfileVersion: \'9.0\'', '', 'importers:', '', '  .:', '    dependencies:']
  for (const pkg of direct) lines.push(`      '${pkg.name}':`, `        specifier: ${pkg.source ?? pkg.version}`, `        version: ${pkg.source ?? pkg.version}`)
  lines.push('', 'packages:', '')
  for (const pkg of packages) {
    if (pkg.source?.startsWith('link:') === true) continue
    lines.push(`  '${keyOf(pkg)}':`, `    resolution: ${pkg.resolution ?? `{integrity: ${INTEGRITY}}`}`, '')
  }
  lines.push('snapshots:', '')
  for (const pkg of packages) {
    if (pkg.source?.startsWith('link:') === true) continue
    lines.push(`  '${keyOf(pkg)}':${pkg.dependencies === undefined ? ' {}' : ''}`)
    if (pkg.dependencies !== undefined) {
      lines.push('    dependencies:')
      for (const [name, reference] of Object.entries(pkg.dependencies)) lines.push(`      '${name}': ${reference}`)
    }
    lines.push('')
  }
  writeFileSync(join(dir, 'pnpm-lock.yaml'), `${lines.join('\n')}\n`)
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'profile', private: true, dependencies: Object.fromEntries(direct.map(pkg => [pkg.name, pkg.source ?? pkg.version])) })}\n`)
  for (const pkg of packages) {
    if (pkg.source?.startsWith('link:') === true || options.installed === false) continue
    const pkgDir = join(dir, 'node_modules', ...pkg.name.split('/'))
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), `${JSON.stringify({ name: pkg.name, version: pkg.version })}\n`)
    for (const [file, text] of Object.entries(pkg.files ?? { 'index.js': `export default ${JSON.stringify(pkg.name)}\n` })) {
      mkdirSync(join(pkgDir, file, '..'), { recursive: true })
      writeFileSync(join(pkgDir, file), text)
    }
  }
}

/**
 * Remove a fixture directory.
 * @param dir - the directory.
 */
export function removeProfile(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

/** A package the stand-in registry serves, with its tarball. */
export interface PublishedPackage {
  readonly version: string
  /** Its files besides `package.json`, by path. */
  readonly files: Readonly<Record<string, string>>
  /** Its `package.json` scripts. */
  readonly scripts?: Readonly<Record<string, string>>
}

/** What the stand-in answers. */
export interface StandInAnswers {
  /** The bulk advisory answer, or a status to answer with instead. */
  advisories: Record<string, unknown> | number
  /** Per package name, its publish times by version; a name without one answers 404. */
  times: Record<string, Record<string, string>>
  /** Per package name, the integrity its document lists by version under `versions[v].dist`. */
  integrities?: Record<string, Record<string, string>>
  /** Packages served with their tarballs, as a registry pnpm installs from serves them. */
  packages?: Record<string, PublishedPackage>
}

/**
 * A published package's tarball, as `npm pack` lays it out under `package/`.
 * @param name - the package's name.
 * @param published - the package.
 * @returns the gzipped tarball.
 */
export async function packTarball(name: string, published: PublishedPackage): Promise<Buffer> {
  const manifest = { name, version: published.version, ...published.scripts === undefined ? {} : { scripts: published.scripts } }
  const entries = [['package.json', `${JSON.stringify(manifest)}\n`] as const, ...Object.entries(published.files)]
    .map(([path, text]) => ({ path: `package/${path}`, mode: runtimeMode(0o644)!, data: Buffer.from(text) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const chunks: Buffer[] = []
  for await (const chunk of tarStream(entries, 0)) chunks.push(chunk)
  return gzipSync(Buffer.concat(chunks))
}

/** A running stand-in. */
export interface StandIn {
  readonly answers: StandInAnswers
  /** The bodies the advisory endpoint received. */
  readonly advisoryRequests: unknown[]
  /** The package documents asked for. */
  readonly documents: string[]
  readonly feed: string
  readonly registry: string
  close(): Promise<void>
}

/**
 * Start a loopback stand-in for the advisory feed and the registry.
 * @param answers - what it answers; mutable while it runs.
 * @returns the stand-in.
 */
export async function startStandIn(answers: StandInAnswers): Promise<StandIn> {
  const advisoryRequests: unknown[] = []
  const documents: string[] = []
  const server: Server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString() })
    request.on('end', () => {
      if (request.url === '/advisories') {
        advisoryRequests.push(JSON.parse(body))
        if (typeof answers.advisories === 'number') {
          response.writeHead(answers.advisories).end()
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answers.advisories))
        return
      }
      const path = decodeURIComponent((request.url ?? '').slice('/registry/'.length))
      const tarball = /^(.+)\/-\/[^/]+\.tgz$/u.exec(path)
      if (tarball !== null && answers.packages?.[tarball[1]!] !== undefined) {
        void packTarball(tarball[1]!, answers.packages[tarball[1]!]!).then((bytes) => { response.writeHead(200).end(bytes) }, () => { response.writeHead(500).end() })
        return
      }
      const name = path
      documents.push(name)
      const published = answers.packages?.[name]
      if (published !== undefined) {
        void packTarball(name, published).then((bytes) => {
          const { port } = server.address() as AddressInfo
          const url = `http://127.0.0.1:${String(port)}/registry/${name}/-/${name.split('/').at(-1)!}-${published.version}.tgz`
          const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
          const version = { name, version: published.version, ...published.scripts === undefined ? {} : { scripts: published.scripts }, dist: { tarball: url, integrity } }
          response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ name, 'dist-tags': { latest: published.version }, versions: { [published.version]: version }, time: answers.times[name] ?? {} }))
        }, () => { response.writeHead(500).end() })
        return
      }
      const time = answers.times[name]
      if (time === undefined) {
        response.writeHead(404).end()
        return
      }
      const versions = Object.fromEntries(Object.entries(answers.integrities?.[name] ?? {}).map(([version, integrity]) => [version, { name, version, dist: { integrity } }]))
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ name, time, versions }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    answers, advisoryRequests, documents,
    feed: `http://127.0.0.1:${String(port)}/advisories`,
    registry: `http://127.0.0.1:${String(port)}/registry/`,
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve() }) }),
  }
}

/**
 * The check's settings against a stand-in.
 * @param standIn - the stand-in.
 * @param overrides - settings to change.
 * @returns the settings.
 */
export function settingsFor(standIn: Pick<StandIn, 'feed' | 'registry'>, overrides: Partial<InstallCheckSettings> = {}): InstallCheckSettings {
  return {
    advisoryFeed: standIn.feed, registry: standIn.registry, minimumAgeHours: 24, similarNameDistance: 1, similarNameMinLength: 4,
    requestTimeoutMs: 5000, requestConcurrency: 4, metadataMaxBytes: 1024 * 1024, maxFiles: 1000, trustedSources: [], ...overrides,
  }
}

/** A publish time well past the minimum age. */
export const OLD = '2020-01-01T00:00:00.000Z'

/**
 * One advisory as the bulk feed answers it.
 * @param id - the GHSA id.
 * @param severity - its severity.
 * @param range - the vulnerable range.
 * @returns the advisory.
 */
export function advisory(id: string, severity: string, range: string): Record<string, unknown> {
  return { url: `https://github.com/advisories/${id}`, title: `A flaw in the package (${id})`, severity, vulnerable_versions: range }
}
