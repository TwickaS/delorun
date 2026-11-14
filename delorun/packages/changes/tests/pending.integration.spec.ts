import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { changeId } from '../src/ids.ts'
import { pluginChange } from '../src/pending.ts'
import { storeFolder } from '../src/store.ts'
import type { ContentVersion } from '../src/types.ts'
import { rejection, temporaryDirectory, writeFiles } from './support.ts'

// The cases write real files and git histories; on a loaded host that takes longer than vitest's default.
vi.setConfig({ testTimeout: 30_000 })

/**
 * A home and a plugin folder holding files.
 * @param files - the folder's files.
 * @returns the two directories.
 */
function setUp(files: Readonly<Record<string, string>>): { home: string, folder: string } {
  const home = temporaryDirectory('delorun-changes-home-')
  const folder = temporaryDirectory('delorun-changes-folder-')
  writeFiles(folder, files)
  return { home, folder }
}

describe('pluginChange', () => {
  it('gives a plugin-install change for a plugin with no approved content', async () => {
    const { home, folder } = setUp({ 'package.json': '{"name":"@me/plugin"}', 'index.js': 'export default 1\n' })
    const change = await pluginChange(home, { plugin: '@me/plugin', source: folder })
    expect(change).toBeDefined()
    expect(change).not.toHaveProperty('from')
    expect(change).toMatchObject({ kind: 'plugin-install', plugin: '@me/plugin', source: folder })
    expect(change!.id).toBe(changeId('plugin-install', { plugin: '@me/plugin', source: folder }, undefined, change!.to))
    expect(change!.files.map((file) => [file.path, file.status])).toEqual([['index.js', 'added'], ['package.json', 'added']])
    expect(change!.diff.text).toContain('+export default 1')
    expect(change!.risk.findings).toEqual(expect.any(Array))
    expect(change!.skipped).toEqual([])
  })

  it('gives a plugin-edit change from the approved content to the folder\'s', async () => {
    const { home, folder } = setUp({ 'index.js': 'one\n' })
    const approved = (await storeFolder(home, folder)).version
    writeFiles(folder, { 'index.js': 'two\n' })
    const cache = join(home, 'changes', 'profiles', 'p', 'scan-cache.json')
    const change = await pluginChange(home, { plugin: 'plugin', source: folder, approved, scanCache: cache })
    expect(change).toMatchObject({ kind: 'plugin-edit', from: approved })
    expect(change!.to).not.toBe(approved)
    expect(change!.id).toBe(changeId('plugin-edit', { plugin: 'plugin', source: folder }, approved, change!.to))
    expect(change!.files).toEqual([{ path: 'index.js', status: 'modified', binary: false, dependency: false, sizeBefore: 4, sizeAfter: 4 }])
    expect(change!.diff.text).toContain('-one\n+two\n')
    expect(existsSync(cache)).toBe(true)
  })

  it('gives nothing when the folder holds the approved content', async () => {
    const { home, folder } = setUp({ 'index.js': 'one\n' })
    const approved = (await storeFolder(home, folder)).version
    expect(await pluginChange(home, { plugin: 'plugin', source: folder, approved })).toBeUndefined()
  })

  it('refuses an approved version the store does not hold', async () => {
    const { home, folder } = setUp({ 'index.js': 'one\n' })
    await rejection(pluginChange(home, { plugin: 'plugin', source: folder, approved: '0'.repeat(64) as string as ContentVersion }), 'STORE_CORRUPT')
  })
})

describe('content a diff does not show', () => {
  it('a .js file with one invalid byte, a file above the limit and a dependency inside the folder each need the second confirmation', async () => {
    const { home, folder } = setUp({ 'index.js': 'export default 1\n' })
    const approved = (await storeFolder(home, folder)).version
    writeFiles(folder, { 'index.js': 'export default 2\n', 'node_modules/dep/index.js': 'module.exports = 1\n' })
    writeFileSync(join(folder, 'loader.js'), Buffer.concat([Buffer.from('require("node:child_process").exec("x") // '), Buffer.from([0xff]), Buffer.from('\n')]))
    writeFileSync(join(folder, 'large.js'), `${'// filler\n'.repeat(120_000)}`)
    const change = await pluginChange(home, { plugin: 'plugin', source: folder, approved })
    expect(change!.diff.text).not.toContain('child_process')
    expect(change!.risk.kinds).toContain('not-shown')
    expect(change!.risk.kinds).not.toContain('commands')
    expect(change!.risk.needsSecondConfirmation).toBe(true)
    expect(change!.risk.findings.filter(finding => finding.kind === 'not-shown').map(finding => finding.file)).toEqual(['large.js', 'loader.js', 'node_modules/dep'])
  })
})
