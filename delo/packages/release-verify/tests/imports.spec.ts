/**
 * The package's import graph: the store is the one module that reaches the filesystem, and no module of the
 * verification path imports it, directly or through another module. A bundle, a checkpoint or a log answer is read as
 * bytes the caller passes, so nothing an attacker writes into one of them can name a file this package opens.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SOURCE = join(import.meta.dirname, '../src')

/** Every module of the package, with the specifiers it imports. */
const MODULES = new Map(readdirSync(SOURCE).filter(name => name.endsWith('.ts')).map((name) => {
  const text = readFileSync(join(SOURCE, name), 'utf8')
  const specifiers = [...text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"]*?from\s+'([^']+)'|import\(\s*'([^']+)'\s*\)/gu)].map(match => match[1] ?? match[2]!)
  return [name, specifiers] as const
}))

/** The modules a verification reads through: none may reach the filesystem. */
const VERIFICATION_PATH = ['bundle.ts', 'checkpoint.ts', 'entry.ts', 'errors.ts', 'json.ts', 'merkle.ts', 'note.ts', 'online.ts', 'paths.ts', 'start.ts', 'state.ts', 'transport.ts']

/**
 * The modules one module reaches through relative imports, itself included.
 * @param name - the module's file name.
 * @returns every module it reaches.
 */
function reach(name: string): Set<string> {
  const seen = new Set<string>()
  const pending = [name]
  while (pending.length > 0) {
    const next = pending.pop()!
    if (seen.has(next)) continue
    seen.add(next)
    for (const specifier of MODULES.get(next) ?? []) if (specifier.startsWith('./')) pending.push(specifier.slice(2))
  }
  return seen
}

describe('the filesystem', () => {
  it('is imported by the store alone, through node:fs and @delo/home', () => {
    const importers = [...MODULES].filter(([, specifiers]) => specifiers.some(specifier => /^(?:node:)?fs(?:\/promises)?$/u.test(specifier) || specifier === '@delo/home')).map(([name]) => name)
    expect(importers).toEqual(['store.ts'])
  })

  it('is reached by no module of the verification path, directly or through another module', () => {
    expect(VERIFICATION_PATH.every(name => MODULES.has(name))).toBe(true)
    for (const name of VERIFICATION_PATH) expect([...reach(name)], name).not.toContain('store.ts')
  })

  it('is reached only by the modules that keep the two records', () => {
    const reaching = [...MODULES.keys()].filter(name => reach(name).has('store.ts')).sort()
    expect(reaching).toEqual(['index.ts', 'record.ts', 'service.ts', 'store.ts'])
  })
})
