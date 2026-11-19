/**
 * The packs a release offers this computer, read from its release channel as a client reads them: the root chain under
 * `root/`, the release's manifest under that chain's newest root, and the release's packs file, which must be signed by
 * a targets key and bound to that manifest. The release-log record of the packs file is not checked here: the cut's
 * channel verification and the installed runner each check it.
 *
 * @module @delorun/release/installed-smoke/offered-packs
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PackEntry, RuntimePlatform } from '@delorun/contract-release-manifest'
import { packsName } from '@delorun/release-formats/log/bundle'
import { trustRootChain, verifyPacks } from '@delorun/release-formats/sign/verify'

/** Reads the files of a release channel by their path below the channel's root. */
export interface ChannelSource {
  /** The directory or origin, for messages. */
  readonly label: string
  /**
   * Read one file.
   * @param path - the path below the channel, such as `root/1.root.json`.
   * @returns its bytes, or `undefined` when the channel has no such file.
   * @throws Error when the file exists but cannot be read.
   */
  read(path: string): Promise<Uint8Array | undefined>
}

/** The most root files the reader asks for: a channel's chain never comes near it. */
const MAX_ROOTS = 64

/**
 * A channel source over a directory or an `http(s)` origin.
 * @param channel - a directory, or an origin such as `http://127.0.0.1:18431`.
 * @returns the source.
 */
export function channelSource(channel: string): ChannelSource {
  if (/^https?:\/\//u.test(channel)) {
    const origin = channel.replace(/\/+$/u, '')
    return {
      label: origin,
      async read(path) {
        const response = await fetch(`${origin}/${path}`, { redirect: 'error', signal: AbortSignal.timeout(60_000) })
        if (response.status === 404) return undefined
        if (!response.ok) throw new Error(`${origin}/${path} answered HTTP ${String(response.status)}`)
        return new Uint8Array(await response.arrayBuffer())
      },
    }
  }
  return {
    label: channel,
    async read(path) {
      try {
        return await readFile(join(channel, ...path.split('/')))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
    },
  }
}

/** What {@link packsForPlatform} reads of a pack entry: its name and which platforms its variants are for. */
export type PackPlatforms = Pick<PackEntry, 'name'> & { readonly variants: Readonly<Partial<Record<RuntimePlatform | 'any', unknown>>> }

/**
 * The packs of a packs file that install on a platform: those with a variant for it or for `any`.
 * @param packs - the packs file's entries.
 * @param platform - the platform.
 * @returns their names, sorted.
 */
export function packsForPlatform(packs: readonly PackPlatforms[], platform: RuntimePlatform): string[] {
  return packs.filter(pack => pack.variants[platform] !== undefined || pack.variants.any !== undefined).map(pack => pack.name).sort()
}

/**
 * The packs a release offers a platform, from its verified packs file.
 * @param source - the channel.
 * @param version - the release.
 * @param platform - the platform.
 * @param now - the clock in Unix seconds, for the root's expiry.
 * @returns the pack names, sorted; empty when the release publishes no packs file.
 * @throws Error when the channel has no root or no manifest for the release, or a signature or binding check fails.
 */
export async function offeredPacks(source: ChannelSource, version: string, platform: RuntimePlatform, now: number): Promise<string[]> {
  const roots: Uint8Array[] = []
  for (let index = 1; index <= MAX_ROOTS; index++) {
    const bytes = await source.read(`root/${String(index)}.root.json`)
    if (bytes === undefined) break
    roots.push(bytes)
  }
  if (roots.length === 0) throw new Error(`${source.label} has no root/1.root.json`)
  const root = trustRootChain(roots, now).at(-1)!
  const directory = `releases/download/v${version}`
  const manifest = await source.read(`${directory}/delorun-${version}.manifest.json`)
  if (manifest === undefined) throw new Error(`${source.label} has no manifest for ${version}`)
  const packs = await source.read(`${directory}/${packsName(version)}`)
  if (packs === undefined) return []
  return packsForPlatform(verifyPacks(root.metadata, manifest, packs).packs, platform)
}
