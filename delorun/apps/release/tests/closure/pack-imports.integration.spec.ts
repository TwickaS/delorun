import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PackEntry, RuntimePlatform, SemanticVersion, Sha256Hex, Sha512Base64 } from '@delorun/contract-release-manifest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { describeUnresolved, importedSpecifiers, packageNameOf, unresolvedPackImports, type PackLayout } from '../../src/closure/pack-imports.ts'
import { buildPack, type PackSources } from '../../src/closure/packs.ts'
import { packCandidates, readWorkspacePackages, selectClosurePackages } from '../../src/closure/plugin-set.ts'
import { packProblemsAt } from '../../src/check-pack-imports.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const temp = (): string => { const root = mkdtempSync(join(tmpdir(), 'delorun-pack-imports-')); roots.push(root); return root }
const put = (root: string, files: Readonly<Record<string, string>>): void => {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), body)
  }
}
const json = (value: object): string => JSON.stringify(value)
const layout = (files: Readonly<Record<string, string>>, peers: readonly string[] = [], external: readonly string[] = []): PackLayout => ({
  paths: new Set(Object.keys(files)),
  read: path => Promise.resolve(files[path]!),
  peers: new Set(peers),
  external: new Set(external),
})

/** The Agent hooks pack as 0.1.0-preview.1.4 built it: the hooks plugin's peer dsh-hook-protocol is in neither the pack nor its peers. */
const HOOKS_PLUGIN = {
  'package.json': json({ name: '@delorun/bundle-agent-hooks', dependencies: { '@deepseek-ai/dsh-hooks-claude-code': '0.1.0' } }),
  'node_modules/@deepseek-ai/dsh-hooks-claude-code/package.json': json({ name: '@deepseek-ai/dsh-hooks-claude-code', dependencies: { '@deepseek-ai/schemastery': '1.0.0' }, peerDependencies: { '@deepseek-ai/dsh-hook-protocol': '*', '@deepseek-ai/dsh-llm': '*' } }),
  'node_modules/@deepseek-ai/dsh-hooks-claude-code/lib/index.js': 'import { readFileSync } from "node:fs";\nimport z from "@deepseek-ai/schemastery";\nimport { createUserMessage } from "@deepseek-ai/dsh-llm";\nimport { runHook } from "@deepseek-ai/dsh-hook-protocol";\n',
}

describe('the package names a pack needs', () => {
  it('reads the package name of a bare specifier and ignores relative, built-in, URL and subpath-import specifiers', () => {
    expect(packageNameOf('@deepseek-ai/dsh-llm/sub/path')).toBe('@deepseek-ai/dsh-llm')
    expect(packageNameOf('zod/v4')).toBe('zod')
    expect(['./a.js', '../b', '/abs', 'node:fs', 'fs', 'fs/promises', '#internal', 'file:///x', 'data:text/javascript,1'].map(packageNameOf)).toEqual(Array(9).fill(undefined))
  })

  it('finds static imports, re-exports, dynamic imports and requires with a string literal', () => {
    expect(importedSpecifiers('import a from "a"\nexport { b } from \'b\'\nconst c = await import("c")\nconst d = require("d")\nimport "e"\nconst f = import(name)\n')).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})

describe('checking that every package of a pack resolves its needs', () => {
  it('passes a pack whose needs are carried, nested beside their importer, linked as peers, fetched or built in', async () => {
    const good = layout({
      'package.json': json({ name: '@delorun/bundle-good', dependencies: { '@deepseek-ai/dsh-plugin': '1.0.0', 'own-dep': '1.0.0' } }),
      'node_modules/@deepseek-ai/dsh-plugin/package.json': json({ name: '@deepseek-ai/dsh-plugin', dependencies: { 'nested-dep': '2.0.0' }, peerDependencies: { '@deepseek-ai/cordis': '*', 'maybe': '*' }, peerDependenciesMeta: { maybe: { optional: true } }, optionalDependencies: { '@vendor/native-linux-x64': '1.0.0' } }),
      'node_modules/@deepseek-ai/dsh-plugin/lib/index.js': 'import "node:path"\nimport "@deepseek-ai/cordis"\nimport "nested-dep"\nimport "./local.js"\nimport "@deepseek-ai/dsh-plugin/package.json"\n',
      'node_modules/@deepseek-ai/dsh-plugin/node_modules/nested-dep/package.json': json({ name: 'nested-dep' }),
      'node_modules/own-dep/package.json': json({ name: 'own-dep', dependencies: { 'native-bin': '1.0.0' } }),
      'node_modules/own-dep/index.js': 'try { require("optional-in-code") } catch {}\n',
    }, ['@deepseek-ai/cordis'], ['native-bin'])
    expect(await unresolvedPackImports(good)).toEqual([])
  })

  it('refuses a pack missing a package one of its packages lists in dependencies', async () => {
    const missing = layout({
      'package.json': json({ name: '@delorun/bundle-bad', dependencies: { 'own-dep': '1.0.0' } }),
      'node_modules/own-dep/package.json': json({ name: 'own-dep', dependencies: { 'left-out': '1.0.0' } }),
    })
    const unresolved = await unresolvedPackImports(missing)
    expect(unresolved).toEqual([{ importer: 'own-dep', directory: 'node_modules/own-dep', name: 'left-out', via: 'dependencies' }])
    expect(describeUnresolved(unresolved[0]!)).toBe('own-dep (node_modules/own-dep) lists left-out in dependencies')
  })

  it('does not let a package resolve what only a sibling package nests', async () => {
    const sibling = layout({
      'package.json': json({ name: '@delorun/bundle-bad', dependencies: { a: '1', b: '1' } }),
      'node_modules/a/package.json': json({ name: 'a', dependencies: { c: '1' } }),
      'node_modules/a/node_modules/c/package.json': json({ name: 'c' }),
      'node_modules/b/package.json': json({ name: 'b', dependencies: { c: '1' } }),
    })
    expect((await unresolvedPackImports(sibling)).map(need => `${need.importer}>${need.name}`)).toEqual(['b>c'])
  })

  it('refuses a workspace package that imports a package it does not declare', async () => {
    const undeclared = layout({
      'package.json': json({ name: '@deepseek-ai/dsh-subagent-demo' }),
      'lib/index.js': 'import { withTimeout } from "@deepseek-ai/dsh-timeout"\n',
    })
    expect(await unresolvedPackImports(undeclared)).toEqual([{ importer: '@deepseek-ai/dsh-subagent-demo', directory: '', name: '@deepseek-ai/dsh-timeout', via: { file: 'lib/index.js' } }])
  })

  it('reports the hooks plugin\'s dsh-hook-protocol, which 0.1.0-preview.1.4\'s Agent hooks pack neither carried nor linked', async () => {
    const built = layout(HOOKS_PLUGIN, ['@deepseek-ai/schemastery', '@deepseek-ai/dsh-llm'])
    expect((await unresolvedPackImports(built)).map(describeUnresolved)).toEqual([
      '@deepseek-ai/dsh-hooks-claude-code (node_modules/@deepseek-ai/dsh-hooks-claude-code) lists @deepseek-ai/dsh-hook-protocol in peerDependencies',
    ])
    const carried = layout({ ...HOOKS_PLUGIN, 'node_modules/@deepseek-ai/dsh-hook-protocol/package.json': json({ name: '@deepseek-ai/dsh-hook-protocol' }) }, ['@deepseek-ai/schemastery', '@deepseek-ai/dsh-llm'])
    expect(await unresolvedPackImports(carried)).toEqual([])
  })
})

describe('building a pack whose packages need what the deployment leaves out', () => {
  const PLATFORMS: RuntimePlatform[] = ['linux-x64']
  function sources(deployed: Readonly<Record<string, string>>, closure: readonly string[]): PackSources {
    const modules = temp()
    for (const name of closure) put(modules, { [`${name}/package.json`]: json({ name, version: '1.0.0' }) })
    return {
      closureNodeModules: () => modules,
      deploy: (_name, _platform, directory) => Promise.resolve(put(directory, deployed)),
      locked: () => undefined,
      download: () => Promise.reject(new Error('no download in this test')),
    }
  }

  it('links a plugin\'s peer dependencies and imports the closure carries as peers', async () => {
    const built = await buildPack('@delorun/bundle-agent-hooks', '0.1.0', true, '0.1.0', PLATFORMS, 1_800_000_000, [], sources({ ...HOOKS_PLUGIN, 'node_modules/@deepseek-ai/dsh-hook-protocol/package.json': json({ name: '@deepseek-ai/dsh-hook-protocol', version: '0.1.0' }) }, ['@deepseek-ai/schemastery', '@deepseek-ai/dsh-llm']), temp())
    expect(built.entry.variants.any!.peers).toEqual(['@deepseek-ai/dsh-llm', '@deepseek-ai/schemastery'])
    expect(built.entry.variants.any!.files.map(file => file.path)).toContain('node_modules/@deepseek-ai/dsh-hook-protocol/package.json')
  })

  it('refuses the cut when neither the pack nor the closure carries a need, naming it', async () => {
    await expect(buildPack('@delorun/bundle-agent-hooks', '0.1.0', true, '0.1.0', PLATFORMS, 1_800_000_000, [], sources(HOOKS_PLUGIN, ['@deepseek-ai/schemastery', '@deepseek-ai/dsh-llm']), temp()))
      .rejects.toThrow(/bundle-agent-hooks for linux-x64 would not load.*dsh-hooks-claude-code.*lists @deepseek-ai\/dsh-hook-protocol in peerDependencies.*list each in @delorun\/bundle-agent-hooks's dependencies/u)
  })
})

describe('checking a built release\'s pack', () => {
  it('reports a signed peer the runtime does not carry, and with --link-carried links what it does carry', async () => {
    const directory = temp()
    put(directory, HOOKS_PLUGIN)
    const runtime = temp()
    put(runtime, { '@deepseek-ai/dsh-llm/package.json': json({ name: '@deepseek-ai/dsh-llm' }), '@deepseek-ai/dsh-hook-protocol/package.json': json({ name: '@deepseek-ai/dsh-hook-protocol' }) })
    const sha256 = brandString<Sha256Hex>('0'.repeat(64))
    const entry: PackEntry = {
      name: '@delorun/bundle-agent-hooks', version: brandString<SemanticVersion>('0.1.0'), experimental: true,
      variants: { any: { archive: { name: 'a.tar.gz', length: 1, sha256, sha512: brandString<Sha512Base64>('x') }, files: Object.keys(HOOKS_PLUGIN).map(path => ({ path, length: 1, sha256, mode: '0644' as const })), external: [], peers: ['@deepseek-ai/schemastery'] } },
    }
    expect(await packProblemsAt(entry, 'linux-x64', directory, runtime)).toEqual([
      '@delorun/bundle-agent-hooks: the peer @deepseek-ai/schemastery is not in the runtime',
      '@delorun/bundle-agent-hooks: @deepseek-ai/dsh-hooks-claude-code (node_modules/@deepseek-ai/dsh-hooks-claude-code) lists @deepseek-ai/dsh-hook-protocol in peerDependencies',
      '@delorun/bundle-agent-hooks: @deepseek-ai/dsh-hooks-claude-code (node_modules/@deepseek-ai/dsh-hooks-claude-code) lists @deepseek-ai/dsh-llm in peerDependencies',
    ])
    expect(await packProblemsAt(entry, 'linux-x64', directory, runtime, true)).toEqual(['@delorun/bundle-agent-hooks: the peer @deepseek-ai/schemastery is not in the runtime'])
  })
})

describe('the workspace\'s packs', () => {
  const root = resolve(import.meta.dirname, '../../../../..')
  interface Manifest { readonly name: string, readonly dependencies?: Record<string, string>, readonly optionalDependencies?: Record<string, string>, readonly peerDependencies?: Record<string, string>, readonly peerDependenciesMeta?: Record<string, { readonly optional?: boolean }> }
  /** Every workspace package by name, from the workspace's package folders. */
  const manifests = new Map<string, Manifest>()
  for (const [parent, depth] of [['packages', 2], ['vendor', 1], ['apps', 1], ['delorun/apps', 1], ['delorun/packages', 1], ['python', 1]] as const) {
    const folders = depth === 1
      ? readdirSync(join(root, parent)).map(name => join(parent, name))
      : readdirSync(join(root, parent)).flatMap(group => (existsSync(join(root, parent, group, 'package.json')) || !statSync(join(root, parent, group)).isDirectory() ? [] : readdirSync(join(root, parent, group)).map(name => join(parent, group, name))))
    for (const folder of folders) {
      if (!existsSync(join(root, folder, 'package.json'))) continue
      const manifest = JSON.parse(readFileSync(join(root, folder, 'package.json'), 'utf8')) as Manifest
      manifests.set(manifest.name, manifest)
    }
  }
  /** The workspace packages a deployment of `roots` installs: their `dependencies` and `optionalDependencies`, not their peers. */
  const deployed = (roots: readonly string[]): Set<string> => {
    const found = new Set<string>()
    const queue = [...roots]
    while (queue.length > 0) {
      const name = queue.shift()!
      const manifest = manifests.get(name)
      if (found.has(name) || manifest === undefined) continue
      found.add(name)
      queue.push(...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {}))
    }
    return found
  }

  it('carries each workspace package a pack\'s packages declare as a peer, or the runtime closure carries it', () => {
    const closure = deployed(Object.keys(manifests.get('@delorun/runtime-closure')!.dependencies ?? {}))
    const packages = readWorkspacePackages(root)
    const missing: string[] = []
    for (const pack of packCandidates(packages, selectClosurePackages(packages), closure)) {
      const inPack = deployed([pack.name])
      for (const name of inPack) {
        const manifest = manifests.get(name)!
        for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
          if (manifest.peerDependenciesMeta?.[peer]?.optional === true || !manifests.has(peer)) continue
          if (!inPack.has(peer) && !closure.has(peer)) missing.push(`${pack.name}: ${name} needs ${peer}`)
        }
      }
    }
    expect(missing).toEqual([])
  })
})
