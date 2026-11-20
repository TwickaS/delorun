/**
 * The {@link PLACES_PATH} and {@link PREVIEW_PATH} routes: where the flow starts looking, and what one folder holds.
 * Places lists the recent workspaces, the configured suggested folders that exist inside a root, and where a new folder
 * goes. A preview reads a folder's top-level names, its files' sizes, Git's `HEAD` and the latest commit's subject and
 * time only, at most a set number of entries within a time bound; it opens no file's contents, follows no link, and
 * refuses a folder outside the configured roots (links resolved) or one Delorun never adds.
 * @module @delorun/plugin-new-workspace/places
 */
import { lstat, opendir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import { folderKind } from './folder-kind.ts'
import { codeOf, expandPlace, placeProblem, type LocationDeps } from './location.ts'
import { lastCommitOf, stacksOf, type GitReader, runGit } from './project-facts.ts'
import {
  MAX_PLACES, MAX_PREVIEW_NAMES, type PlacesAnswer, type PreviewAnswer, type PreviewEntry, type RecentPlace, type SuggestedPlace,
} from './wire.ts'

/** What the places route needs from the harness. */
export interface PlacesDeps extends LocationDeps {
  /** Upstream's workspace registry. */
  readonly registry: Pick<WorkspaceRegistry, 'list'>
  /** The configured roots. */
  readonly roots: readonly string[]
  /** The configured suggested folders, in order. */
  readonly suggested: readonly string[]
  /** Where a new folder goes before the person has made one. */
  readonly firstParent: string
  /** The last folder a new folder or clone went in, from the defaults store. */
  readonly lastParent: () => Promise<string | undefined>
}

/**
 * Whether a path is an existing folder (a link to one counts).
 * @param path - the path.
 * @returns true for a folder.
 */
async function isFolder(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch (_absent) {
    // Missing or unreadable: not a place to offer.
    return false
  }
}

/**
 * List the places the flow starts from.
 * @param deps - the registry, the configured places, the defaults store and the log.
 * @returns the places.
 */
export async function readPlaces(deps: PlacesDeps): Promise<PlacesAnswer> {
  const home = homedir()
  const workspaces = [...deps.registry.list()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, MAX_PLACES)
  const recent: RecentPlace[] = []
  for (const workspace of workspaces) {
    // A workspace whose folder is gone is not a place to start from.
    if (!(await isFolder(workspace.path))) continue
    recent.push({ path: workspace.path, name: workspace.title === '' ? basename(workspace.path) : workspace.title, kind: await folderKind(workspace.path), usedAt: workspace.updatedAt })
  }
  const suggested: SuggestedPlace[] = []
  for (const place of deps.suggested) {
    const path = expandPlace(place, home)
    if (suggested.some(each => each.path === path) || !(await isFolder(path))) continue
    if (await placeProblem(path, deps.roots, deps) !== undefined) continue
    suggested.push({ path, name: basename(path) })
  }
  const last = await deps.lastParent()
  const usable = last !== undefined && await isFolder(last) && await placeProblem(last, deps.roots, deps) === undefined
  return { home, recent, suggested: suggested.slice(0, MAX_PLACES), defaultParent: usable ? last : expandPlace(deps.firstParent, home) }
}

/** Git's own directory, read for the branch only. */
const GIT_DIR = '.git'

/** The file that tells agents about a project. */
const AGENTS_FILE = 'AGENTS.md'

/**
 * The branch a repository's `HEAD` names, read from `.git/HEAD` when `.git` is a folder inside the previewed folder.
 * @param folder - the previewed folder.
 * @returns the branch, or undefined for a detached `HEAD`, a worktree's `.git` file or anything unreadable.
 */
async function branchOf(folder: string): Promise<string | undefined> {
  try {
    const git = join(folder, GIT_DIR)
    if (!(await lstat(git)).isDirectory()) return undefined
    const head = join(git, 'HEAD')
    if (!(await lstat(head)).isFile()) return undefined
    const text = (await readFile(head, 'utf8')).slice(0, 512)
    const branch = /^ref: refs\/heads\/([^\s]{1,255})\s*$/u.exec(text)?.[1]
    return branch
  } catch (_unreadable) {
    // No branch to show.
    return undefined
  }
}

/**
 * Add the size of each listed file, read from its directory entry's metadata; a link or a file whose size cannot be read
 * gets none.
 * @param folder - the previewed folder.
 * @param entries - the listed entries.
 * @returns the entries as the wire carries them.
 */
async function withSizes(folder: string, entries: readonly (PreviewEntry & { readonly file: boolean })[]): Promise<PreviewEntry[]> {
  return Promise.all(entries.map(async ({ name, folder: isFolder, file }) => {
    if (!file) return { name, folder: isFolder }
    try {
      return { name, folder: isFolder, size: (await lstat(join(folder, name))).size }
    } catch (_vanished) {
      // The file went between the listing and the read: shown without a size.
      return { name, folder: isFolder }
    }
  }))
}

/** The file that makes Git read objects from folders the repository names. */
const ALTERNATES = join(GIT_DIR, 'objects', 'info', 'alternates')

/**
 * Whether Git may be asked about the folder: `.git` is a real folder inside it and names no other folder to read
 * objects from, so Git reads nothing the previewed folder does not hold.
 * @param folder - the previewed folder.
 * @returns true for such a repository, false for a link, a worktree's `.git` file, a repository with alternates or
 * anything unreadable.
 */
async function isSelfContainedRepository(folder: string): Promise<boolean> {
  try {
    if (!(await lstat(join(folder, GIT_DIR))).isDirectory()) return false
  } catch (_absent) {
    // No repository to ask.
    return false
  }
  try {
    await lstat(join(folder, ALTERNATES))
    return false
  } catch (_none) {
    // No alternates file: the usual case.
    return true
  }
}

/** The most entries a preview reads before it stops. */
const MAX_PREVIEW_READ = 2000

/** What a preview needs from the harness. */
export interface PreviewDeps extends LocationDeps {
  /** The configured roots. */
  readonly roots: readonly string[]
  /** The most time reading the folder's entries may take, in milliseconds. */
  readonly timeMs: number
  /** The clock, in milliseconds; `Date.now` outside tests. */
  readonly now?: () => number
  /** Runs Git for the latest commit; the installed `git` outside tests. */
  readonly git?: GitReader
}

/**
 * Describe one folder for the preview column.
 * @param path - the folder.
 * @param deps - the roots, the time bound, the environment and the log.
 * @returns the description (the stacks, branch and latest commit when they could be read, and `more` when the read stopped at the entry or time bound), `refused` for a folder
 * outside the roots or one Delorun never adds, or `unreadable`.
 */
export async function previewFolder(path: string, deps: PreviewDeps): Promise<PreviewAnswer> {
  const now = deps.now ?? Date.now
  const deadline = now() + deps.timeMs
  const problem = await placeProblem(path, deps.roots, deps)
  if (problem === 'unresolved') return { result: 'unreadable' }
  if (problem !== undefined) return { result: 'refused', problem }
  const entries: (PreviewEntry & { readonly file: boolean })[] = []
  const names: string[] = []
  let git = false
  let agentsFile = false
  let visible = 0
  let stopped = false
  try {
    const directory = await opendir(path)
    let read = 0
    // Leaving the loop early closes the directory.
    for await (const entry of directory) {
      if (++read > MAX_PREVIEW_READ || now() >= deadline) {
        stopped = true
        break
      }
      names.push(entry.name)
      if (entry.name === GIT_DIR) git = true
      if (entry.name === AGENTS_FILE && entry.isFile()) agentsFile = true
      if (entry.name.startsWith('.')) continue
      visible += 1
      entries.push({ name: entry.name, folder: entry.isDirectory(), file: entry.isFile() })
    }
  } catch (error) {
    deps.warn(`a folder could not be previewed: ${codeOf(error)}`)
    return { result: 'unreadable' }
  }
  entries.sort((left, right) => Number(right.folder) - Number(left.folder) || left.name.localeCompare(right.name))
  const listed = await withSizes(path, entries.slice(0, MAX_PREVIEW_NAMES))
  const branch = git ? await branchOf(path) : undefined
  const lastCommit = git && await isSelfContainedRepository(path) ? await lastCommitOf(path, deps.git ?? runGit) : undefined
  const stack = stacksOf(names)
  return {
    result: 'folder',
    kind: await folderKind(path),
    git,
    ...(branch === undefined ? {} : { branch }),
    ...(lastCommit === undefined ? {} : { lastCommit }),
    ...(stack.length === 0 ? {} : { stack }),
    agentsFile,
    entries: listed,
    more: stopped || visible > MAX_PREVIEW_NAMES,
  }
}
