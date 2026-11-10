/**
 * The tree the check runner plans over: Delo's packages under `delo/apps` and `delo/packages` with their tsconfig
 * programs, and upstream's packages under `packages/<group>` and `apps` with their dependencies, spec counts and
 * `security` ledger marks. The runner and the batch tool both read it here.
 *
 * @module @delo/tools/checks/tree
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { MANIFEST_PATH, parseManifest } from '../fork-boundary.ts'
import { declaredBuildOutputs, JOURNEY_SPEC, withSecurityPackages, type ForkPackage, type ForkTree, type Program, type UpstreamPackage } from './plan.ts'
import { readWebSpecs } from './web.ts'

/** The `package.json` fields the tree reading uses. */
const ManifestSchema = z.object({
  name: z.string(),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(),
  scripts: z.record(z.string(), z.string()).optional(),
  exports: z.unknown().optional(),
  files: z.array(z.string()).optional(),
})

const SPEC = /\.(?:spec|test)\.[cm]?[jt]sx?$/

/**
 * Parse a workspace package's manifest.
 * @param root - the repository root.
 * @param dir - the package's directory.
 * @returns its fields, or undefined when the directory has no `package.json`.
 */
function manifestOf(root: string, dir: string): z.infer<typeof ManifestSchema> | undefined {
  const path = join(root, dir, 'package.json')
  return existsSync(path) ? ManifestSchema.parse(JSON.parse(readFileSync(path, 'utf8'))) : undefined
}

/**
 * The subdirectories of a repository directory.
 * @param root - the repository root.
 * @param dir - the directory.
 * @returns their repository-relative paths, sorted; none when the directory does not exist.
 */
function children(root: string, dir: string): string[] {
  return existsSync(join(root, dir)) ? readdirSync(join(root, dir), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => `${dir}/${entry.name}`).sort() : []
}

/**
 * The files under a package's `tests`.
 * @param root - the repository root.
 * @param dir - the package's directory.
 * @returns the relative entries; none without a `tests` directory.
 */
function testEntries(root: string, dir: string): string[] {
  const tests = join(root, dir, 'tests')
  return existsSync(tests) ? readdirSync(tests, { recursive: true, encoding: 'utf8' }) : []
}

/**
 * The tree's packages and programs, as the check runner reads them: Delo's packages under `delo/apps` and
 * `delo/packages` with their tsconfig programs, and upstream's under `packages/<group>` and `apps`.
 * @param root - the repository root.
 * @returns the tree.
 */
export function readTree(root: string): ForkTree {
  const packages: ForkPackage[] = []
  const programs: Program[] = []
  for (const dir of [...children(root, 'delo/apps'), ...children(root, 'delo/packages')]) {
    const manifest = manifestOf(root, dir)
    if (manifest === undefined) continue
    const dependencies = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies })
    const ownWorkspace = existsSync(join(root, dir, 'pnpm-workspace.yaml'))
    packages.push({
      name: manifest.name,
      dir,
      forkDependencies: dependencies.filter(name => name.startsWith('@delo/')),
      upstreamDependencies: dependencies.filter(name => name.startsWith('@deepseek-ai/')),
      ownWorkspace,
      dockerSpecs: testEntries(root, dir).some(entry => entry.endsWith('.docker.spec.ts')),
      buildOutputs: declaredBuildOutputs(manifest),
    })
    if (!ownWorkspace) programs.push(...readdirSync(join(root, dir)).filter(entry => /^tsconfig(\..+)?\.json$/.test(entry)).sort().map(file => ({ config: `${dir}/${file}` })))
  }
  const upstream: UpstreamPackage[] = []
  for (const dir of [...children(root, 'packages').flatMap(group => children(root, group)), ...children(root, 'apps')].sort()) {
    const manifest = manifestOf(root, dir)
    if (manifest === undefined) continue
    const upstreamOnly = (names: readonly string[]): string[] => names.filter(name => name.startsWith('@deepseek-ai/'))
    upstream.push({
      name: manifest.name,
      dir,
      dependencies: upstreamOnly(Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies })),
      runtimeDependencies: upstreamOnly(Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })),
      specs: testEntries(root, dir).filter(entry => SPEC.test(entry)).length,
    })
  }
  const patches = existsSync(join(root, MANIFEST_PATH)) ? parseManifest(readFileSync(join(root, MANIFEST_PATH), 'utf8')).patches : []
  const marked = withSecurityPackages(upstream, patches)
  return { packages, programs, upstream: marked, webSpecs: readWebSpecs(root, marked), journey: existsSync(join(root, JOURNEY_SPEC)) }
}
