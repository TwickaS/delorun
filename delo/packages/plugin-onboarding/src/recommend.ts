/**
 * The host half of the guide's plugin recommendations: the {@link RECOMMEND_PATH} route reads, for each package the
 * row's `plugins` list names, which connections the package says it is for. A package declares them in its own
 * `package.json` as `"delo": { "connections": ["agent:codex"] }`; that field is the one place the mapping lives. An
 * installed package is read from disk; one that is not installed is read from the npm registry only when the person
 * asks, which is this route's only network request; a package neither can be read for has `unknown` connections.
 * @module @delo/plugin-onboarding/recommend
 */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { z } from 'zod'
import { CONNECTION_ID, type RecommendAnswer } from './wire.ts'

/** The fields of a manifest the route reads; anything else in it is ignored. */
const Declared = z.object({ delo: z.object({ connections: z.array(z.string().regex(CONNECTION_ID)).max(16).optional() }).optional() })

/** The largest manifest read, from disk or the registry. */
const MAX_MANIFEST_BYTES = 512 * 1024

/** What the route reads with. */
export interface RecommendDeps {
  /**
   * Read an installed package's manifest.
   * @param name - the package.
   * @returns the parsed manifest, or undefined when it is not installed or cannot be read.
   */
  readonly installed: (name: string) => Promise<unknown>
  /**
   * Read a package's latest manifest from the registry.
   * @param name - the package.
   * @param signal - the deadline.
   * @returns the parsed manifest, or undefined when the registry answered that it has no such package.
   * @throws when the registry cannot be reached or answers anything else.
   */
  readonly registry: (name: string, signal: AbortSignal) => Promise<unknown>
  /** The most time the registry requests may take together, in milliseconds. */
  readonly timeoutMs: number
}

/**
 * Read the connections a package's manifest declares in `delo.connections`.
 * @param manifest - a parsed manifest.
 * @returns the connections it declares, empty when it declares none, or undefined when the field is malformed.
 */
export function declaredConnections(manifest: unknown): readonly string[] | undefined {
  const parsed = Declared.safeParse(manifest)
  return parsed.success ? parsed.data.delo?.connections ?? [] : undefined
}

/**
 * Read which connections each package is for.
 * @param names - the packages, in the row's order.
 * @param askRegistry - whether the person asked to read packages that are not installed from the registry.
 * @param deps - the readers.
 * @returns each package's connections and where they were read, and whether the registry answered.
 */
export async function recommend(names: readonly string[], askRegistry: boolean, deps: RecommendDeps): Promise<RecommendAnswer> {
  const signal = AbortSignal.timeout(deps.timeoutMs)
  let reached: boolean | undefined
  const plugins = await Promise.all(names.map(async (name): Promise<RecommendAnswer['plugins'][number]> => {
    const manifest = await deps.installed(name)
    const local = manifest === undefined ? undefined : declaredConnections(manifest)
    if (local !== undefined) return { name, connections: [...local], source: 'installed' }
    if (!askRegistry) return { name, connections: [], source: 'unknown' }
    try {
      const manifest = await deps.registry(name, signal)
      reached = reached ?? true
      const remote = manifest === undefined ? undefined : declaredConnections(manifest)
      return remote === undefined ? { name, connections: [], source: 'unknown' } : { name, connections: [...remote], source: 'registry' }
    } catch (_unreachable) {
      // The registry is optional: the studio says it could not be reached and shows what it knows.
      reached = false
      return { name, connections: [], source: 'unknown' }
    }
  }))
  return { plugins, registry: !askRegistry ? 'not-asked' : reached === false ? 'unreachable' : 'reached' }
}

/**
 * Read an installed package's manifest from where the harness resolves packages: the profile's directory first, then
 * the installation.
 * @param profileDirectory - the CLI profile's directory, when the harness runs one.
 * @param installationAnchor - a file of the installation to resolve from.
 * @returns the reader.
 */
export function installedReader(profileDirectory: string | undefined, installationAnchor: string): RecommendDeps['installed'] {
  const resolvers = [...profileDirectory === undefined ? [] : [createRequire(join(profileDirectory, 'package.json'))], createRequire(installationAnchor)]
  return async (name) => {
    for (const resolver of resolvers) {
      let path: string
      try {
        path = resolver.resolve(`${name}/package.json`)
      } catch (_notHere) {
        // Not resolvable from this place, or the package does not export its manifest; try the next.
        continue
      }
      try {
        const text = await readFile(path, 'utf8')
        if (text.length <= MAX_MANIFEST_BYTES) {
          const manifest: unknown = JSON.parse(text)
          return manifest
        }
      } catch (_unreadable) {
        // A manifest that cannot be read is treated as not installed.
      }
    }
    return undefined
  }
}

/**
 * Read a package's latest manifest from an npm registry.
 * @param registryUrl - the registry's address, such as `https://registry.npmjs.org`.
 * @returns the reader; it refuses redirects and a body over the limit, and reads a 404 as a package the registry does
 * not have.
 */
export function registryReader(registryUrl: string): RecommendDeps['registry'] {
  return async (name, signal) => {
    const response = await fetch(`${registryUrl.replace(/\/+$/u, '')}/${name.replace('/', '%2f')}/latest`, { redirect: 'error', signal, headers: { accept: 'application/json' } })
    if (response.status === 404) return undefined
    if (!response.ok) throw new Error(`the registry answered HTTP ${String(response.status)}`)
    const text = await response.text()
    if (text.length > MAX_MANIFEST_BYTES) throw new Error('the registry answered more than a manifest')
    const manifest: unknown = JSON.parse(text)
    return manifest
  }
}
