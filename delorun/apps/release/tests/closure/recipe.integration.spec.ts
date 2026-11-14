/**
 * The recipe's inputs: the committed recipe files validate and refuse unknown or incomplete entries; the build
 * refuses a toolchain other than the pinned one and a platform whose native addon it does not build, and passes only
 * its own environment; and every pinned download is used only when its bytes match the pin, against a local HTTP
 * stand-in.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { devNull } from 'node:os'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { create as createTar } from 'tar'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildClosures, buildClosuresChecked, buildEnvironment, toolchainProblems } from '../../src/build-closure.ts'
import { ClosureRecipe, parseRecipeText, readRecipe, readRecipeFile, RebuildExceptions, RECIPE_DIR, RECIPE_FILES, Toolchain } from '../../src/closure/config.ts'
import { RECIPE_PATH, recipeAt } from '../../src/rebuild/record.ts'
import { archiveClosure } from '../../src/closure/archive-closure.ts'
import { fetchPinned, stageNode, stageNpmPackage, stagePnpm } from '../../src/closure/sources.ts'
import { scratch, writeTree } from '../support.ts'

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
    writeFileSync(path, JSON.stringify({ schema: 'delorun.rebuild-exceptions/1', exceptions: [{ id: 'pe-authenticode', applies: 'pe', reason: '' }] }))
    expect(() => readRecipeFile(RebuildExceptions, path)).toThrow(/reason/u)
    writeFileSync(path, JSON.stringify({ schema: 'delorun.rebuild-exceptions/1', exceptions: [], ignore: ['**'] }))
    expect(() => readRecipeFile(RebuildExceptions, path)).toThrow(/ignore/u)
    writeFileSync(path, JSON.stringify({ schema: 'delorun.rebuild-exceptions/1', exceptions: [{ id: 'all', applies: 'everything', reason: 'a reason that is long enough' }] }))
    expect(() => readRecipeFile(RebuildExceptions, path)).toThrow(/applies/u)
    expect(() => readRecipeFile(RebuildExceptions, join(RECIPE_DIR, 'missing.json'))).toThrow(/missing\.json/u)
    writeFileSync(path, '{ not json')
    expect(() => readRecipeFile(RebuildExceptions, path)).toThrow(/rebuild-exceptions\.json: .*JSON/u)
  })

  it('list each release platform once, and never one whose native addon the recipe does not build', (test) => {
    const directory = scratch(test)
    for (const file of RECIPE_FILES) copyFileSync(join(RECIPE_DIR, file), join(directory, file))
    expect(readRecipe(directory).closure.platforms).toEqual(['linux-x64', 'linux-arm64'])
    const closure = JSON.parse(readFileSync(join(RECIPE_DIR, 'closure.json'), 'utf8')) as { platforms: string[] }
    const write = (platforms: readonly string[]): void => { writeFileSync(join(directory, 'closure.json'), JSON.stringify({ ...closure, platforms })) }
    write(['linux-x64', 'darwin-arm64', 'darwin-x64'])
    expect(() => readRecipe(directory)).toThrow('closure.json lists darwin-arm64 as a release platform, but toolchain.json builds no native system addon for it\nclosure.json lists darwin-x64 as a release platform')
    write([])
    expect(() => readRecipe(directory)).toThrow(/platforms/u)
    write(['linux-x64', 'linux-x64'])
    expect(() => readRecipe(directory)).toThrow(/each platform once/u)
    write(['linux-x64', 'freebsd-x64'])
    expect(() => readRecipe(directory)).toThrow(/platforms/u)
  })

  it('refuse a foreign prebuild rule whose package or directory climbs out of its package', () => {
    const closure = JSON.parse(readFileSync(join(RECIPE_DIR, 'closure.json'), 'utf8')) as { foreignPrebuilds: { package: string, directory: string, platforms: string[] }[] }
    const parse = (rule: Partial<{ package: string, directory: string, platforms: string[] }>): unknown => parseRecipeText(ClosureRecipe, JSON.stringify({ ...closure, foreignPrebuilds: [{ ...closure.foreignPrebuilds[0], ...rule }] }), 'closure.json')
    for (const packageName of ['..', '.', '@x/..', '@x/.', 'a/b']) expect(() => parse({ package: packageName })).toThrow(/foreignPrebuilds/u)
    for (const directory of ['..', '.', '../../tmp', 'prebuilds/../../x', './prebuilds', '/etc', 'prebuilds\\..', 'a//b', 'prebuilds/']) expect(() => parse({ directory })).toThrow(/foreignPrebuilds/u)
    expect(parse({ platforms: ['win32-x64'] })).toMatchObject({ schema: 'delorun.release-closure/1' })
  })

  it('read at a commit refuse a committed release platform the recipe does not build', (test) => {
    const repository = scratch(test)
    const env = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' }
    const git = (args: readonly string[]): string => execFileSync('git', args, { cwd: repository, env, encoding: 'utf8', timeout: 30_000 }).trim()
    git(['init', '-q', '-b', 'main'])
    mkdirSync(join(repository, RECIPE_PATH), { recursive: true })
    for (const file of RECIPE_FILES) copyFileSync(join(RECIPE_DIR, file), join(repository, RECIPE_PATH, file))
    git(['add', '-A'])
    git(['commit', '-q', '-m', 'recipe'])
    expect(recipeAt(repository, git(['rev-parse', 'HEAD'])).closure.platforms).toEqual(['linux-x64', 'linux-arm64'])
    const closure = JSON.parse(readFileSync(join(RECIPE_DIR, 'closure.json'), 'utf8')) as { platforms: string[] }
    writeFileSync(join(repository, RECIPE_PATH, 'closure.json'), JSON.stringify({ ...closure, platforms: [...closure.platforms, 'darwin-arm64'] }))
    git(['commit', '-q', '-am', 'darwin'])
    const commit = git(['rev-parse', 'HEAD'])
    expect(() => recipeAt(repository, commit)).toThrow(`the recipe at ${commit}: closure.json lists darwin-arm64 as a release platform, but toolchain.json builds no native system addon for it`)
  })

  it('pin the native builder by exact Debian versions and name a route for every platform', (test) => {
    const directory = scratch(test)
    const path = join(directory, 'toolchain.json')
    const toolchain = JSON.parse(readFileSync(join(RECIPE_DIR, 'toolchain.json'), 'utf8')) as { native: { builder: object, platforms: object } }
    const write = (native: object): void => { writeFileSync(path, JSON.stringify({ ...toolchain, native: { ...toolchain.native, ...native } })) }
    write({ builder: { ...toolchain.native.builder, packages: ['gcc'] } })
    expect(() => readRecipeFile(Toolchain, path)).toThrow(/name=version/u)
    write({ builder: { ...toolchain.native.builder, snapshot: 'latest' } })
    expect(() => readRecipeFile(Toolchain, path)).toThrow(/snapshot\.debian\.org timestamp/u)
    write({ platforms: { ...toolchain.native.platforms, 'linux-x64': 'prebuilt' } })
    expect(() => readRecipeFile(Toolchain, path)).toThrow(/linux-x64/u)
    const { 'win32-x64': _omitted, ...withoutWindows } = toolchain.native.platforms as Record<string, string>
    write({ platforms: withoutWindows })
    expect(() => readRecipeFile(Toolchain, path)).toThrow(/win32-x64/u)
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
    const env = buildEnvironment({ PATH: '/usr/bin', HOME: '/home/builder', NODE_OPTIONS: '--require /tmp/x.js', DSH_CLIENT_VERSION: '9.9.9', DSH_CLIENT_TITLE: 'DeepSeek Harness', SOURCE_DATE_EPOCH: '1' }, '/var/tmp/delorun-release-build', 1_793_981_656, 'a'.repeat(40), readRecipe().closure.clientTitle)
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/builder',
      SOURCE_DATE_EPOCH: '1793981656',
      CFLAGS: '-ffile-prefix-map=/var/tmp/delorun-release-build=.',
      CXXFLAGS: '-ffile-prefix-map=/var/tmp/delorun-release-build=.',
      TZ: 'UTC',
      LC_ALL: 'C',
      DSH_CLIENT_COMMIT_HASH: 'a'.repeat(40),
      DSH_CLIENT_TITLE: 'Delorun',
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
    await expect(fetchPinned(`${origin}/absent`, { algorithm: 'sha256', hex: '0'.repeat(64) }, cache)).rejects.toThrow(`download of ${origin}/absent failed with HTTP 404`)
    mkdirSync(join(cache, `sha256-${'1'.repeat(64)}`))
    await expect(fetchPinned(`${origin}/absent`, { algorithm: 'sha256', hex: '1'.repeat(64) }, cache)).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('refuses an npm tarball that holds another package or version', async (test) => {
    const directory = scratch(test)
    const tarball = await npmTarball(directory, { name: 'pnpm', version: '11.0.1' })
    routes.set('/pnpm.tgz', tarball)
    const expected = { name: 'pnpm', version: '11.0.0', integrity: integrity(tarball) }
    await expect(stageNpmPackage(`${origin}/pnpm.tgz`, expected, join(directory, 'out'), join(directory, 'cache'))).rejects.toThrow(/holds pnpm@11\.0\.1, not pnpm@11\.0\.0/u)
  })
})

describe('the staged Node and pnpm', () => {
  it('take the executable and licence of a tarball or ZIP distribution, and pnpm, from the cache', async (test) => {
    const directory = scratch(test)
    const cache = join(directory, 'cache')
    mkdirSync(cache)
    const cached = (bytes: Buffer, algorithm: 'sha256' | 'sha512'): string => {
      const hex = createHash(algorithm).update(bytes).digest('hex')
      writeFileSync(join(cache, `${algorithm}-${hex}`), bytes)
      return hex
    }
    writeTree(join(directory, 'linux'), { 'node-v24.22.0-linux-x64/bin/node': 'linux node', 'node-v24.22.0-linux-x64/LICENSE': 'licence', 'node-v24.22.0-linux-x64/README.md': 'left out' })
    await createTar({ gzip: true, file: join(directory, 'linux.tar.gz'), cwd: join(directory, 'linux') }, ['node-v24.22.0-linux-x64'])
    writeTree(join(directory, 'windows'), { 'node-v24.22.0-win-x64/node.exe': 'windows node', 'node-v24.22.0-win-x64/LICENSE': 'licence' })
    const zip = await archiveClosure({ stage: join(directory, 'windows'), outDir: directory, version: '0.1.0', platform: 'win32-x64', epoch: 1_793_981_656, pins: undefined })
    const pnpm = await npmTarball(directory, { name: 'pnpm', version: '11.0.0' })
    const toolchain = readRecipe().toolchain
    const pinned = {
      ...toolchain,
      node: { ...toolchain.node, distributions: {
        ...toolchain.node.distributions,
        'linux-x64': { file: 'node-v24.22.0-linux-x64.tar.gz', sha256: cached(readFileSync(join(directory, 'linux.tar.gz')), 'sha256') },
        'win32-x64': { file: 'node-v24.22.0-win-x64.zip', sha256: cached(readFileSync(join(directory, zip.archive.name)), 'sha256') },
      } },
      pnpm: { version: '11.0.0', tarball: `${origin}/absent.tgz`, integrity: integrity(pnpm) },
    }
    cached(pnpm, 'sha512')
    await stageNode(pinned, 'linux-x64', join(directory, 'stage-linux'), cache)
    await stageNode(pinned, 'win32-x64', join(directory, 'stage-windows'), cache)
    await stagePnpm(pinned, join(directory, 'stage-linux'), cache)
    expect(readFileSync(join(directory, 'stage-linux', 'node', 'bin', 'node'), 'utf8')).toBe('linux node')
    expect(readFileSync(join(directory, 'stage-linux', 'node', 'LICENSE'), 'utf8')).toBe('licence')
    expect(readFileSync(join(directory, 'stage-windows', 'node', 'node.exe'), 'utf8')).toBe('windows node')
    expect(JSON.parse(readFileSync(join(directory, 'stage-linux', 'pnpm', 'package.json'), 'utf8'))).toEqual({ name: 'pnpm', version: '11.0.0' })
  })
})

describe('the checked build', () => {
  it('refuses a Node other than the pinned one before it exports the tree or builds anything', async (test) => {
    const root = scratch(test)
    vi.spyOn(process, 'version', 'get').mockReturnValue('v1.0.0')
    test.onTestFinished(() => { vi.restoreAllMocks() })
    await expect(buildClosuresChecked(root, { version: '0.1.0', commit: 'HEAD', out: join(root, 'out'), platforms: ['linux-x64'], cache: join(root, 'cache'), writePins: false }))
      .rejects.toThrow('Node v1.0.0 runs the build, but toolchain.json pins v24.22.0')
  })

  it('refuses a platform that is not in this release before it exports the tree', async (test) => {
    const root = scratch(test)
    await expect(buildClosures(root, readRecipe(), { version: '0.1.0', commit: 'HEAD', out: join(root, 'out'), platforms: ['linux-x64', 'darwin-arm64', 'darwin-x64'], cache: join(root, 'cache'), writePins: false }))
      .rejects.toThrow('darwin-arm64, darwin-x64 is not in this release; closure.json lists linux-x64, linux-arm64')
  })
})
