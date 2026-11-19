import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyHarnessChange, createHarnessCopy, harnessChanges, type HarnessContext } from '../src/harness.ts'
import { harnessDrift, isLiveHarnessFile, LIVE_HARNESS_PREFIX, liveAssetPath, runningComposition } from '../src/harness-live.ts'
import { prepareComposedTree } from '../src/harness-tree.ts'
import { harnessCopyDirectory } from '../src/paths.ts'
import { harnessFixture, RUNTIME, START_FILE, terminal } from './harness-fixture.ts'

/**
 * Apply one edit of the start file.
 * @param ctx - the runtime.
 * @param text - the approved text.
 */
async function approveStart(ctx: HarnessContext, text: string): Promise<void> {
  await createHarnessCopy(ctx, terminal())
  writeFileSync(join(harnessCopyDirectory(ctx.home, ctx.runtime), ...START_FILE.split('/')), text)
  await applyHarnessChange(ctx, (await harnessChanges(ctx)).changes[0]!.id, terminal())
}

describe('the live class of changes to Delorun itself', () => {
  it('is the studio\'s built client assets whose URL path is their name as written', () => {
    expect(isLiveHarnessFile(`${LIVE_HARNESS_PREFIX}index-1a2b.js`)).toBe(true)
    expect(isLiveHarnessFile(`${LIVE_HARNESS_PREFIX}fonts/inter.woff2`)).toBe(true)
    expect(liveAssetPath(`${LIVE_HARNESS_PREFIX}fonts/inter.woff2`)).toBe('/assets/fonts/inter.woff2')
    for (const file of [
      START_FILE,
      'app/node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html',
      'app/node_modules/@deepseek-ai/dsh-web-frontend/lib/index.js',
      `${LIVE_HARNESS_PREFIX}`,
      `${LIVE_HARNESS_PREFIX}../index.html`,
      `${LIVE_HARNESS_PREFIX}./a.js`,
      `${LIVE_HARNESS_PREFIX}a//b.js`,
      `${LIVE_HARNESS_PREFIX}a b.js`,
      `${LIVE_HARNESS_PREFIX}a%2e.js`,
      `${LIVE_HARNESS_PREFIX}.hidden`,
    ]) expect(isLiveHarnessFile(file), file).toBe(false)
  })
})

describe('the composition a Host runs', () => {
  it('is known on the signed installation and on the tree the records compose, and unknown on another tree', async () => {
    const { ctx, home, signed } = harnessFixture()
    expect(await runningComposition(home, RUNTIME, undefined)).toEqual({ kind: 'known', files: {} })
    await approveStart(ctx, 'export const start = 2\n')
    const tree = await prepareComposedTree(home, RUNTIME, signed)
    const booted = await runningComposition(home, RUNTIME, tree!.directory)
    expect(booted).toMatchObject({ kind: 'known', files: { [START_FILE]: expect.any(String) } })
    expect(await harnessDrift(home, RUNTIME, booted)).toEqual({ restart: [], live: new Map(), unknown: false })

    // A later change composes another tree: the Host that booted on the first one does not run it.
    await approveStart(ctx, 'export const start = 3\n')
    expect(await runningComposition(home, RUNTIME, tree!.directory)).toEqual({ kind: 'unknown' })
    expect(await harnessDrift(home, RUNTIME, booted)).toEqual({ restart: [START_FILE], live: new Map(), unknown: false })
    expect(await harnessDrift(home, RUNTIME, { kind: 'unknown' })).toEqual({ restart: [START_FILE], live: new Map(), unknown: true })
    // The signed installation runs none of it.
    expect(await harnessDrift(home, RUNTIME, { kind: 'known', files: {} })).toMatchObject({ restart: [START_FILE] })
  })
})
