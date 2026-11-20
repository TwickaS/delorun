/**
 * Stable, path-free dependency specifiers for a pack's metadata files. `pnpm deploy` writes a workspace package it
 * injects into a pack as `<name>@file:///<absolute source path>` in the pack's `package.json` and `pnpm-lock.yaml`, with
 * a `directory` relative to the deployment, and lists the source's patch files by path in `pnpm-workspace.yaml`. The
 * absolute path is the build's temporary folder, which differs per build, so two builds of the same sources shipped
 * different bytes and Changes showed a dependency change after every update.
 *
 * {@link stabilizeDeployedSpecifiers} rewrites those specifiers to the exact version of the package the pack carries in
 * its own `node_modules`, and deletes `pnpm-workspace.yaml` as the closure deletes its pnpm deploy metadata.
 * {@link machinePathProblems} then refuses any pack metadata that still names an absolute path, a `file://` URL, a path
 * outside the pack or a temporary or home folder.
 *
 * @module @delorun/release/closure/pack-specifiers
 */
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isMap, isPair, isScalar, parseDocument, Scalar, visit } from 'yaml'

/** The `package.json` fields whose values are dependency specifiers. */
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const

/** A specifier or lockfile key `pnpm deploy` wrote for an injected package: `<name>@file:///<absolute path>`. */
const INJECTED = /^(@[^@/]+\/[^@/]+|[^@/]+)@file:\/\/\/.+$/u

/** pnpm's deploy metadata at a pack's root: it lists the source's patch files by path, so a pack does not carry it. */
const WORKSPACE_FILE = 'pnpm-workspace.yaml'

/** Package scopes whose own `package.json` files a pack carries from the workspace, so their specifiers are checked too. */
const OWN_PACKAGE_JSON = /^node_modules\/@(?:deepseek-ai|delorun)\/[^/]+\/package\.json$/u

/** Text that names a place on the build machine or outside the pack. Each entry is a description and a pattern. */
const MACHINE_PATHS: readonly (readonly [string, RegExp])[] = [
  ['a file: or link: specifier that does not name a folder inside the pack', /(?:^|@|\s)(?:file|link|portal):(?!(?:\.\/)?node_modules\/)/u],
  ['an absolute path', /(?<![\w.~:/-])\/(?:home|Users|root|tmp|var|private|mnt|opt|usr|etc|run|srv)\//u],
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
  await rm(join(directory, WORKSPACE_FILE), { force: true })
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
  visit(document, { Scalar: (_key, node) => { const name = typeof node.value === 'string' ? INJECTED.exec(node.value)?.[1] : undefined; if (name !== undefined) injected.add(name) } })
  for (const name of injected) await need(name)
  visit(document, {
    Pair: (_key, pair) => {
      const match = isScalar(pair.key) && typeof pair.key.value === 'string' ? INJECTED.exec(pair.key.value) : null
      if (match === null || !isMap(pair.value)) return
      const resolution = pair.value.get('resolution', true)
      if (isMap(resolution) && resolution.has('directory')) resolution.set('directory', `node_modules/${match[1]!}`)
    },
    Scalar: (key, node) => {
      const name = typeof node.value === 'string' ? INJECTED.exec(node.value)?.[1] : undefined
      if (name === undefined) return
      const version = versions.get(name)!
      node.value = key === 'key' ? `${name}@${version}` : version
      node.type = Scalar.PLAIN
    },
  })
  await writeFile(lockPath, document.toString({ lineWidth: 0, singleQuote: true }))
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
  for (const field of [...DEPENDENCY_FIELDS, 'bundledDependencies', 'overrides', 'resolutions', 'pnpm']) {
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
 * `package.json` of each Delorun or vendor package the pack carries, `pnpm-lock.yaml` and `pnpm-workspace.yaml`.
 * @param entries - the pack's files by path.
 * @returns each offending string with its file and field; empty for a pack whose metadata is path-free.
 */
export function machinePathProblems(entries: readonly { readonly path: string, readonly data: Buffer }[]): MachinePathProblem[] {
  const problems: MachinePathProblem[] = []
  for (const entry of entries) {
    const text = entry.data.toString('utf8')
    if (entry.path === 'package.json' || OWN_PACKAGE_JSON.test(entry.path)) manifestProblems(entry.path, text, problems)
    else if (entry.path === 'pnpm-lock.yaml') lockfileProblems(entry.path, text, problems)
    else if (entry.path === WORKSPACE_FILE) problems.push({ file: entry.path, field: '', value: text.slice(0, 80), names: 'pnpm deploy metadata, which a pack does not carry' })
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
