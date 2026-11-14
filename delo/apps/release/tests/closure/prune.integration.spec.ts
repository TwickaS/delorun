/**
 * Pruning foreign prebuilds: only the directories `closure.json` lists are removed, the closure's own platform never is,
 * and a foreign prebuild nobody listed still stops the build at the native-code check.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { archiveClosure } from '../../src/closure/archive-closure.ts'
import { pruneForeignPrebuilds } from '../../src/closure/prune.ts'
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
    expect(await pruneForeignPrebuilds(stage, 'linux-x64', RULES, () => undefined)).toEqual([])
    expect(existsSync(join(stage, KIT, 'prebuilds/linux-x64/a.node'))).toBe(true)
  })

  it('leaves unlisted foreign prebuilds in place, so the pin check still refuses them', async (test) => {
    const root = scratch(test)
    const stage = join(root, 'stage')
    const other = 'app/node_modules/other/prebuilds/darwin-arm64/b.node'
    const unlisted = `${KIT}/prebuilds/darwin-x64/a.node`
    writeTree(stage, { ...BASE, [other]: ELF, [unlisted]: ELF, [`${KIT}/prebuilds/win32-x64/a.node`]: ELF })
    await pruneForeignPrebuilds(stage, 'linux-x64', RULES, () => undefined)
    expect(existsSync(join(stage, other))).toBe(true)
    expect(existsSync(join(stage, unlisted))).toBe(true)
    await expect(archiveClosure({ stage, outDir: root, version: '0.1.0', platform: 'linux-x64', epoch: EPOCH, pins: {} }))
      .rejects.toThrow(/darwin-x64\/a\.node: native code that prebuilt-pins\.json does not list\n[^\n]*other\/prebuilds\/darwin-arm64\/b\.node: native code/u)
  })
})
