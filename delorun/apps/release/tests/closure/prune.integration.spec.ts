/**
 * Pruning foreign prebuilds: only the directories `closure.json` lists are removed, the closure's own platform never is,
 * and a foreign prebuild nobody listed still stops the build at the native-code check. A listed directory that is
 * missing, or that resolves outside its package through a symlink or a `..` entry, stops the prune before anything is
 * removed.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { archiveClosure } from '../../src/closure/archive-closure.ts'
import { PruneRuleError, pruneForeignPrebuilds } from '../../src/closure/prune.ts'
import { scratch, writeTree } from '../support.ts'

const EPOCH = 1_793_981_656
const ELF = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), Buffer.alloc(56)])
const ELF_SHA256 = createHash('sha256').update(ELF).digest('hex')
const KIT = 'app/node_modules/@deepseek-ai/kit'
const RULES = [{ package: '@deepseek-ai/kit', directory: 'prebuilds', platforms: ['darwin-arm64', 'win32-x64', 'linux-x64'] }]
const BASE = {
  'node/bin/node': { data: ELF, executable: true },
  'node/LICENSE': 'Node licence\n',
  'pnpm/package.json': '{"name":"pnpm"}\n',
  'app/package.json': '{"name":"@deepseek-ai/dsh"}\n',
} as const

describe('pruneForeignPrebuilds', () => {
  it('removes the listed foreign directories, logs each, and lets the pin check pass', async (test) => {
    const root = scratch(test)
    const stage = join(root, 'stage')
    writeTree(stage, { ...BASE, [`${KIT}/prebuilds/darwin-arm64/a.node`]: ELF, [`${KIT}/prebuilds/win32-x64/a.node`]: ELF, [`${KIT}/prebuilds/linux-x64/a.node`]: ELF })
    const lines: string[] = []
    const removed = await pruneForeignPrebuilds(stage, 'linux-x64', RULES, line => lines.push(line))
    expect(removed).toEqual([`${KIT}/prebuilds/darwin-arm64`, `${KIT}/prebuilds/win32-x64`])
    expect(lines).toHaveLength(2)
    expect(existsSync(join(stage, KIT, 'prebuilds/linux-x64/a.node'))).toBe(true)
    const pins = { [`${KIT}/prebuilds/linux-x64/a.node`]: ELF_SHA256 }
    await expect(archiveClosure({ stage, outDir: root, version: '0.1.0', platform: 'linux-x64', epoch: EPOCH, pins })).resolves.toBeDefined()
  })

  it('never removes the closure\'s own platform, even when the list names it', async (test) => {
    const stage = join(scratch(test), 'stage')
    writeTree(stage, { ...BASE, [`${KIT}/prebuilds/linux-x64/a.node`]: ELF })
    expect(await pruneForeignPrebuilds(stage, 'linux-x64', [{ ...RULES[0]!, platforms: ['linux-x64'] }], () => undefined)).toEqual([])
    expect(existsSync(join(stage, KIT, 'prebuilds/linux-x64/a.node'))).toBe(true)
  })

  it('leaves unlisted foreign prebuilds in place, so the pin check still refuses them', async (test) => {
    const root = scratch(test)
    const stage = join(root, 'stage')
    const other = 'app/node_modules/other/prebuilds/darwin-arm64/b.node'
    const unlisted = `${KIT}/prebuilds/darwin-x64/a.node`
    writeTree(stage, { ...BASE, [other]: ELF, [unlisted]: ELF, [`${KIT}/prebuilds/darwin-arm64/a.node`]: ELF, [`${KIT}/prebuilds/win32-x64/a.node`]: ELF })
    await pruneForeignPrebuilds(stage, 'linux-x64', RULES, () => undefined)
    expect(existsSync(join(stage, other))).toBe(true)
    expect(existsSync(join(stage, unlisted))).toBe(true)
    await expect(archiveClosure({ stage, outDir: root, version: '0.1.0', platform: 'linux-x64', epoch: EPOCH, pins: {} }))
      .rejects.toThrow(/darwin-x64\/a\.node: native code that prebuilt-pins\.json does not list\n[^\n]*other\/prebuilds\/darwin-arm64\/b\.node: native code/u)
  })

  it('refuses a listed directory that is a symlink to a location outside the package, and removes nothing', async (test) => {
    const root = scratch(test)
    const stage = join(root, 'stage')
    const outside = join(root, 'outside')
    writeTree(stage, { ...BASE, [`${KIT}/prebuilds/linux-x64/a.node`]: ELF, [`${KIT}/prebuilds/win32-x64/a.node`]: ELF })
    writeTree(outside, { 'darwin-arm64/victim.node': ELF })
    mkdirSync(join(stage, KIT, 'prebuilds'), { recursive: true })
    symlinkSync(outside, join(stage, KIT, 'prebuilds/darwin-arm64'))
    const error = await pruneForeignPrebuilds(stage, 'linux-x64', RULES, () => undefined).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(PruneRuleError)
    expect(error).toMatchObject({ code: 'escapes-package' })
    expect((error as Error).message).toMatch(/@deepseek-ai\/kit prebuilds\/darwin-arm64 resolves to .*outside the package/u)
    expect(existsSync(join(outside, 'darwin-arm64/victim.node'))).toBe(true)
    expect(existsSync(join(stage, KIT, 'prebuilds/win32-x64/a.node'))).toBe(true)
  })

  it('refuses a directory entry that climbs out of the package, even when the rule was not parsed', async (test) => {
    const root = scratch(test)
    const stage = join(root, 'stage')
    const victim = 'app/victim/darwin-arm64/victim.node'
    writeTree(stage, { ...BASE, [`${KIT}/package.json`]: '{"name":"@deepseek-ai/kit"}\n', [victim]: ELF })
    const rules = [{ package: '@deepseek-ai/kit', directory: '../../../victim', platforms: ['darwin-arm64'] }]
    await expect(pruneForeignPrebuilds(stage, 'linux-x64', rules, () => undefined)).rejects.toMatchObject({ code: 'escapes-package' })
    expect(existsSync(join(stage, victim))).toBe(true)
  })

  it('throws on a listed foreign directory that is missing, naming the package and directory, and removes nothing', async (test) => {
    const stage = join(scratch(test), 'stage')
    writeTree(stage, { ...BASE, [`${KIT}/prebuilds/darwin-arm64/a.node`]: ELF, [`${KIT}/prebuilds/linux-x64/a.node`]: ELF })
    const error = await pruneForeignPrebuilds(stage, 'linux-x64', RULES, () => undefined).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'missing-directory' })
    expect((error as Error).message).toContain('@deepseek-ai/kit prebuilds/win32-x64')
    expect(existsSync(join(stage, KIT, 'prebuilds/darwin-arm64/a.node'))).toBe(true)
  })
})
