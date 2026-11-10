/**
 * Building a closure from artifacts already built in a worktree, instead of running `pnpm run build:artifacts` in the
 * exported tree. The build then reuses the worktree's `lib/` directories, the client bundles and the native addon,
 * copied into the exported tree; the closure is not reproducible from the commit alone, because bundlers embed the
 * worktree's paths, so a release built this way is a local release and never a signed one.
 *
 * @module @delo/release/closure/artifacts
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/** Where the closure's artifacts come from. */
export type ArtifactSource = 'build' | 'existing'

/** Whether a string names an {@link ArtifactSource}. */
export function isArtifactSource(value: string): value is ArtifactSource {
  return value === 'build' || value === 'existing'
}

/** Directories that hold build outputs the closure never needs, though git ignores them. */
const NOT_ARTIFACTS = /(^|\/)(node_modules|\.cache|coverage)(\/|$)|^delo\/apps\/docs(\/|$)/u

/**
 * The directories the worktree's build wrote and git ignores: each package's `lib/`, the client bundles and the native
 * addon. A directory under `node_modules` or the documentation site is not one.
 * @param repository - the worktree's root.
 * @returns repository-relative directory paths, without a trailing slash.
 */
export function artifactDirectories(repository: string): string[] {
  const listed = execFileSync('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '--no-empty-directory', '-z'], { cwd: repository, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  return listed.split('\0').filter(path => path.endsWith('/') && !NOT_ARTIFACTS.test(path.slice(0, -1))).map(path => path.slice(0, -1)).sort()
}

/**
 * The newest modification time of any file below a directory.
 * @param directory - the directory.
 * @returns the time in milliseconds, or 0 for a directory without files.
 */
function newestFile(directory: string): number {
  let newest = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    newest = Math.max(newest, entry.isDirectory() ? newestFile(path) : statSync(path).mtimeMs)
  }
  return newest
}

/** The package directories whose `lib/` the build writes: the workspace patterns of the root `package.json` that hold sources. */
function sourcePackages(repository: string): string[] {
  const found: string[] = []
  for (const group of ['vendor', 'packages', 'apps']) {
    const base = join(repository, group)
    if (!existsSync(base)) continue
    for (const first of readdirSync(base, { withFileTypes: true })) {
      if (!first.isDirectory()) continue
      const candidates = existsSync(join(base, first.name, 'package.json')) ? [join(base, first.name)] : readdirSync(join(base, first.name), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(base, first.name, entry.name))
      for (const candidate of candidates) if (existsSync(join(candidate, 'package.json')) && existsSync(join(candidate, 'src'))) found.push(candidate)
    }
  }
  return found.sort()
}

/**
 * Why the worktree's artifacts cannot stand for a build of its commit: a tracked file differs from the commit, a package
 * whose `main` names a file under `lib/` lacks it, or a package's sources are newer than its `lib/`.
 * @param repository - the worktree's root.
 * @param commit - the commit being built.
 * @returns one sentence per problem; empty when the artifacts can be used.
 */
export function artifactProblems(repository: string, commit: string): string[] {
  const problems: string[] = []
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()
  if (head !== commit) problems.push(`the worktree is at ${head}, not at ${commit}, so its artifacts are not this commit's`)
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: repository, encoding: 'utf8' }).trim()
  if (dirty !== '') problems.push('tracked files differ from the commit; commit or restore them before building from existing artifacts')
  for (const directory of sourcePackages(repository)) {
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { name?: string, main?: string }
    if (typeof manifest.main !== 'string' || !manifest.main.startsWith('lib/')) continue
    const name = manifest.name ?? relative(repository, directory)
    if (!existsSync(join(directory, manifest.main))) {
      problems.push(`${name} has no ${manifest.main}; run the artifact build`)
      continue
    }
    if (newestFile(join(directory, 'src')) > newestFile(join(directory, 'lib'))) problems.push(`${name}'s sources are newer than its lib/; run the artifact build again`)
  }
  return problems
}
