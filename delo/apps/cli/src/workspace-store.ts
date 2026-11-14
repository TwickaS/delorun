/**
 * The workspace registry file as `delorun doctor` and `delorun recover workspaces` read it: `storages/workspace.json`
 * in the Delo home, its rolling `.previous` copy, and the `.quarantined-` files the registry sets aside when it
 * starts with records it could not read. Reading changes nothing.
 * @module @delo/cli/workspace-store
 */
import { readdir, readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { inspectRegistryText, type RegistryInspection } from '@deepseek-ai/dsh-workspace'
import { previousPath } from '@deepseek-ai/dsh-storage-json'

/** One registry file as found: its path, and its reading unless the file is missing. */
export interface RegistryFile {
  /** The file's path. */
  readonly path: string
  /** What the file holds; `undefined` when it does not exist. */
  readonly inspection: RegistryInspection | undefined
}

/** The registry file, its backup and the set-aside files of a home. */
export interface RegistryStore {
  /** The current registry file. */
  readonly current: RegistryFile
  /** The rolling backup of the previous good file. */
  readonly previous: RegistryFile
  /** The files the registry set aside, oldest name first. */
  readonly quarantined: readonly string[]
}

/**
 * The registry file's path.
 * @param home - the Delo home.
 * @returns the path.
 */
export function registryPath(home: string): string {
  return join(home, 'storages', 'workspace.json')
}

/**
 * Read one file as a registry, or nothing when it is missing.
 * @param path - the file.
 * @returns the file and what it holds.
 * @throws {Error} when the file exists and cannot be read.
 */
async function readRegistryFile(path: string): Promise<RegistryFile> {
  try {
    return { path, inspection: inspectRegistryText(await readFile(path, 'utf8')) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, inspection: undefined }
    throw error
  }
}

/**
 * Read the registry file, its backup and the set-aside files without changing any.
 * @param home - the Delo home.
 * @returns the three.
 * @throws {Error} when a file exists and cannot be read.
 */
export async function readRegistryStore(home: string): Promise<RegistryStore> {
  const path = registryPath(home)
  const prefix = `${basename(path)}.quarantined-`
  let names: string[] = []
  try {
    names = await readdir(dirname(path))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return {
    current: await readRegistryFile(path),
    previous: await readRegistryFile(previousPath(path)),
    quarantined: names.filter(name => name.startsWith(prefix)).sort().map(name => join(dirname(path), name)),
  }
}

/**
 * Describe what a registry file holds, on one line.
 * @param file - the file.
 * @returns such as `3 workspaces`, `not readable (…)`, or `2 workspaces with problems: …`.
 */
export function describeRegistry(file: RegistryFile): string {
  const { inspection } = file
  if (inspection === undefined) return 'no file'
  if (inspection.state === 'unreadable') return `not readable (${inspection.reason})`
  const count = `${String(inspection.workspaces)} ${inspection.workspaces === 1 ? 'workspace' : 'workspaces'}`
  return inspection.problems.length === 0 ? count : `${count}, with problems: ${inspection.problems.join('; ')}`
}
