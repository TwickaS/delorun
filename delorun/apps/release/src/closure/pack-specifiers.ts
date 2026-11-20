/**
 * Stable, path-free dependency specifiers for a pack's metadata files. `pnpm deploy` writes a workspace package it
 * injects into a pack as `<name>@file:///<absolute source path>` in the pack's `package.json` and `pnpm-lock.yaml`, with
 * a `directory` relative to the deployment, and lists the source's patch files by path in `pnpm-workspace.yaml`. The
 * absolute path is the build's temporary folder, which differs per build, so two builds of the same sources shipped
 * different bytes and Changes showed a dependency change after every update.
 *
 * A lockfile snapshot names an injected dependency by its map key and holds `file:///<absolute path>` as the value; that
 * form is rewritten too. {@link stabilizeDeployedSpecifiers} rewrites those specifiers to the exact version of the package the pack carries in
 * its own `node_modules`, and deletes {@link DEPLOY_METADATA}, the pnpm install state the closure deletes too: it holds
 * the deployment's folder, the pnpm store's folder and timestamps, and a second lockfile with the `file:///` keys.
 * {@link machinePathProblems} then refuses a pack that still carries any of it, or whose metadata still names an
 * absolute path, a `file://` URL, a path outside the pack or a temporary or home folder. A lockfile `directory` is
 * rewritten to `node_modules/<name>`, which is a folder the pack does not carry when that package is dropped from the pack as
 * a closure peer; no pnpm runs on a pack, so the lockfile is documentation only.
 *
 * @module @delorun/release/closure/pack-specifiers
 */
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isMap, isPair, isScalar, parseDocument, Scalar, visit } from 'yaml'

/** The `package.json` fields whose values are dependency specifiers. */
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const

/** The `package.json` fields that hold specifiers or bundled names and are checked too. */
const OTHER_FIELDS = ['bundledDependencies', 'bundleDependencies', 'overrides', 'resolutions', 'pnpm'] as const

/**
 * A specifier or lockfile key `pnpm deploy` wrote for an injected package: `<name>@file:///<absolute path>`, followed in
 * a lockfile by the peer suffix `(<peer>@<version>)` of a variant. Groups: the name and the suffix.
 */
const INJECTED = /^(@[^@/]+\/[^@/]+|[^@/]+)@file:\/\/\/[^(]+((?:\(.*\))?)$/u

/**
 * The version of an injected package as a lockfile snapshot's dependency value, which names the package by its map key
 * and so holds `file:///<absolute path>` without `<name>@`. Group: the peer suffix.
 */
const INJECTED_VALUE = /^file:\/\/\/[^(]+((?:\(.*\))?)$/u

/**
 * What `pnpm deploy` leaves besides the deployed files, by path from the deployment (a folder takes everything under
 * it): the workspace file lists the source's patch files by path, `.modules.yaml` and `.pnpm-workspace-state-v1.json`
 * hold the deployment's and the store's absolute paths and timestamps, and `.pnpm` holds a second lockfile. The runtime
 * closure and every pack delete them, because they differ per build and nothing reads them from an installed copy.
 */
export const DEPLOY_METADATA: readonly string[] = ['pnpm-workspace.yaml', 'node_modules/.modules.yaml', 'node_modules/.pnpm-workspace-state-v1.json', 'node_modules/.pnpm']

/** Package scopes whose own `package.json` files a pack carries from the workspace, so their specifiers are checked too. */
const OWN_PACKAGE_JSON = /(?:^|\/)node_modules\/@(?:deepseek-ai|delorun)\/[^/]+\/package\.json$/u

/** Text that names a place on the build machine or outside the pack. Each entry is a description and a pattern. */
const MACHINE_PATHS: readonly (readonly [string, RegExp])[] = [
  ['a file: or link: specifier that does not name a folder inside the pack', /(?:^|@|\s)(?:file|link|portal):(?!(?:\.\/)?node_modules\/)/u],
  ['a file:// URL', /file:\/\//u],
  ['an absolute path', /(?:^|@)\//u],
  ['a Windows drive path', /(?:^|[^\w])[A-Za-z]:[\\/]/u],
  ['a path outside the pack', /(?:^|[^\w.])\.\.[\\/]/u],
  ['a release build folder', /delorun-release-build/u],
]

/**
 * The exact version of a package the deployment carries.
 * @param directory - the deployment.
 * @param name - the package name.
 * @returns the version in `node_modules/<name>/package.json`.
 * @throws Error when the deployment does not carry the package.
 */
async function bundledVersion(directory: string, name: string): Promise<string> {
  const path = join(directory, 'node_modules', ...name.split('/'), 'package.json')
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    throw new Error(`the deployment names ${name} by a file: path but does not carry it (${path}), so it has no version to write instead`, { cause: error })
  }
  const version = (JSON.parse(text) as { version?: string }).version
  if (version === undefined) throw new Error(`${name} in the deployment has no version`)
  return version
}

/**
 * Rewrite a deployment's injected `file:` specifiers to the carried version, in `package.json` and `pnpm-lock.yaml`, and
 * delete `pnpm-workspace.yaml`. Two deployments of the same sources, from any folders, then hold the same bytes.
 * @param directory - the deployment.
 */
export async function stabilizeDeployedSpecifiers(directory: string): Promise<void> {
  for (const path of DEPLOY_METADATA) await rm(join(directory, path), { recursive: true, force: true })
  const manifestPath = join(directory, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
  const versions = new Map<string, string>()
  const need = async (name: string): Promise<string> => {
    const known = versions.get(name)
    if (known !== undefined) return known
    const version = await bundledVersion(directory, name)
    versions.set(name, version)
    return version
  }
  let changed = false
  for (const field of DEPENDENCY_FIELDS) {
    const specifiers = manifest[field] as Record<string, string> | undefined
    if (specifiers === undefined) continue
    for (const [name, specifier] of Object.entries(specifiers)) {
      if (!INJECTED.test(specifier)) continue
      specifiers[name] = await need(name)
      changed = true
    }
  }
  if (changed) await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  const lockPath = join(directory, 'pnpm-lock.yaml')
  let lock: string
  try {
    lock = await readFile(lockPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const document = parseDocument(lock)
  const injected = new Set<string>()
  visit(document, {
    Pair: (_key, pair) => {
      if (isScalar(pair.key) && typeof pair.key.value === 'string' && isScalar(pair.value) && typeof pair.value.value === 'string' && INJECTED_VALUE.test(pair.value.value)) injected.add(pair.key.value)
    },
    Scalar: (_key, node) => { const name = typeof node.value === 'string' ? INJECTED.exec(node.value)?.[1] : undefined; if (name !== undefined) injected.add(name) },
  })
  for (const name of injected) await need(name)
  visit(document, {
    Pair: (_key, pair) => {
      if (isScalar(pair.key) && typeof pair.key.value === 'string' && isScalar(pair.value) && typeof pair.value.value === 'string') {
        const suffix = INJECTED_VALUE.exec(pair.value.value)?.[1]
        if (suffix !== undefined) {
          pair.value.value = `${versions.get(pair.key.value)!}${suffix}`
          pair.value.type = Scalar.PLAIN
          return
        }
      }
      const match = isScalar(pair.key) && typeof pair.key.value === 'string' ? INJECTED.exec(pair.key.value) : null
      if (match === null || !isMap(pair.value)) return
      const resolution = pair.value.get('resolution', true)
      if (isMap(resolution) && resolution.has('directory')) resolution.set('directory', `node_modules/${match[1]!}`)
    },
    Scalar: (key, node) => {
      const name = typeof node.value === 'string' ? INJECTED.exec(node.value)?.[1] : undefined
      if (name === undefined) return
      const version = versions.get(name)!
      const suffix = INJECTED.exec(node.value as string)![2]!
      node.value = key === 'key' ? `${name}@${version}${suffix}` : `${version}${suffix}`
      node.type = Scalar.PLAIN
    },
  })
  const rewritten = document.toString({ lineWidth: 0, singleQuote: true })
  // Two peer variants of one injected package that differ only by a path the rewrite removed would become one key twice.
  const duplicates = parseDocument(rewritten).errors
  if (duplicates.length > 0) throw new Error(`rewriting the injected specifiers in ${lockPath} made the lockfile invalid: ${duplicates[0]!.message}`)
  await writeFile(lockPath, rewritten)
}

/** One string found to name a machine path: where it is, what it is and why it is refused. */
export interface MachinePathProblem {
  /** The pack file. */
  readonly file: string
  /** The field or lockfile location, such as `dependencies.@deepseek-ai/dsh-brand`. */
  readonly field: string
  /** The offending text. */
  readonly value: string
  /** What the text names. */
  readonly names: string
}

function describeMachinePath(text: string): string | undefined {
  return MACHINE_PATHS.find(([, pattern]) => pattern.test(text))?.[0]
}

function jsonProblems(file: string, value: unknown, field: string, out: MachinePathProblem[]): void {
  if (typeof value === 'string') {
    const names = describeMachinePath(value)
    if (names !== undefined) out.push({ file, field, value, names })
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, inner] of Object.entries(value)) jsonProblems(file, inner, field === '' ? key : `${field}.${key}`, out)
  }
}

function manifestProblems(file: string, text: string, out: MachinePathProblem[]): void {
  const manifest = JSON.parse(text) as Record<string, unknown>
  for (const field of [...DEPENDENCY_FIELDS, ...OTHER_FIELDS]) {
    if (manifest[field] !== undefined) jsonProblems(file, manifest[field], field, out)
  }
}

function lockfileProblems(file: string, text: string, out: MachinePathProblem[]): void {
  visit(parseDocument(text), {
    Pair: (_key, pair, path) => {
      if (isScalar(pair.key) && pair.key.value === 'deprecated') return visit.SKIP
      const trail = [...path, pair].flatMap(node => (isPair(node) && isScalar(node.key) ? [String(node.key.value)] : []))
      for (const scalar of [pair.key, pair.value]) {
        if (!isScalar(scalar) || typeof scalar.value !== 'string') continue
        const names = describeMachinePath(scalar.value)
        if (names !== undefined) out.push({ file, field: trail.join(' > '), value: scalar.value, names })
      }
      return undefined
    },
  })
}

/**
 * The strings in a pack's metadata files that name a machine path: an absolute path, a `file://` URL, a path outside
 * the pack, or a temporary or home folder. The checked files are the pack's `package.json` dependency fields, the
 * `package.json` of each Delorun or vendor package the pack carries, including nested copies, and `pnpm-lock.yaml`.
 * Any file of {@link DEPLOY_METADATA} is a problem in itself.
 * @param entries - the pack's files by path.
 * @returns each offending string with its file and field; empty for a pack whose metadata is path-free.
 */
export function machinePathProblems(entries: readonly { readonly path: string, readonly data: Buffer }[]): MachinePathProblem[] {
  const problems: MachinePathProblem[] = []
  for (const entry of entries) {
    if (entry.path === 'package.json' || OWN_PACKAGE_JSON.test(entry.path)) manifestProblems(entry.path, entry.data.toString('utf8'), problems)
    else if (entry.path === 'pnpm-lock.yaml') lockfileProblems(entry.path, entry.data.toString('utf8'), problems)
    if (DEPLOY_METADATA.some(path => entry.path === path || entry.path.startsWith(`${path}/`))) problems.push({ file: entry.path, field: '', value: entry.data.toString('utf8', 0, 80), names: 'pnpm deploy metadata, which holds paths and timestamps of the build and which a pack does not carry' })
  }
  return problems
}

/**
 * Refuse a pack whose metadata names a machine path.
 * @param name - the pack's package name.
 * @param platform - the platform the variant is for.
 * @param entries - the variant's files.
 * @throws Error naming the pack, file, field and text of up to five offenders.
 */
export function refuseMachinePaths(name: string, platform: string, entries: readonly { readonly path: string, readonly data: Buffer }[]): void {
  const problems = machinePathProblems(entries)
  if (problems.length === 0) return
  const lines = problems.slice(0, 5).map(problem => `${problem.file}${problem.field === '' ? '' : ` ${problem.field}`}: ${problem.value} (${problem.names})`)
  throw new Error(`${name} for ${platform} carries ${String(problems.length)} path${problems.length === 1 ? '' : 's'} of the build machine in its metadata, which differ per build and would show as a change after every update: ${lines.join('; ')}${problems.length > 5 ? `; and ${String(problems.length - 5)} more` : ''}`)
}
