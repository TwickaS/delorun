/**
 * Who can reach the actions of Changes: only `delorun changes` and this package. A model tool, a Host route or a plugin
 * that imported an action or an attest function could decide a change without the person at their computer, so every
 * other module of Delo's workspaces, and every upstream module, is scanned for such an import.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

// The scan reads every source file of the repository; under a loaded host that takes longer than vitest's default.
vi.setConfig({ testTimeout: 60_000 })

/** The repository root. */
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

/** The functions that decide a change or prove presence. */
const GUARDED = ['applyChange', 'applyInstallChange', 'discardChange', 'undoChange', 'turnOff', 'turnOn', 'changeProtection', 'setProtection', 'openWorkSession', 'closeWorkSession', 'startWork', 'finishWork', 'attestTerminal']

/** The function that ends a work session without a proof of presence, because Delo stops. */
const STOP_ONLY = 'finishWorkWithoutPerson'

/** The one module outside `delo/packages/changes/src/` that may import it: the start's part of Changes. */
const STOP_IMPORTER = join('delo', 'apps', 'cli', 'src', 'changes', 'start.ts')

/** An import of the entry that exports it. */
const IMPORTS_STOP = /['"]@delo\/changes\/stop['"]|['"][^'"]*\/changes\/src\/stop(?:\.ts)?['"]/

/** Modules outside `delo/apps/cli/src/changes/` and `delo/packages/changes/src/` that may import them; none yet. */
const ALLOWED: readonly string[] = []

/** The directories whose modules may import them. */
const OWNERS = [join('delo', 'apps', 'cli', 'src', 'changes') + sep, join('delo', 'packages', 'changes', 'src') + sep]

/** Source files the scan reads. */
const SOURCE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/

/**
 * @param directory - a directory.
 * @returns every source file below it, skipping `node_modules`.
 */
function sources(directory: string): string[] {
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch (error) {
    // A package without a `src` directory has no module to scan.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return entries.flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sources(path)
    return SOURCE.test(entry.name) ? [path] : []
  })
}

/**
 * @param parent - a directory of package directories, such as `delo/packages`.
 * @returns each package's `src` directory.
 */
function sourceDirectories(parent: string): string[] {
  return readdirSync(join(ROOT, parent), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(ROOT, parent, entry.name, 'src'))
}

/** An import or re-export of Changes: the package name, or a relative path into its sources. */
const IMPORTS_CHANGES = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"](?:@delo\/changes(?:\/[^'"]*)?|[^'"]*\/changes\/src(?:\/[^'"]*)?)['"]/

/**
 * @param text - a module's text.
 * @returns the guarded names it mentions, or `*` for a namespace import or a re-export of everything.
 */
function guardedNames(text: string): string[] {
  if (/import\s*\*\s*as\s+\w+\s+from\s*['"]@delo\/changes/.test(text) || /export\s*\*\s*from\s*['"]@delo\/changes/.test(text) || /import\s*\(\s*['"]@delo\/changes/.test(text)) return ['*']
  return GUARDED.filter(name => new RegExp(`\\b${name}\\b`).test(text))
}

describe('no model tool or route reaches a changes action', () => {
  it('finds the actions and the attest functions imported only by delorun changes and @delo/changes', () => {
    const offenders: string[] = []
    for (const directory of [...sourceDirectories('delo/packages'), ...sourceDirectories('delo/apps')]) {
      for (const file of sources(directory)) {
        const path = relative(ROOT, file)
        const text = readFileSync(file, 'utf8')
        if (path !== STOP_IMPORTER && !path.startsWith(OWNERS[1]!) && IMPORTS_CHANGES.test(text) && (IMPORTS_STOP.test(text) || new RegExp(`\\b${STOP_ONLY}\\b`).test(text))) offenders.push(`${path}: ${STOP_ONLY}`)
        if (OWNERS.some(owner => path.startsWith(owner)) || ALLOWED.includes(path)) continue
        if (!IMPORTS_CHANGES.test(text)) continue
        const names = guardedNames(text)
        if (names.length > 0) offenders.push(`${path}: ${names.join(', ')}`)
      }
    }
    for (const group of readdirSync(join(ROOT, 'packages'), { withFileTypes: true }).filter(entry => entry.isDirectory())) {
      for (const directory of sourceDirectories(join('packages', group.name))) {
        for (const file of sources(directory)) {
          if (IMPORTS_CHANGES.test(readFileSync(file, 'utf8'))) offenders.push(`${relative(ROOT, file)}: imports @delo/changes`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('no tool can apply a change, start or end a work session, or change the protection setting', () => {
    // The two plugins that act for the agent read and record Changes; neither imports a function that decides one.
    for (const plugin of ['plugin-changes', 'plugin-instruction-consent']) {
      const files = sources(join(ROOT, 'delo', 'packages', plugin, 'src'))
      expect(files.some(file => IMPORTS_CHANGES.test(readFileSync(file, 'utf8'))), plugin).toBe(true)
      for (const file of files) {
        const text = readFileSync(file, 'utf8')
        expect(guardedNames(text), relative(ROOT, file)).toEqual([])
        expect(new RegExp(`\\b${STOP_ONLY}\\b`).test(text) || IMPORTS_STOP.test(text), relative(ROOT, file)).toBe(false)
      }
    }
    expect(guardedNames("import { applyInstallChange } from '@delo/changes/install'")).toEqual(['applyInstallChange'])
  })

  it('recognizes an import of a guarded function, a namespace import and a relative import into the sources', () => {
    expect(IMPORTS_CHANGES.test("import { applyChange } from '@delo/changes'")).toBe(true)
    expect(guardedNames("import { applyChange, listChanges } from '@delo/changes'")).toEqual(['applyChange'])
    expect(guardedNames("import * as changes from '@delo/changes'")).toEqual(['*'])
    expect(guardedNames("export * from '@delo/changes'")).toEqual(['*'])
    expect(guardedNames("const changes = await import('@delo/changes')")).toEqual(['*'])
    expect(IMPORTS_CHANGES.test("import { attestTerminal } from '../../changes/src/records.ts'")).toBe(true)
    expect(IMPORTS_CHANGES.test("import { listChanges } from '@delo/changesets'")).toBe(false)
    expect(guardedNames("import { startWork, finishWork } from '@delo/changes'")).toEqual(['startWork', 'finishWork'])
    expect(IMPORTS_STOP.test("import { finishWorkWithoutPerson } from '@delo/changes/stop'")).toBe(true)
    expect(IMPORTS_STOP.test("import { finishWorkWithoutPerson } from '../../changes/src/stop.ts'")).toBe(true)
    expect(IMPORTS_STOP.test("import { listChanges } from '@delo/changes'")).toBe(false)
  })
})
