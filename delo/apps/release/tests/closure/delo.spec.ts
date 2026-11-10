/**
 * Delo's packages in a staged closure: TypeScript sources become JavaScript that plain Node imports from
 * `node_modules`, with entry points and relative imports rewritten, and the install anchor declares each Delo bundle.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { declareAnchorBundles, stampDeloVersion, transpileDeloPackages } from '../../src/closure/delo.ts'
import { readRecipe } from '../../src/closure/config.ts'
import { scratch, writeTree } from '../support.ts'

function stagedTree(root: string): void {
  writeTree(root, {
    'node_modules/@delo/lib/package.json': JSON.stringify({ name: '@delo/lib', version: '0.0.0', type: 'module', exports: { '.': './src/index.ts', './types': { types: './src/types.d.ts' }, './package.json': './package.json' } }),
    'node_modules/@delo/lib/src/index.ts': "import { twice } from './math.ts'\nimport type { Shape } from './types.d.ts'\nexport const shape: Shape = { size: twice(21) }\nexport type { Shape }\n",
    'node_modules/@delo/lib/src/math.ts': 'export function twice(value: number): number {\n  return value * 2\n}\n',
    'node_modules/@delo/lib/src/types.d.ts': 'export interface Shape { readonly size: number }\n',
    'node_modules/@delo/lib/tests/lib.spec.ts': "import { shape } from '../src/index.ts'\n",
    'node_modules/@delo/cli/package.json': JSON.stringify({ name: '@delo/cli', version: '0.0.0', type: 'module', bin: { delorun: './src/bin.ts' }, dependencies: { '@delo/lib': 'workspace:*' } }),
    'node_modules/@delo/cli/src/bin.ts': "import { shape } from '@delo/lib'\nconst size: number = shape.size\nconsole.log(`size ${String(size)}`)\n",
    'node_modules/@delo/bundle-local/package.json': JSON.stringify({ name: '@delo/bundle-local', version: '1.2.3', main: 'lib/index.js' }),
    'node_modules/@delo/bundle-local/lib/index.js': 'export default {}\n',
    'node_modules/@deepseek-ai/dsh/package.json': JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2', dependencies: { zod: '4.4.3', '@deepseek-ai/dsh-brand': '0.2.2' } }),
  })
}

describe('Delo packages in a closure', () => {
  it('transpiles each package\'s sources so plain Node runs them from node_modules, and drops its tests', async (test) => {
    const root = scratch(test)
    stagedTree(root)
    expect(await transpileDeloPackages(join(root, 'node_modules'))).toEqual(['@delo/bundle-local', '@delo/cli', '@delo/lib'])
    const lib = join(root, 'node_modules/@delo/lib')
    expect(existsSync(join(lib, 'src/index.ts'))).toBe(false)
    expect(existsSync(join(lib, 'tests'))).toBe(false)
    expect(readFileSync(join(lib, 'src/index.js'), 'utf8')).toContain('from "./math.js"')
    expect(readFileSync(join(lib, 'src/types.d.ts'), 'utf8')).toContain('Shape')
    expect(JSON.parse(readFileSync(join(lib, 'package.json'), 'utf8')).exports).toEqual({ '.': './src/index.js', './types': { types: './src/types.d.ts' }, './package.json': './package.json' })
    expect(JSON.parse(readFileSync(join(root, 'node_modules/@delo/cli/package.json'), 'utf8')).bin).toEqual({ delorun: './src/bin.js' })
    const run = spawnSync(process.execPath, [join(root, 'node_modules/@delo/cli/src/bin.js')], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH } })
    expect(run.stderr).toBe('')
    expect(run.stdout).toBe('size 42\n')
  })

  it('rewrites entry points in arrays, and leaves other values in an entry field as they are', async (test) => {
    const root = scratch(test)
    writeTree(root, {
      'node_modules/@delo/mixed/package.json': JSON.stringify({ name: '@delo/mixed', version: '0.0.0', exports: ['./src/index.ts', './src/other.js'], imports: { '#plain': null, '#flag': true } }),
      'node_modules/@delo/mixed/src/index.ts': 'export const one: number = 1\n',
    })
    await transpileDeloPackages(join(root, 'node_modules'))
    const manifest = JSON.parse(readFileSync(join(root, 'node_modules/@delo/mixed/package.json'), 'utf8'))
    expect(manifest.exports).toEqual(['./src/index.js', './src/other.js'])
    expect(manifest.imports).toEqual({ '#plain': null, '#flag': true })
  })

  it('refuses a source that does not transpile, naming it', async (test) => {
    const root = scratch(test)
    writeTree(root, {
      'node_modules/@delo/broken/package.json': JSON.stringify({ name: '@delo/broken', version: '0.0.0', exports: './src/index.ts' }),
      'node_modules/@delo/broken/src/index.ts': 'export const = 1\n',
    })
    await expect(transpileDeloPackages(join(root, 'node_modules'))).rejects.toThrow(/@delo\/broken\/src\/index\.ts does not transpile/u)
  })

  it('has the install anchor declare each Delo bundle at its staged version, and refuses a bundle the closure lacks', async (test) => {
    const root = scratch(test)
    stagedTree(root)
    const nodeModules = join(root, 'node_modules')
    await declareAnchorBundles(nodeModules, '@deepseek-ai/dsh', ['@delo/bundle-local'])
    expect(JSON.parse(readFileSync(join(nodeModules, '@deepseek-ai/dsh/package.json'), 'utf8')).dependencies).toEqual({ '@deepseek-ai/dsh-brand': '0.2.2', '@delo/bundle-local': '1.2.3', 'zod': '4.4.3' })
    await expect(declareAnchorBundles(nodeModules, '@deepseek-ai/dsh', ['@delo/missing'])).rejects.toThrow('the closure does not carry @delo/missing, which closure.json\'s anchor names')
    writeTree(root, { 'node_modules/@delo/unversioned/package.json': '{"name":"@delo/unversioned"}\n' })
    await expect(declareAnchorBundles(nodeModules, '@deepseek-ai/dsh', ['@delo/unversioned'])).rejects.toThrow('@delo/unversioned\'s package.json names no version')
  })

  it('stamps the release version into the delorun package, where delorun --version reads it, and into no other package', async (test) => {
    const root = scratch(test)
    stagedTree(root)
    const nodeModules = join(root, 'node_modules')
    await stampDeloVersion(nodeModules, '0.2.0')
    const manifest = JSON.parse(readFileSync(join(nodeModules, '@delo/cli/package.json'), 'utf8')) as { version: string, bin: unknown }
    expect(manifest.version).toBe('0.2.0')
    expect(manifest.bin).toEqual({ delorun: './src/bin.ts' })
    expect(JSON.parse(readFileSync(join(nodeModules, '@delo/lib/package.json'), 'utf8')).version).toBe('0.0.0')
    await stampDeloVersion(nodeModules, '0.3.0-rc.1')
    expect(JSON.parse(readFileSync(join(nodeModules, '@delo/cli/package.json'), 'utf8')).version).toBe('0.3.0-rc.1')
  })

  it('refuses to stamp a closure that carries no delorun package', async (test) => {
    const root = scratch(test)
    writeTree(root, { 'node_modules/@delo/lib/package.json': '{"name":"@delo/lib"}\n' })
    await expect(stampDeloVersion(join(root, 'node_modules'), '0.2.0')).rejects.toThrow('the closure does not carry @delo/cli')
  })

  it('names, in closure.json, the client title and every Delo bundle of a new CLI profile for the anchor', async () => {
    const recipe = readRecipe().closure
    expect(recipe.clientTitle).toBe('Delo')
    const { DELO_PROFILE_BUNDLES } = await import('@delo/bundle-local/profile')
    expect([...recipe.anchor.bundles].sort()).toEqual(DELO_PROFILE_BUNDLES.filter(bundle => bundle.startsWith('@delo/')).sort())
  })
})
