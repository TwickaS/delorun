/**
 * The persisted-key enumeration spec of contract C10
 * (`delorun/docs/contracts/c10-host-qualified-keys.md`).
 *
 * C10 fixes the enumeration method: the inventory constant in this package is
 * the list of every browser entry the studio writes, the spec fails on an
 * entry that is not in the inventory, and every persisted key carries a host
 * id. The inventory is additive — a change that writes a new entry adds its
 * row here in the same change.
 *
 * The static checks read the writing packages' sources as text: a storage call whose key
 * argument names a `dsh.` persist name — as a literal, or through a constant that
 * initializes to one — must go through the host-qualified composer. The runtime
 * half — that a key written for one host is not read on another, that two
 * connections with one upstream id keep separate browser state, and that the
 * composition keeps the bare stock shape until the studio names a host id —
 * is proven by the client specs beside the persistence engine
 * (`packages/client/store/tests/persistence-host.client.spec.ts` and the
 * host-qualified cases in the five writing packages' specs).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PERSISTED_KEYS, PERSISTED_SCOPE_KINDS } from '../src/index.ts'

/** Repository root: five levels above this file (file → tests → package → packages → delorun → root). */
const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..')

/** The client packages C10's Consumers list as the studio's change surface for host-qualified scopes. */
const CONSUMER_PACKAGES = [
  'packages/client/store',
  'packages/client/ui-workspace',
  'packages/client/ui-conversation',
  'packages/client/ui-sidebar-right',
  'packages/client/ui-schedule',
  'packages/client/ui-user-questions',
] as const

/** The source directory of a package whose persisted keys the spec enumerates. */
const SOURCE_DIR = 'src'

/** Collect every TypeScript source file under one package directory. */
function sourceFilesOf(owner: string): readonly { readonly path: string; readonly text: string }[] {
  const root = join(REPO_ROOT, owner)
  const files: { path: string; text: string }[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry)
      if (statSync(path).isDirectory()) {
        if (entry !== 'node_modules') walk(path)
        continue
      }
      if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
        files.push({ path, text: readFileSync(path, 'utf8') })
      }
    }
  }
  for (const dir of [SOURCE_DIR]) {
    try { walk(join(root, dir)) } catch { /* A package without that directory writes nothing in it. */ }
  }
  return files
}

/** Every `localStorage.<method>(` call's argument head, up to the first closing parenthesis. */
function storageCallArguments(text: string): readonly string[] {
  return [...text.matchAll(/localStorage\s*\.\s*(?:getItem|setItem|removeItem)\s*\(\s*([^)]*)/g)]
    .map(match => match[1])
}

/** Every `dsh.`-prefixed storage name appearing in one source text. */
function persistedNameCandidates(text: string): readonly string[] {
  return [...text.matchAll(/dsh\.[A-Za-z0-9._-]+/g)].map(match => match[0])
}

/** The module-level constants of one source text that initialize to a `dsh.`-prefixed name. */
function declaredPersistNameConstants(text: string): readonly (readonly [string, string])[] {
  return [...text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=\n]+)?=\s*(['`"])(dsh\.[A-Za-z0-9._-]+)\2/g)]
    .map(match => [match[1], match[3]] as const)
}

/** The violation message for one bare `dsh.` name: undeclared when the inventory does not list it. */
function violationFor(name: string): string {
  return PERSISTED_KEYS.some(entry => entry.name === name)
    ? `persisted key '${name}' is stored without a host id (bare persist name)`
    : `undeclared persisted key '${name}' is not in the inventory`
}

/**
 * Persisted-key violations in one source text: a storage call whose key argument names a
 * `dsh.`-prefixed persist name — as a literal, or through a constant that initializes to
 * one — without the host-qualified composer, whether or not the inventory lists the name.
 * @param text - one source file's text.
 * @returns one human-readable violation per finding.
 */
export function persistedKeyViolations(text: string): readonly string[] {
  const violations = new Set<string>()
  const declared = declaredPersistNameConstants(text)
  for (const argument of storageCallArguments(text)) {
    // A composed call joins the host id with the scope itself; its arguments are not read bare.
    if (argument.includes('qualifiedPersistKey')) continue
    for (const name of persistedNameCandidates(argument)) violations.add(violationFor(name))
    for (const [identifier, name] of declared) {
      if (new RegExp(`\\b${identifier.replace(/\$/g, '\\$')}\\b`).test(argument)) violations.add(violationFor(name))
    }
  }
  return [...violations]
}

describe('the persisted browser key inventory', () => {
  it('declares every entry with a known storage, owner, and scope kind', () => {
    expect(PERSISTED_KEYS.length).toBeGreaterThan(0)
    for (const entry of PERSISTED_KEYS) {
      expect(entry.storage, entry.name).toBe('localStorage')
      expect(PERSISTED_SCOPE_KINDS, entry.name).toContain(entry.scope)
      expect(() => statSync(join(REPO_ROOT, entry.owner)), entry.name).not.toThrow()
    }
  })

  it('is written by its owner package: the persist name occurs in the owner\'s sources', () => {
    const cache = new Map<string, ReturnType<typeof sourceFilesOf>>()
    for (const entry of PERSISTED_KEYS) {
      const files = cache.get(entry.owner) ?? sourceFilesOf(entry.owner)
      cache.set(entry.owner, files)
      const written = files.some(file => file.text.includes(entry.name))
      expect(written, `${entry.name} must occur in ${entry.owner}'s sources`).toBe(true)
    }
  })

  it('writes every studio entry under a host id in the changed client packages', () => {
    for (const owner of CONSUMER_PACKAGES) {
      for (const file of sourceFilesOf(owner)) {
        const violations = persistedKeyViolations(file.text)
        expect(violations, `${owner}: ${file.path.replace(`${REPO_ROOT}/`, '')}`).toEqual([])
      }
    }
  })

  it('declares every persisted store in the changed client packages in the inventory', () => {
    for (const owner of CONSUMER_PACKAGES) {
      for (const file of sourceFilesOf(owner)) {
        const declared = [...file.text.matchAll(/persist:\s*'([^']+)'/g)].map(match => match[1])
        for (const name of declared) {
          expect(PERSISTED_KEYS.some(entry => entry.name === name), `${name} in ${owner}`).toBe(true)
        }
      }
    }
  })
})

describe('the enumeration spec refuses what the inventory does not allow', () => {
  it('persisted-key inventory refuses an undeclared key', () => {
    const fixture = "  localStorage.setItem('dsh.schedule.brand-new.v1', JSON.stringify(state))\n"
    expect(persistedKeyViolations(fixture)).toEqual([
      "undeclared persisted key 'dsh.schedule.brand-new.v1' is not in the inventory",
    ])
  })

  it('persisted key without a host id fails the spec', () => {
    const fixture = "  const raw = localStorage.getItem('dsh.schedule.recent-time-zones.v1')\n"
    expect(persistedKeyViolations(fixture)).toEqual([
      "persisted key 'dsh.schedule.recent-time-zones.v1' is stored without a host id (bare persist name)",
    ])
  })

  it('a bare key reached through a constant that names a listed entry fails the spec', () => {
    const fixture = [
      "const STORAGE_KEY = 'dsh.schedule.recent-time-zones.v1'",
      'const raw = localStorage.getItem(STORAGE_KEY)',
      "localStorage.setItem(STORAGE_KEY, JSON.stringify(state))",
      '',
    ].join('\n')
    expect(persistedKeyViolations(fixture)).toEqual([
      "persisted key 'dsh.schedule.recent-time-zones.v1' is stored without a host id (bare persist name)",
    ])
  })

  it('a bare key through a constant that names an unlisted entry fails the spec as undeclared', () => {
    const fixture = [
      "const KEY = 'dsh.schedule.brand-new.v1'",
      'localStorage.removeItem(KEY)',
      '',
    ].join('\n')
    expect(persistedKeyViolations(fixture)).toEqual([
      "undeclared persisted key 'dsh.schedule.brand-new.v1' is not in the inventory",
    ])
  })

  it('a constant composed through the host-qualified composer passes the enumeration', () => {
    const fixture = [
      "const STORAGE_KEY = 'dsh.schedule.recent-time-zones.v1'",
      'const raw = localStorage.getItem(qualifiedPersistKey(STORAGE_KEY))',
      "localStorage.setItem(qualifiedPersistKey(STORAGE_KEY), JSON.stringify(state))",
      '',
    ].join('\n')
    expect(persistedKeyViolations(fixture)).toEqual([])
  })

  it('a host-qualified composition passes the enumeration', () => {
    const fixture = "  const raw = localStorage.getItem(qualifiedPersistKey('dsh.schedule.recent-time-zones.v1'))\n"
    expect(persistedKeyViolations(fixture)).toEqual([])
  })
})
