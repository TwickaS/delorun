/**
 * Delorun's packages in a staged closure: TypeScript sources become JavaScript that plain Node imports from
 * `node_modules`, with entry points and relative imports rewritten, and the install anchor declares each Delorun bundle.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { declareAnchorBundles, stampDelorunVersion, transpileDelorunPackage, transpileDelorunPackages } from '../../src/closure/delorun.ts'
import { readRecipe } from '../../src/closure/config.ts'
import { scratch, writeTree } from '../support.ts'

function stagedTree(root: string): void {
  writeTree(root, {
    'node_modules/@delorun/lib/package.json': JSON.stringify({ name: '@delorun/lib', version: '0.0.0', type: 'module', exports: { '.': './src/index.ts', './types': { types: './src/types.d.ts' }, './package.json': './package.json' } }),
    'node_modules/@delorun/lib/src/index.ts': "import { twice } from './math.ts'\nimport type { Shape } from './types.d.ts'\nexport const shape: Shape = { size: twice(21) }\nexport const later = async (): Promise<number> => (await import('./math.ts')).twice(1)\nexport type { Shape }\n",
    'node_modules/@delorun/lib/src/math.ts': 'export function twice(value: number): number {\n  return value * 2\n}\n',
    'node_modules/@delorun/lib/src/types.d.ts': 'export interface Shape { readonly size: number }\n',
    'node_modules/@delorun/lib/tests/lib.spec.ts': "import { shape } from '../src/index.ts'\n",
    'node_modules/@delorun/cli/package.json': JSON.stringify({ name: '@delorun/cli', version: '0.0.0', type: 'module', bin: { delorun: './src/bin.ts' }, dependencies: { '@delorun/lib': 'workspace:*' } }),
    'node_modules/@delorun/cli/src/bin.ts': "import { shape } from '@delorun/lib'\nconst size: number = shape.size\nconsole.log(`size ${String(size)}`)\n",
    'node_modules/@delorun/bundle-local/package.json': JSON.stringify({ name: '@delorun/bundle-local', version: '1.2.3', main: 'lib/index.js' }),
    'node_modules/@delorun/bundle-local/lib/index.js': 'export default {}\n',
    'node_modules/@deepseek-ai/dsh/package.json': JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2', dependencies: { zod: '4.4.3', '@deepseek-ai/dsh-brand': '0.2.2' } }),
  })
}

describe('Delorun packages in a closure', () => {
  it('transpiles each package\'s sources so plain Node runs them from node_modules, and drops its tests', async (test) => {
    const root = scratch(test)
    stagedTree(root)
    expect(await transpileDelorunPackages(join(root, 'node_modules'))).toEqual(['@delorun/bundle-local', '@delorun/cli', '@delorun/lib'])
    const lib = join(root, 'node_modules/@delorun/lib')
    expect(existsSync(join(lib, 'src/index.ts'))).toBe(false)
    expect(existsSync(join(lib, 'tests'))).toBe(false)
    expect(readFileSync(join(lib, 'src/index.js'), 'utf8')).toContain('from "./math.js"')
    expect(readFileSync(join(lib, 'src/index.js'), 'utf8')).toContain('import("./math.js")')
    expect(readFileSync(join(lib, 'src/types.d.ts'), 'utf8')).toContain('Shape')
    expect(JSON.parse(readFileSync(join(lib, 'package.json'), 'utf8')).exports).toEqual({ '.': './src/index.js', './types': { types: './src/types.d.ts' }, './package.json': './package.json' })
    expect(JSON.parse(readFileSync(join(root, 'node_modules/@delorun/cli/package.json'), 'utf8')).bin).toEqual({ delorun: './src/bin.js' })
    const run = spawnSync(process.execPath, [join(root, 'node_modules/@delorun/cli/src/bin.js')], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 30_000 })
    expect(run.stderr).toBe('')
    expect(run.stdout).toBe('size 42\n')
  })

  it('rewrites entry points in arrays, and leaves other values in an entry field as they are', async (test) => {
    const root = scratch(test)
    writeTree(root, {
      'node_modules/@delorun/mixed/package.json': JSON.stringify({ name: '@delorun/mixed', version: '0.0.0', exports: ['./src/index.ts', './src/other.js'], imports: { '#plain': null, '#flag': true } }),
      'node_modules/@delorun/mixed/src/index.ts': 'export const one: number = 1\n',
    })
    await transpileDelorunPackages(join(root, 'node_modules'))
    const manifest = JSON.parse(readFileSync(join(root, 'node_modules/@delorun/mixed/package.json'), 'utf8'))
    expect(manifest.exports).toEqual(['./src/index.js', './src/other.js'])
    expect(manifest.imports).toEqual({ '#plain': null, '#flag': true })
  })

  it('rewrites subpath patterns over sources, so a package that exports `./sign/*` is importable by plain Node', async (test) => {
    const root = scratch(test)
    writeTree(root, {
      'node_modules/@delorun/formats/package.json': JSON.stringify({ name: '@delorun/formats', version: '0.0.0', type: 'module', exports: { './sign/*': './src/sign/*.ts', './types/*': './src/types/*.d.ts', './static/*': './static/*.ts', './package.json': './package.json' } }),
      'node_modules/@delorun/formats/src/sign/verify.ts': 'export function verify(): string {\n  return "verified"\n}\n',
      'node_modules/@delorun/cli/package.json': JSON.stringify({ name: '@delorun/cli', version: '0.0.0', type: 'module', bin: { delorun: './src/bin.ts' } }),
      'node_modules/@delorun/cli/src/bin.ts': "import { verify } from '@delorun/formats/sign/verify'\nconsole.log(verify())\n",
    })
    await transpileDelorunPackages(join(root, 'node_modules'))
    expect(JSON.parse(readFileSync(join(root, 'node_modules/@delorun/formats/package.json'), 'utf8')).exports).toEqual({ './sign/*': './src/sign/*.js', './types/*': './src/types/*.d.ts', './static/*': './static/*.ts', './package.json': './package.json' })
    const run = spawnSync(process.execPath, [join(root, 'node_modules/@delorun/cli/src/bin.js')], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 60_000 })
    expect(run.stderr).toBe('')
    expect(run.stdout).toBe('verified\n')
  })

  it('refuses a source that does not transpile, naming it', async (test) => {
    const root = scratch(test)
    writeTree(root, {
      'node_modules/@delorun/broken/package.json': JSON.stringify({ name: '@delorun/broken', version: '0.0.0', exports: './src/index.ts' }),
      'node_modules/@delorun/broken/src/index.ts': 'export const = 1\n',
    })
    await expect(transpileDelorunPackages(join(root, 'node_modules'))).rejects.toThrow(/@delorun\/broken\/src\/index\.ts does not transpile/u)
  })

  it('refuses a source that imports a TypeScript file of another package, which a closure does not ship in a form Node runs', async (test) => {
    const root = scratch(test)
    writeTree(root, {
      'node_modules/@delorun/deep/package.json': JSON.stringify({ name: '@delorun/deep', version: '0.0.0', exports: './src/index.ts' }),
      'node_modules/@delorun/deep/src/index.ts': "import { McpAddConsent } from '@deepseek-ai/dsh-mcp-client/src/consent.ts'\nexport const consent = McpAddConsent\n",
    })
    await expect(transpileDelorunPackages(join(root, 'node_modules'))).rejects.toThrow('@delorun/deep/src/index.ts imports @deepseek-ai/dsh-mcp-client/src/consent.ts, which is TypeScript that Node does not run from node_modules')
    writeTree(root, {
      'node_modules/@delorun/dynamic/package.json': JSON.stringify({ name: '@delorun/dynamic', version: '0.0.0', exports: './src/index.ts' }),
      'node_modules/@delorun/dynamic/src/index.ts': "export const load = () => import('@x/y/src/z.ts')\n",
    })
    await expect(transpileDelorunPackage(join(root, 'node_modules/@delorun/dynamic'))).rejects.toThrow('imports @x/y/src/z.ts')
  })

  it('has the install anchor declare each Delorun bundle at its staged version, and refuses a bundle the closure lacks', async (test) => {
    const root = scratch(test)
    stagedTree(root)
    const nodeModules = join(root, 'node_modules')
    await declareAnchorBundles(nodeModules, '@deepseek-ai/dsh', ['@delorun/bundle-local'])
    expect(JSON.parse(readFileSync(join(nodeModules, '@deepseek-ai/dsh/package.json'), 'utf8')).dependencies).toEqual({ '@deepseek-ai/dsh-brand': '0.2.2', '@delorun/bundle-local': '1.2.3', 'zod': '4.4.3' })
    await expect(declareAnchorBundles(nodeModules, '@deepseek-ai/dsh', ['@delorun/missing'])).rejects.toThrow('the closure does not carry @delorun/missing, which closure.json\'s anchor names')
    writeTree(root, { 'node_modules/@delorun/unversioned/package.json': '{"name":"@delorun/unversioned"}\n' })
    await expect(declareAnchorBundles(nodeModules, '@deepseek-ai/dsh', ['@delorun/unversioned'])).rejects.toThrow('@delorun/unversioned\'s package.json names no version')
  })

  it('stamps the release version into the delorun package, where delorun --version reads it, and into no other package', async (test) => {
    const root = scratch(test)
    stagedTree(root)
    const nodeModules = join(root, 'node_modules')
    await stampDelorunVersion(nodeModules, '0.2.0')
    const manifest = JSON.parse(readFileSync(join(nodeModules, '@delorun/cli/package.json'), 'utf8')) as { version: string, bin: unknown }
    expect(manifest.version).toBe('0.2.0')
    expect(manifest.bin).toEqual({ delorun: './src/bin.ts' })
    expect(JSON.parse(readFileSync(join(nodeModules, '@delorun/lib/package.json'), 'utf8')).version).toBe('0.0.0')
    await stampDelorunVersion(nodeModules, '0.3.0-rc.1')
    expect(JSON.parse(readFileSync(join(nodeModules, '@delorun/cli/package.json'), 'utf8')).version).toBe('0.3.0-rc.1')
  })

  it('refuses to stamp a closure that carries no delorun package', async (test) => {
    const root = scratch(test)
    writeTree(root, { 'node_modules/@delorun/lib/package.json': '{"name":"@delorun/lib"}\n' })
    await expect(stampDelorunVersion(join(root, 'node_modules'), '0.2.0')).rejects.toThrow('the closure does not carry @delorun/cli')
  })

  it('names, in closure.json, the client title and every Delorun bundle of a new CLI profile for the anchor', async () => {
    const recipe = readRecipe().closure
    expect(recipe.clientTitle).toBe('Delorun')
    const { DELORUN_PROFILE_BUNDLES } = await import('@delorun/bundle-local/profile')
    expect([...recipe.anchor.bundles].sort()).toEqual(DELORUN_PROFILE_BUNDLES.filter(bundle => bundle.startsWith('@delorun/')).sort())
  })
})
