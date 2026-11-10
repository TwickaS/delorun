/**
 * Docker lane: upstream's native system addon, compiled by the recipe's native step from two copies of `native/system`
 * in different directories, gives the same binaries both times, and they are the binaries `prebuilt-pins.json` pins for
 * the Linux closures. It builds the pinned builder image for both architectures, the arm64 one under emulation, and
 * downloads the pinned Node distributions into the release cache, so it runs only with `DELO_DOCKER_SPECS=1`, which the
 * check runner's Docker lane (`tests:docker`) sets once a Docker engine answers.
 */
import { createHash } from 'node:crypto'
import { cpSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readRecipe, RECIPE_DIR } from '../../src/closure/config.ts'
import { buildNativeAddons, NATIVE_SOURCE } from '../../src/closure/native-build.ts'
import { REPO, scratch } from '../support.ts'

const EPOCH = 1_793_981_656
const PLATFORMS = ['linux-x64', 'linux-arm64'] as const
const BINARIES = ['bin/landlock-run', 'bin/glibc/system.node', 'bin/musl/system.node']

describe.runIf(process.env.DELO_DOCKER_SPECS === '1')('the native system addon', () => {
  it('compiles to the pinned digests from two directories', { timeout: 1_800_000 }, async (test) => {
    const recipe = readRecipe()
    const runs: Array<Record<string, string>> = []
    for (const run of ['first', 'second-in-a-longer-directory']) {
      const source = join(scratch(test, `delo-native-${run}-`), run)
      cpSync(join(REPO, NATIVE_SOURCE), join(source, NATIVE_SOURCE), { recursive: true, filter: path => !path.includes('node_modules') })
      await buildNativeAddons({ toolchain: recipe.toolchain, base: (JSON.parse(readFileSync(join(RECIPE_DIR, 'images.json'), 'utf8')) as { base: string }).base, source, platforms: PLATFORMS, cache: join(homedir(), '.cache', 'delo-release'), epoch: EPOCH, user: `${String(process.getuid?.())}:${String(process.getgid?.())}` })
      runs.push(Object.fromEntries(PLATFORMS.flatMap(platform => BINARIES.map(binary => [
        `app/node_modules/@deepseek-ai/node-addon-system-${platform}/${binary}`,
        createHash('sha256').update(readFileSync(join(source, NATIVE_SOURCE, 'packages', platform, binary))).digest('hex'),
      ]))))
    }
    expect(runs[1]).toEqual(runs[0])
    const pinned = Object.fromEntries(PLATFORMS.flatMap(platform => Object.entries(recipe.pins.files[platform]).filter(([path]) => path.includes('/node-addon-system-'))))
    expect(runs[0]).toEqual(pinned)
  })
})
