/**
 * The import check of a built release's packs: `node_modules/.bin/tsx delorun/apps/release/src/check-pack-imports.ts
 * <release directory> <runtime app/node_modules> <platform>` reads `delorun-<version>.packs.json` in the release
 * directory without checking its signatures, extracts each pack's archive for the platform into a temporary directory,
 * and reports each package name a pack needs that neither the pack carries, links as a peer nor fetches, or that the
 * needing package does not declare in its `package.json`, so Changes' review copy of the pack leaves it out; each peer
 * the runtime does not carry; and each copy of a package that must exist once nested inside another package. With
 * `--link-carried` it first links, as peers, the needs the runtime carries at a version they accept, with the function
 * the cut uses (`linkCarriedNeeds`), and reports what is left. It is a report on a release already built: the cut's own
 * refusal in `buildPack` is the gate. It exits 0 when every pack loads, 1 with one line per problem, and 2 on a usage error or a
 * file it cannot read.
 *
 * @module @delorun/release/check-pack-imports
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { RUNTIME_PLATFORMS, type PackEntry, type ReleasePacks, type RuntimePlatform } from '@delorun/contract-release-manifest'
import { extractPack } from '@delorun/release-formats/packs/archive'
import { describeUnresolved, linkCarriedNeeds, nestedSingleCopies, resolvesInPack, unresolvedPackImports } from './closure/pack-imports.ts'
import { keepsOneCopy } from './closure/packs.ts'

/**
 * The problems of one pack variant extracted at `directory`.
 * @param entry - the pack's entry.
 * @param platform - the platform checked.
 * @param directory - the extracted package directory.
 * @param runtimeNodeModules - the runtime's `app/node_modules`.
 * @param linkCarried - whether to link each need the runtime carries as a peer first, as the cut does.
 * @returns one line per problem.
 */
export async function packProblemsAt(entry: PackEntry, platform: RuntimePlatform, directory: string, runtimeNodeModules: string, linkCarried = false): Promise<string[]> {
  const variant = entry.variants[platform] ?? entry.variants.any
  if (variant === undefined) return []
  const paths = new Set(variant.files.map(file => file.path))
  const read = (path: string): Promise<string> => readFile(join(directory, ...path.split('/')), 'utf8')
  const problems = variant.peers.filter(peer => !existsSync(join(runtimeNodeModules, ...peer.split('/'), 'package.json'))).map(peer => `${entry.name}: the peer ${peer} is not in the runtime`)
  const rootPeers = new Set(Object.keys((JSON.parse(await read('package.json')) as { peerDependencies?: Record<string, string> }).peerDependencies ?? {}))
  const externals = variant.external.map(pin => pin.name)
  for (const copy of nestedSingleCopies(paths, name => keepsOneCopy(name, rootPeers, externals))) problems.push(`${entry.name}: a second copy of a package that must exist once, nested at ${copy}`)
  const layout = { paths, read, peers: new Set(variant.peers), external: new Set(externals) }
  const unmet = linkCarried
    ? [
        ...await linkCarriedNeeds(layout, async (name) => {
          const manifest = join(runtimeNodeModules, ...name.split('/'), 'package.json')
          return existsSync(manifest) ? (JSON.parse(await readFile(manifest, 'utf8')) as { version?: string }).version : undefined
        }),
        // linkCarriedNeeds reports what the installed pack cannot resolve; what resolves there but is undeclared is added here.
        ...(await unresolvedPackImports(layout)).filter(need => resolvesInPack(need, layout)).map(describeUnresolved),
      ]
    : (await unresolvedPackImports(layout)).map(describeUnresolved)
  return [...problems, ...unmet.map(line => `${entry.name}: ${line}`)]
}

async function main(argv: readonly string[]): Promise<number> {
  const { positionals, values } = parseArgs({ args: [...argv], allowPositionals: true, strict: true, options: { 'link-carried': { type: 'boolean', default: false } } })
  if (positionals.length !== 3) {
    console.error('check-pack-imports: pass the release directory, the runtime\'s app/node_modules and the platform')
    return 2
  }
  const [release, runtimeNodeModules, platformText] = positionals as [string, string, string]
  const platform = RUNTIME_PLATFORMS.find(each => each === platformText)
  if (platform === undefined) {
    console.error(`check-pack-imports: the platform is one of ${RUNTIME_PLATFORMS.join(', ')}`)
    return 2
  }
  let problems: string[] = []
  const scratch = await mkdtemp(join(tmpdir(), 'delorun-pack-imports-'))
  try {
    const packsFile = (await readdir(release)).find(file => file.endsWith('.packs.json'))
    if (packsFile === undefined) throw new Error(`${release} holds no .packs.json`)
    const packs = (JSON.parse(await readFile(join(release, packsFile), 'utf8')) as { signed: ReleasePacks }).signed
    for (const entry of packs.packs) {
      const variant = entry.variants[platform] ?? entry.variants.any
      if (variant === undefined) {
        console.log(`${entry.name}: no variant for ${platform}`)
        continue
      }
      const directory = join(scratch, entry.name.replaceAll('/', '__'))
      await mkdir(directory, { mode: 0o700 })
      await extractPack(await readFile(join(release, variant.archive.name)), variant, directory)
      const found = await packProblemsAt(entry, platform, directory, runtimeNodeModules, values['link-carried'])
      console.log(`${entry.name}: ${found.length === 0 ? 'every import resolves' : `${String(found.length)} problems`}`)
      problems = [...problems, ...found]
    }
  } catch (error) {
    console.error(`check-pack-imports: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
  for (const line of problems) console.log(line)
  return problems.length === 0 ? 0 : 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
