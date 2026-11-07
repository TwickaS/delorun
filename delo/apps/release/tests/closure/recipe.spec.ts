/**
 * The recipe's inputs: the committed recipe files validate and refuse unknown or incomplete entries; the build
 * refuses a toolchain other than the pinned one and passes only its own environment; and every pinned download is
 * used only when its bytes match the pin, against a local HTTP stand-in.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { create as createTar } from 'tar'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildEnvironment, toolchainProblems } from '../../src/build-closure.ts'
import { readRecipe, readRecipeFile, RebuildExceptions, RECIPE_DIR } from '../../src/closure/config.ts'
import { fetchPinned, stageNpmPackage, substitutePrebuilt } from '../../src/closure/sources.ts'
import { scratch } from '../support.ts'

const routes = new Map<string, Buffer>()
let server: Server
let origin: string

beforeAll(async () => {
  server = createServer((request, response) => {
    const body = routes.get(request.url ?? '')
    response.writeHead(body === undefined ? 404 : 200)
    response.end(body)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
})

afterAll(async () => {
  await new Promise(resolve => server.close(resolve))
})

async function npmTarball(directory: string, manifest: object): Promise<Buffer> {
  const root = join(directory, 'tarball-source')
  mkdirSync(join(root, 'package'), { recursive: true })
  writeFileSync(join(root, 'package', 'package.json'), JSON.stringify(manifest))
  const file = join(directory, 'package.tgz')
  await createTar({ gzip: true, file, cwd: root }, ['package'])
  return readFileSync(file)
}

function integrity(bytes: Buffer): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`
}

describe('recipe files', () => {
  it('validate as committed', () => {
    const recipe = readRecipe()
    expect(recipe.toolchain.node.version).toMatch(/^\d+\.\d+\.\d+$/u)
    expect(recipe.closure.buildRoot.startsWith('/')).toBe(true)
  })

  it('refuse an unknown field and an exception without a reason', (test) => {
    const directory = scratch(test)
    const path = join(directory, 'rebuild-exceptions.json')
    writeFileSync(path, JSON.stringify({ schema: 'delo.rebuild-exceptions/1', exceptions: [{ id: 'pe-authenticode', applies: 'pe', reason: '' }] }))
    expect(() => readRecipeFile(RebuildExceptions, path)).toThrow(/reason/u)
    writeFileSync(path, JSON.stringify({ schema: 'delo.rebuild-exceptions/1', exceptions: [], ignore: ['**'] }))
    expect(() => readRecipeFile(RebuildExceptions, path)).toThrow(/ignore/u)
    writeFileSync(path, JSON.stringify({ schema: 'delo.rebuild-exceptions/1', exceptions: [{ id: 'all', applies: 'everything', reason: 'a reason that is long enough' }] }))
    expect(() => readRecipeFile(RebuildExceptions, path)).toThrow(/applies/u)
    expect(() => readRecipeFile(RebuildExceptions, join(RECIPE_DIR, 'missing.json'))).toThrow(/missing\.json/u)
  })
})

describe('the build toolchain and environment', () => {
  it('refuses a Node or pnpm other than the pinned one', () => {
    const recipe = readRecipe()
    expect(toolchainProblems(recipe, `v${recipe.toolchain.node.version}`, recipe.toolchain.pnpm.version)).toEqual([])
    expect(toolchainProblems(recipe, 'v24.0.0', '10.0.0')).toEqual([
      `Node v24.0.0 runs the build, but toolchain.json pins v${recipe.toolchain.node.version}`,
      `pnpm 10.0.0 runs the build, but toolchain.json pins ${recipe.toolchain.pnpm.version}`,
    ])
  })

  it('passes only the tool, home and proxy variables of the builder, and sets the recipe\'s own, with the client title closure.json names', () => {
    const env = buildEnvironment({ PATH: '/usr/bin', HOME: '/home/builder', NODE_OPTIONS: '--require /tmp/x.js', DSH_CLIENT_VERSION: '9.9.9', DSH_CLIENT_TITLE: 'DeepSeek Harness', SOURCE_DATE_EPOCH: '1' }, '/var/tmp/delo-release-build', 1_793_981_656, 'a'.repeat(40), readRecipe().closure.clientTitle)
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/builder',
      SOURCE_DATE_EPOCH: '1793981656',
      CFLAGS: '-ffile-prefix-map=/var/tmp/delo-release-build=.',
      CXXFLAGS: '-ffile-prefix-map=/var/tmp/delo-release-build=.',
      TZ: 'UTC',
      LC_ALL: 'C',
      DSH_CLIENT_COMMIT_HASH: 'a'.repeat(40),
      DSH_CLIENT_TITLE: 'Delo',
    })
  })
})

describe('pinned downloads', () => {
  it('returns a download whose digest matches, and serves it from the cache afterwards', async (test) => {
    const cache = scratch(test)
    const bytes = Buffer.from('node distribution')
    routes.set('/node.tar.gz', bytes)
    const digest = { algorithm: 'sha256' as const, hex: createHash('sha256').update(bytes).digest('hex') }
    const path = await fetchPinned(`${origin}/node.tar.gz`, digest, cache)
    expect(readFileSync(path).equals(bytes)).toBe(true)
    routes.delete('/node.tar.gz')
    expect(await fetchPinned(`${origin}/node.tar.gz`, digest, cache)).toBe(path)
  })

  it('refuses a download whose digest differs, and removes a cached copy that changed', async (test) => {
    const cache = scratch(test)
    routes.set('/tampered', Buffer.from('tampered bytes'))
    const digest = { algorithm: 'sha256' as const, hex: createHash('sha256').update('expected bytes').digest('hex') }
    await expect(fetchPinned(`${origin}/tampered`, digest, cache)).rejects.toThrow(/does not match the pinned digest/u)
    writeFileSync(join(cache, `sha256-${digest.hex}`), 'changed in the cache')
    await expect(fetchPinned(`${origin}/tampered`, digest, cache)).rejects.toThrow(/the cached copy was removed/u)
  })

  it('refuses an npm tarball that holds another package or version', async (test) => {
    const directory = scratch(test)
    const tarball = await npmTarball(directory, { name: '@deepseek-ai/node-addon-system-linux-x64', version: '0.1.3' })
    routes.set('/addon.tgz', tarball)
    const expected = { name: '@deepseek-ai/node-addon-system-linux-x64', version: '0.1.2', integrity: integrity(tarball) }
    await expect(stageNpmPackage(`${origin}/addon.tgz`, expected, join(directory, 'out'), join(directory, 'cache'))).rejects.toThrow(/holds @deepseek-ai\/node-addon-system-linux-x64@0\.1\.3, not .*@0\.1\.2/u)
  })

  it('refuses a prebuilt substitute whose version differs from the deployed source package', async (test) => {
    const directory = scratch(test)
    const modules = join(directory, 'node_modules')
    mkdirSync(join(modules, '@deepseek-ai', 'node-addon-system-linux-x64'), { recursive: true })
    writeFileSync(join(modules, '@deepseek-ai', 'node-addon-system-linux-x64', 'package.json'), JSON.stringify({ version: '0.2.0' }))
    const substitute = { name: '@deepseek-ai/node-addon-system-linux-x64', version: '0.1.2', integrity: `sha512-${'A'.repeat(86)}==` }
    await expect(substitutePrebuilt([substitute], modules, join(directory, 'cache'))).rejects.toThrow(/does not match the deployed source version 0\.2\.0/u)
    await expect(substitutePrebuilt([{ ...substitute, name: '@deepseek-ai/absent' }], modules, join(directory, 'cache'))).rejects.toThrow(/none is deployed/u)
  })
})
