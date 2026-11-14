/**
 * What a folder holds, read from the names of its top-level entries only: no file is opened and no name leaves the
 * harness. It picks the first chat's starting prompts.
 * @module @delorun/plugin-onboarding/folder-kind
 */
import { opendir } from 'node:fs/promises'
import type { FolderKind } from './wire.ts'

/** Names whose presence makes a folder a code project: Git's directory and the manifests of common build systems. */
const PROJECT_MARKERS: ReadonlySet<string> = new Set([
  '.git', 'package.json', 'pyproject.toml', 'requirements.txt', 'setup.py', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle',
  'build.gradle.kts', 'Gemfile', 'composer.json', 'CMakeLists.txt', 'Makefile', 'mix.exs', 'deno.json', 'Package.swift',
])

/** The most entries read: a folder's kind shows in its first few names, and a huge folder is `files` or `code` anyway. */
const MAX_ENTRIES = 2000

/**
 * @param path - an existing folder.
 * @returns `code` when a project marker or a `.csproj`/`.sln` file is among its entries, `empty` with no visible entry,
 * `files` otherwise, and `files` when the folder cannot be read.
 */
export async function folderKind(path: string): Promise<FolderKind> {
  const names: string[] = []
  try {
    const directory = await opendir(path)
    // Leaving the loop early closes the directory.
    for await (const entry of directory) {
      names.push(entry.name)
      if (names.length >= MAX_ENTRIES) break
    }
  } catch (_unreadable) {
    // The folder was just added or cloned; one that cannot be listed now gets the prompts for a folder of files.
    return 'files'
  }
  if (names.some(name => PROJECT_MARKERS.has(name) || name.endsWith('.csproj') || name.endsWith('.sln'))) return 'code'
  return names.some(name => !name.startsWith('.')) ? 'files' : 'empty'
}
