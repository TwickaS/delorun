/**
 * Archiving a staged closure: two stagings of the same files in different directories, with different file modes
 * and times, give byte-identical release files; the file list equals the archive's entries; anything an archive
 * cannot hold and any native file the pins do not list stop the build before a release file appears.
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, symlinkSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { inspectArchive } from '@delo/release-formats/archive/inspect'
import { archiveClosure } from '../../src/closure/archive-closure.ts'
import { launchProtocolFiles, missingLaunchFiles } from '../../src/closure/launch.ts'
import { listStagedTree } from '../../src/closure/tree.ts'
import { peImage, scratch, writeTree, type StagedContent } from '../support.ts'

const EPOCH = 1_793_981_656
const ELF = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), Buffer.alloc(56)])
const ELF_SHA256 = createHash('sha256').update(ELF).digest('hex')

const TREE: Readonly<Record<string, StagedContent>> = {
  'node/bin/node': { data: ELF, executable: true },
  'node/LICENSE': 'Node licence\n',
  'pnpm/package.json': '{"name":"pnpm","version":"11.28.5"}\n',
  'app/package.json': '{"name":"@deepseek-ai/dsh"}\n',
  'app/lib/bin.js': { data: '#!/usr/bin/env node\n', executable: true },
  'app/node_modules/native-addon/build/addon.node': ELF,
}

describe('archiveClosure', () => {
  for (const platform of ['linux-x64', 'win32-x64'] as const) {
    it(`writes identical ${platform} release files from stagings that differ in directory, modes and times`, async (test) => {
      const pins = { 'app/node_modules/native-addon/build/addon.node': ELF_SHA256 }
      const again = scratch(test)
      const second = scratch(test)
      writeTree(join(again, 'stage'), TREE, 0o644)
      writeTree(join(second, 'stage'), TREE, 0o600)
      utimesSync(join(second, 'stage', 'app', 'package.json'), 1_000_000, 1_000_000)
      const a = await archiveClosure({ stage: join(again, 'stage'), outDir: again, version: '0.1.0', platform, epoch: EPOCH, pins })
      const b = await archiveClosure({ stage: join(second, 'stage'), outDir: second, version: '0.1.0', platform, epoch: EPOCH, pins })
      expect(a).toEqual(b)
      expect(readFileSync(join(again, a.archive.name)).equals(readFileSync(join(second, b.archive.name)))).toBe(true)
      expect(readFileSync(join(again, a.files.name), 'utf8')).toBe(readFileSync(join(second, b.files.name), 'utf8'))
      expect(a.archive.name).toBe(platform === 'win32-x64' ? 'delorun-0.1.0-win32-x64.zip' : 'delorun-0.1.0-linux-x64.tar.gz')
    })
  }

  it('writes a file list whose entries are the archive\'s files with their lengths, digests and modes', async (test) => {
    const directory = scratch(test)
    writeTree(join(directory, 'stage'), TREE)
    const result = await archiveClosure({ stage: join(directory, 'stage'), outDir: directory, version: '0.1.0', platform: 'linux-x64', epoch: EPOCH, pins: undefined })
    const list = JSON.parse(readFileSync(join(directory, result.files.name), 'utf8')) as { signed: { schema: string, platform: string, files: { path: string, mode: string, length: number, sha256: string }[] }, signatures: unknown[] }
    const summary = await inspectArchive(join(directory, result.archive.name), 'tar.gz')
    expect(summary.problem).toBeUndefined()
    expect(list.signatures).toEqual([])
    expect(list.signed.schema).toBe('delo.release-files/1')
    expect(list.signed.files).toEqual(summary.entries.map(entry => ({ path: entry.path, length: entry.length, sha256: entry.sha256, mode: entry.mode })))
    expect(list.signed.files.find(file => file.path === 'app/lib/bin.js')?.mode).toBe('0755')
    expect(list.signed.files.find(file => file.path === 'app/package.json')?.mode).toBe('0644')
  })

  it('refuses a native file that prebuilt-pins.json does not list, and leaves no release file', async (test) => {
    const directory = scratch(test)
    writeTree(join(directory, 'stage'), { ...TREE, 'app/node_modules/other/prebuilds/win32-x64/helper.node': peImage(Buffer.alloc(16)) })
    const pins = { 'app/node_modules/native-addon/build/addon.node': ELF_SHA256 }
    await expect(archiveClosure({ stage: join(directory, 'stage'), outDir: directory, version: '0.1.0', platform: 'linux-x64', epoch: EPOCH, pins }))
      .rejects.toThrow(/helper\.node: native code that prebuilt-pins\.json does not list/u)
    expect(readdirSync(directory)).toEqual(['stage'])
  })

  it('refuses a pinned native file whose digest changed, and a pinned file that is absent', async (test) => {
    const directory = scratch(test)
    writeTree(join(directory, 'stage'), TREE)
    const pins = { 'app/node_modules/native-addon/build/addon.node': '0'.repeat(64), 'app/node_modules/gone/gone.node': ELF_SHA256 }
    await expect(archiveClosure({ stage: join(directory, 'stage'), outDir: directory, version: '0.1.0', platform: 'linux-x64', epoch: EPOCH, pins }))
      .rejects.toThrow(/gone\.node: pinned in prebuilt-pins\.json but absent[\s\S]*addon\.node: SHA-256 [0-9a-f]{64}, but prebuilt-pins\.json pins 0{64}/u)
  })

  it('does not ask the pins about the Node distribution, which toolchain.json pins', async (test) => {
    const directory = scratch(test)
    writeTree(join(directory, 'stage'), { 'node/bin/node': { data: ELF, executable: true } })
    const result = await archiveClosure({ stage: join(directory, 'stage'), outDir: directory, version: '0.1.0', platform: 'linux-x64', epoch: EPOCH, pins: {} })
    expect(result.native.size).toBe(0)
  })
})

describe('listStagedTree', () => {
  it('refuses a symbolic link', async (test) => {
    const directory = scratch(test)
    writeTree(directory, { 'app/package.json': '{}' })
    symlinkSync('package.json', join(directory, 'app', 'link.json'))
    await expect(listStagedTree(directory, 'linux-x64')).rejects.toThrow(/app\/link\.json: a symbolic link/u)
  })

  it('refuses paths that differ only in case on macOS and Windows, and allows them on Linux', async (test) => {
    const directory = scratch(test)
    writeTree(directory, { 'app/README.md': 'a', 'app/readme.md': 'b' })
    await expect(listStagedTree(directory, 'darwin-arm64')).rejects.toThrow(/differs from .* only in case/u)
    await expect(listStagedTree(directory, 'win32-x64')).rejects.toThrow(/only in case/u)
    expect((await listStagedTree(directory, 'linux-x64')).map(file => file.path)).toEqual(['app/README.md', 'app/readme.md'])
  })

  it('refuses names Windows cannot hold in a Windows closure', async (test) => {
    const directory = scratch(test)
    writeTree(directory, { 'app/con.js': 'a', 'app/a:b.js': 'b' })
    await expect(listStagedTree(directory, 'win32-x64')).rejects.toThrow(/reserved Windows device name[\s\S]*character Windows refuses|character Windows refuses[\s\S]*reserved Windows device name/u)
  })

  it('lists files in byte-wise path order', async (test) => {
    const directory = scratch(test)
    writeTree(directory, { 'b.js': '', 'B.js': '', 'a/z.js': '', 'a-b.js': '' })
    expect((await listStagedTree(directory, 'linux-x64')).map(file => file.path)).toEqual(['B.js', 'a-b.js', 'a/z.js', 'b.js'])
  })

  it('refuses a closure the launcher cannot start, naming the missing file, when launch files are required', async (test) => {
    const directory = scratch(test)
    writeTree(join(directory, 'stage'), TREE)
    await expect(archiveClosure({ stage: join(directory, 'stage'), outDir: directory, version: '0.1.0', platform: 'linux-x64', epoch: EPOCH, pins: undefined, requireLaunchFiles: true }))
      .rejects.toThrow('the linux-x64 closure lacks app/node_modules/@delo/cli/src/bin.js, which the launcher starts the runtime with')
    expect(readdirSync(directory)).toEqual(['stage'])
  })

  it('archives a closure that holds both launch files when they are required', async (test) => {
    const directory = scratch(test)
    writeTree(join(directory, 'stage'), { ...TREE, 'app/node_modules/@delo/cli/src/bin.js': 'console.log("delorun")\n' })
    const result = await archiveClosure({ stage: join(directory, 'stage'), outDir: directory, version: '0.1.0', platform: 'linux-x64', epoch: EPOCH, pins: undefined, requireLaunchFiles: true })
    expect(result.entries).toBe(Object.keys(TREE).length + 1)
  })
})

describe('launch protocol 1\'s files', () => {
  it('are the runtime\'s own Node and the delorun entry file, with the Windows executable named for its platform', () => {
    expect(launchProtocolFiles('linux-x64')).toEqual(['node/bin/node', 'app/node_modules/@delo/cli/src/bin.js'])
    expect(launchProtocolFiles('win32-x64')).toEqual(['node/node.exe', 'app/node_modules/@delo/cli/src/bin.js'])
  })

  it('are reported missing one by one', () => {
    expect(missingLaunchFiles(['node/bin/node'], 'linux-x64')).toEqual(['app/node_modules/@delo/cli/src/bin.js'])
    expect(missingLaunchFiles(['node/bin/node', 'app/node_modules/@delo/cli/src/bin.js'], 'linux-x64')).toEqual([])
    expect(missingLaunchFiles([], 'darwin-arm64')).toEqual(launchProtocolFiles('darwin-arm64'))
  })
})
