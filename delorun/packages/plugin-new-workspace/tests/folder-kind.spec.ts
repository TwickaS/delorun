/**
 * What a folder holds, read from the names of its top-level entries only: a project marker makes it code, a visible
 * entry makes it files, and nothing visible makes it empty.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { folderKind } from '../src/folder-kind.ts'

let home = ''

beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'delorun-new-workspace-kind-')) })
afterEach(async () => { await rm(home, { recursive: true, force: true }) })

describe('what a folder holds', () => {
  it.each<readonly [string, readonly string[], string]>([
    ['nothing visible', ['.DS_Store'], 'empty'],
    ['a Git directory', ['.git'], 'code'],
    ['a manifest', ['package.json', 'README.md'], 'code'],
    ['a .NET project', ['App.csproj'], 'code'],
    ['a .NET solution', ['App.sln'], 'code'],
    ['documents', ['notes.md', 'photo.jpg'], 'files'],
  ])('reads %s as %s', async (_, names, kind) => {
    const folder = join(home, 'folder')
    await mkdir(folder)
    for (const name of names) await (name === '.git' ? mkdir(join(folder, name)) : writeFile(join(folder, name), ''))
    expect(await folderKind(folder)).toBe(kind)
  })

  it('reads an empty folder as empty and one it cannot list as files', async () => {
    await mkdir(join(home, 'empty'))
    expect(await folderKind(join(home, 'empty'))).toBe('empty')
    expect(await folderKind(join(home, 'missing'))).toBe('files')
  })

  it('stops reading a huge folder after the first entries', async () => {
    const folder = join(home, 'huge')
    await mkdir(folder)
    await Promise.all(Array.from({ length: 2100 }, (_, index) => writeFile(join(folder, `f${String(index)}.txt`), '')))
    expect(await folderKind(folder)).toBe('files')
  })
})
