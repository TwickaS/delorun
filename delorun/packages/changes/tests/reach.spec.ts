/**
 * Who can reach the actions of Changes: only `delorun changes`, this package and the studio's Changes routes
 * (`delorun/packages/plugin-changes/src/routes.ts`), which attest a studio request at the computer or from a paired
 * device the person unlocked. A model tool, another
 * Host route or a plugin that imported an action or an attest function could decide a change without the person at
 * their computer, so every other module of Delorun's workspaces, and every upstream module, is scanned for such an import.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

// The scan reads every source file of the repository; under a loaded host that takes longer than vitest's default.
vi.setConfig({ testTimeout: 60_000 })

/** The repository root. */
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

/**
 * The functions that decide a change to Delorun itself or write the person's copy of it, which a terminal and the
 * studio's harness routes run.
 */
const HARNESS_ACTIONS = ['applyHarnessChange', 'discardHarnessChange', 'undoHarnessChange', 'discardAllHarnessChanges', 'createHarnessCopy']

/** The functions that decide a change or prove presence. */
const GUARDED = ['applyChange', 'applyInstallChange', 'applySetupImport', 'discardChange', 'undoChange', 'turnOff', 'turnOn', 'changeProtection', 'setProtection', 'openWorkSession', 'closeWorkSession', 'startWork', 'finishWork', 'attestTerminal', 'attestStudio', 'attestDevice', 'dismissNotice', 'leaveOutNewestChange', ...HARNESS_ACTIONS]

/** The function that leaves a change out without a proof of presence, because a start failed. */
const START_ONLY = 'leaveOutNewestChange'

/** The one module outside `delorun/packages/changes/src/` that may name it: the start's retry. */
const START_IMPORTER = join('delorun', 'apps', 'cli', 'src', 'changes', 'retry.ts')

/**
 * The functions that load content without a proof of presence while protection is off, each with the one module
 * outside `delorun/packages/changes/src/` that may name it: the running Host's watch of linked plugins' folders, and the
 * start's application of the edits in the harness's writable copy.
 */
const UNREVIEWED_LOADERS: Readonly<Record<string, string>> = {
  loadUnreviewed: join('delorun', 'apps', 'cli', 'src', 'changes', 'unreviewed-watch.ts'),
  applyUnreviewedHarnessChanges: join('delorun', 'apps', 'cli', 'src', 'changes', 'harness-start.ts'),
}

/** The function that ends a work session without a proof of presence, because Delorun stops. */
const STOP_ONLY = 'finishWorkWithoutPerson'

/** The one module outside `delorun/packages/changes/src/` that may import it: the start's part of Changes. */
const STOP_IMPORTER = join('delorun', 'apps', 'cli', 'src', 'changes', 'start.ts')

/** An import of the entry that exports it. */
const IMPORTS_STOP = /['"]@delorun\/changes\/stop['"]|['"][^'"]*\/changes\/src\/stop(?:\.ts)?['"]/

/** The studio's Changes routes, the one module of a plugin that may import them. */
const ROUTES = join('delorun', 'packages', 'plugin-changes', 'src', 'routes.ts')

/** Modules outside `delorun/apps/cli/src/changes/` and `delorun/packages/changes/src/` that may import them. */
const ALLOWED: readonly string[] = [ROUTES]

/** The directories whose modules may import them. */
const OWNERS = [join('delorun', 'apps', 'cli', 'src', 'changes') + sep, join('delorun', 'packages', 'changes', 'src') + sep]

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
 * @param parent - a directory of package directories, such as `delorun/packages`.
 * @returns each package's `src` directory.
 */
function sourceDirectories(parent: string): string[] {
  return readdirSync(join(ROOT, parent), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(ROOT, parent, entry.name, 'src'))
}

/** An import or re-export of Changes: the package name, or a relative path into its sources. */
const IMPORTS_CHANGES = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"](?:@delorun\/changes(?:\/[^'"]*)?|[^'"]*\/changes\/src(?:\/[^'"]*)?)['"]/

/**
 * @param text - a module's text.
 * @returns the guarded names it mentions, or `*` for a namespace import or a re-export of everything.
 */
function guardedNames(text: string): string[] {
  if (/import\s*\*\s*as\s+\w+\s+from\s*['"]@delorun\/changes/.test(text) || /export\s*\*\s*from\s*['"]@delorun\/changes/.test(text) || /import\s*\(\s*['"]@delorun\/changes/.test(text)) return ['*']
  return GUARDED.filter(name => new RegExp(`\\b${name}\\b`).test(text))
}

describe('no model tool or route reaches a changes action', () => {
  it('finds the actions and the attest functions imported only by delorun changes and @delorun/changes', () => {
    const offenders: string[] = []
    for (const directory of [...sourceDirectories('delorun/packages'), ...sourceDirectories('delorun/apps')]) {
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
          if (IMPORTS_CHANGES.test(readFileSync(file, 'utf8'))) offenders.push(`${relative(ROOT, file)}: imports @delorun/changes`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('no tool can apply a change, start or end a work session, or change the protection setting', () => {
    // The two plugins that act for the agent read and record Changes; neither imports a function that decides one,
    // apart from the studio's routes, which no tool reaches.
    for (const plugin of ['plugin-changes', 'plugin-instruction-consent']) {
      const files = sources(join(ROOT, 'delorun', 'packages', plugin, 'src'))
      expect(files.some(file => IMPORTS_CHANGES.test(readFileSync(file, 'utf8'))), plugin).toBe(true)
      for (const file of files) {
        const text = readFileSync(file, 'utf8')
        if (relative(ROOT, file) === ROUTES) continue
        expect(guardedNames(text), relative(ROOT, file)).toEqual([])
        expect(new RegExp(`\\b${STOP_ONLY}\\b`).test(text) || IMPORTS_STOP.test(text), relative(ROOT, file)).toBe(false)
      }
    }
    expect(guardedNames("import { applyInstallChange } from '@delorun/changes/install'")).toEqual(['applyInstallChange'])
  })

  it('the studio routes are the only module that attests a studio request, and they do', () => {
    const routes = readFileSync(join(ROOT, ROUTES), 'utf8')
    expect(IMPORTS_CHANGES.test(routes)).toBe(true)
    // The routes attest the person at the computer and a paired device the person unlocked, and decide the protection
    // setting and changes to Delorun itself with that proof, as the terminal decides them with its own. They change the
    // protection setting only through `changeProtection`, which logs a weakening and keeps a device's notice, never write
    // it directly, never mint the terminal's proof, and never discard every change to Delorun itself at once.
    for (const name of ['attestStudio', 'attestDevice', 'changeProtection', 'dismissNotice', 'applyInstallChange', 'applyHarnessChange', 'undoHarnessChange', 'discardHarnessChange', 'createHarnessCopy']) expect(guardedNames(routes), name).toContain(name)
    for (const name of ['setProtection', 'attestTerminal', 'discardAllHarnessChanges']) expect(guardedNames(routes), name).not.toContain(name)
    expect(guardedNames(routes)).not.toContain('*')
  })

  it('only the start\'s retry leaves a change out, and no route, tool or plugin names it', () => {
    const naming: string[] = []
    for (const directory of [...sourceDirectories('delorun/packages'), ...sourceDirectories('delorun/apps')]) {
      for (const file of sources(directory)) {
        const path = relative(ROOT, file)
        if (!path.startsWith(OWNERS[1]!) && new RegExp(`\\b${START_ONLY}\\b`).test(readFileSync(file, 'utf8'))) naming.push(path)
      }
    }
    expect(naming).toEqual([START_IMPORTER])
  })

  it('only the Host\'s folder watch and the start load content without review, and no route, tool or plugin names them', () => {
    const naming: Record<string, string[]> = Object.fromEntries(Object.keys(UNREVIEWED_LOADERS).map(name => [name, []]))
    for (const directory of [...sourceDirectories('delorun/packages'), ...sourceDirectories('delorun/apps')]) {
      for (const file of sources(directory)) {
        const path = relative(ROOT, file)
        if (path.startsWith(OWNERS[1]!)) continue
        const text = readFileSync(file, 'utf8')
        for (const name of Object.keys(UNREVIEWED_LOADERS)) {
          if (new RegExp(`\\b${name}\\b`).test(text)) naming[name]!.push(path)
        }
      }
    }
    expect(naming).toEqual(Object.fromEntries(Object.entries(UNREVIEWED_LOADERS).map(([name, importer]) => [name, [importer]])))
  })

  it('recognizes an import of a guarded function, a namespace import and a relative import into the sources', () => {
    expect(IMPORTS_CHANGES.test("import { applyChange } from '@delorun/changes'")).toBe(true)
    expect(guardedNames("import { applyChange, listChanges } from '@delorun/changes'")).toEqual(['applyChange'])
    expect(guardedNames("import * as changes from '@delorun/changes'")).toEqual(['*'])
    expect(guardedNames("export * from '@delorun/changes'")).toEqual(['*'])
    expect(guardedNames("const changes = await import('@delorun/changes')")).toEqual(['*'])
    expect(IMPORTS_CHANGES.test("import { attestTerminal } from '../../changes/src/records.ts'")).toBe(true)
    expect(IMPORTS_CHANGES.test("import { listChanges } from '@delorun/changesets'")).toBe(false)
    expect(guardedNames("import { startWork, finishWork } from '@delorun/changes'")).toEqual(['startWork', 'finishWork'])
    expect(guardedNames("import { applyHarnessChange, createHarnessCopy, readHarnessLog } from '@delorun/changes'")).toEqual(['applyHarnessChange', 'createHarnessCopy'])
    expect(IMPORTS_STOP.test("import { finishWorkWithoutPerson } from '@delorun/changes/stop'")).toBe(true)
    expect(IMPORTS_STOP.test("import { finishWorkWithoutPerson } from '../../changes/src/stop.ts'")).toBe(true)
    expect(IMPORTS_STOP.test("import { listChanges } from '@delorun/changes'")).toBe(false)
  })
})
