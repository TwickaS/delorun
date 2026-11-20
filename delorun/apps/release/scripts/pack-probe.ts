/**
 * Build one plugin pack from a source tree with the release's own pack step, `pnpm deploy` included, and without signing
 * anything, to see what the pack holds before a release cut: the pack's metadata files and archive digests are written
 * to `--out`. Run it from two source trees (two copies of one commit) with different `--scratch` folders and compare
 * the digests: a pack that names the build's folders, or holds a timestamp, differs between them.
 *
 * `tsx delorun/apps/release/scripts/pack-probe.ts --source <tree> --scratch <empty dir> --out <empty dir> --name <package>
 * --stage <dir> [--platform linux-x64] [--version 0.0.0-probe] [--epoch 1800000000]`
 *
 * The tree must have its dependencies installed and its packages built, as a release's exported tree has. `--stage` is
 * the directory whose `<platform>/app` holds the runtime closure's deployment, which the pack step reads to link peers:
 * run `pnpm --filter @delorun/runtime-closure deploy --prod --ignore-scripts --os=linux --cpu=x64 --libc=glibc
 * --config.node-linker=hoisted --config.package-import-method=copy --config.link-workspace-packages=true
 * --config.hoist-workspace-packages=false <stage>/linux-x64/app` in the tree. The build refuses a pack whose metadata names a machine path
 * (`closure/pack-specifiers.ts`) and the probe lets that error stand. Nothing is signed and no key is read.
 *
 * @module pack-probe
 */
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { type RuntimePlatform } from '@delorun/contract-release-manifest'
import { isRuntimePlatform, TARGETS } from '../src/build-closure.ts'
import { buildPack, releasePackSources } from '../src/closure/packs.ts'
import { readWorkspacePackages } from '../src/closure/plugin-set.ts'

const { values } = parseArgs({ options: { source: { type: 'string' }, scratch: { type: 'string' }, out: { type: 'string' }, name: { type: 'string' }, stage: { type: 'string' }, platform: { type: 'string', default: 'linux-x64' }, version: { type: 'string', default: '0.0.0-probe' }, epoch: { type: 'string', default: '1800000000' } } })
const { source, scratch, out, name, stage } = values
if (source === undefined || scratch === undefined || out === undefined || name === undefined || stage === undefined) throw new Error('pack-probe needs --source, --scratch, --out, --name and --stage')
const platform = values.platform!
if (!isRuntimePlatform(platform)) throw new Error(`${platform} is not a runtime platform`)
const packages = readWorkspacePackages(source)
const found = packages.find(each => each.name === name)
if (found === undefined) throw new Error(`${name} is not a workspace package of ${source}`)
for (const folder of [scratch, out]) {
  await mkdir(folder, { recursive: true })
  if ((await readdir(folder)).length > 0) throw new Error(`${folder} is not empty`)
}
const closureRecipe = JSON.parse(await readFile(join(import.meta.dirname, '../closure.json'), 'utf8')) as { packExternals: string[] }
const manifest = JSON.parse(await readFile(join(source, found.dir, 'package.json'), 'utf8')) as { version: string }
const sources = releasePackSources({ source, env: process.env, targets: TARGETS, stage: (each: RuntimePlatform) => join(stage, each) }, packages, await readFile(join(source, 'pnpm-lock.yaml'), 'utf8'))
const deployments = join(scratch, 'deployments')
await mkdir(deployments)
const built = await buildPack(name, manifest.version, found.dir.startsWith('packages/experimental/'), values.version!, [platform], Number(values.epoch), closureRecipe.packExternals, sources, deployments)
for (const [file, bytes] of built.archives) {
  await writeFile(join(out, file), bytes)
  console.log(`pack-probe: ${file} ${String(bytes.length)} bytes sha256 ${createHash('sha256').update(bytes).digest('hex')}`)
}
await writeFile(join(out, 'entry.json'), `${JSON.stringify(built.entry, null, 2)}\n`)
await writeFile(join(out, 'package.json.copy'), await readFile(join(deployments, `${name.replaceAll('/', '__')}-${platform}`, 'package.json')))
await writeFile(join(out, 'pnpm-lock.yaml.copy'), await readFile(join(deployments, `${name.replaceAll('/', '__')}-${platform}`, 'pnpm-lock.yaml')))
console.log(`pack-probe: wrote ${join(out, 'entry.json')}, package.json.copy and pnpm-lock.yaml.copy`)
