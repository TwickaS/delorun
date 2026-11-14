/** Delorun's bundles in a CLI profile: linking them with captured output, and the refusals of a start that lost any. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PackageOperationOptions } from '@deepseek-ai/dsh-plugin-manager/operations'
import { LOCAL_BUNDLE, STUDIO_BUNDLE } from '@delorun/bundle-local/profile'
import { Redactor, resolveSurface, SurfaceLog } from '@delorun/logs'
import {
  carriedPackageDirectory,
  delorunRowIds,
  inactiveDelorunRows,
  inactiveRowsRefusal,
  LINKING_PROGRESS,
  linkDelorunBundles,
  refuseSkippedDelorunBundles,
  type BootedRow,
  type BundleLinking,
  type LinkReport,
} from '../src/delorun-bundles.ts'
import { CliError, EXIT } from '../src/exit.ts'

const PROFILE = 'default'

let home: string
let log: SurfaceLog
let progress: string[]
let report: LinkReport

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'delorun-bundles-'))
  log = SurfaceLog.open({ location: resolveSurface({ kind: 'home', home, profile: PROFILE }), redactor: new Redactor(), pid: process.pid, level: 'info', onFailure: () => {}, now: Date.now })
  progress = []
  report = { log, progress: (text) => { progress.push(text) } }
})

afterEach(() => {
  log.close()
  rmSync(home, { recursive: true, force: true })
})

/** One plugin operation a linking ran. */
interface Operation {
  readonly args: readonly string[]
  readonly options: PackageOperationOptions
}

/**
 * A linking whose resolution supplies the named bundles, and whose plugin operation prints and exits as told.
 * @param operations - collects each operation.
 * @param supplied - the bundles the resolution layers and can import.
 * @param run - what each operation does with its output callback; it returns the exit code.
 * @returns the linking.
 */
function linking(operations: Operation[], supplied: readonly string[], run: (onOutput: NonNullable<PackageOperationOptions['onOutput']>) => Promise<number>): BundleLinking {
  return {
    installAnchor: '/install/package.json',
    resolve: () => Promise.resolve({
      profile: { layers: supplied.map(packageName => ({ packageName })) },
      resolution: { entries: supplied.map(name => ({ name })), localPackageNames: [] },
    } as never),
    runPluginCommand: async (_context, args, options) => {
      operations.push({ args, options })
      return { exitCode: await run(options.onOutput ?? (() => {})), logPath: '/upstream/pnpm.log' }
    },
  }
}

/**
 * @returns the records in the home log, as `<logger> <level> <source> <msg>`.
 */
function logged(): string[] {
  return readFileSync(log.location.file, 'utf8').split('\n').filter(line => line !== '').map((line) => {
    const record = JSON.parse(line) as { logger: string, level: string, source: string, msg: string }
    return `${record.logger} ${record.level} ${record.source} ${record.msg}`
  })
}

describe('linking Delorun\'s bundles', () => {
  it('links each bundle the resolution does not supply, with its output in the home log and one progress line', async () => {
    const operations: Operation[] = []
    const make = linking(operations, [LOCAL_BUNDLE], async (onOutput) => {
      onOutput('Progress: resolved 1, reused 1\n/abs/path/node_modules ', 'stdout')
      onOutput('+ linked\n', 'stdout')
      onOutput('WARN deprecated', 'stderr')
      return Promise.resolve(0)
    })
    await linkDelorunBundles(home, PROFILE, ['@deepseek-ai/dsh-base', LOCAL_BUNDLE, STUDIO_BUNDLE], make, report)
    expect(progress).toEqual([LINKING_PROGRESS, 'done\n'])
    expect(LINKING_PROGRESS).toBe('Linking Delorun\'s parts into the profile… ')
    expect(operations).toHaveLength(1)
    expect(operations[0]?.args).toEqual(['add', `link:${String(carriedPackageDirectory(STUDIO_BUNDLE))}`])
    expect(operations[0]?.options).toMatchObject({ execution: 'service' })
    expect(logged()).toEqual([
      'stdout info captured Progress: resolved 1, reused 1',
      'stdout info captured /abs/path/node_modules + linked',
      'stderr warn captured WARN deprecated',
    ])
  })

  it('prints nothing and runs nothing when every Delorun bundle is supplied', async () => {
    const operations: Operation[] = []
    await linkDelorunBundles(home, PROFILE, [LOCAL_BUNDLE, STUDIO_BUNDLE], linking(operations, [LOCAL_BUNDLE, STUDIO_BUNDLE], () => Promise.resolve(0)), report)
    expect(operations).toEqual([])
    expect(progress).toEqual([])
  })

  it('refuses a bundle this installation does not carry before it prints or runs anything', async () => {
    const operations: Operation[] = []
    await expect(linkDelorunBundles(home, PROFILE, ['@delorun/not-carried'], linking(operations, [], () => Promise.resolve(0)), report))
      .rejects.toThrow('this installation of Delorun does not carry @delorun/not-carried, which the CLI profile default needs; reinstall Delorun')
    expect(operations).toEqual([])
    expect(progress).toEqual([])
  })

  it('ends the progress line in failed and names the home log when pnpm exits non-zero', async () => {
    const make = linking([], [], async (onOutput) => {
      onOutput('ERR_PNPM_LINK something failed\n', 'stderr')
      return Promise.resolve(1)
    })
    let thrown: unknown
    try {
      await linkDelorunBundles(home, PROFILE, [LOCAL_BUNDLE], make, report)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(CliError)
    expect((thrown as CliError).exit).toBe(EXIT.failed)
    expect((thrown as CliError).message).toBe(`delorun setup: could not add ${LOCAL_BUNDLE} to the CLI profile default (pnpm exited 1); its output is in ${log.location.file}`)
    expect(progress).toEqual([LINKING_PROGRESS, 'failed\n'])
    expect(logged()).toEqual(['stderr warn captured ERR_PNPM_LINK something failed'])
  })

  it('ends the progress line in failed and passes on an operation that rejects', async () => {
    const make = linking([], [], () => Promise.reject(new Error('lock wait timed out')))
    await expect(linkDelorunBundles(home, PROFILE, [LOCAL_BUNDLE], make, report)).rejects.toThrow('lock wait timed out')
    expect(progress).toEqual([LINKING_PROGRESS, 'failed\n'])
  })
})

describe('the packages this installation carries', () => {
  it('finds the directory of a Delorun package it carries, and none for one it does not', () => {
    expect(carriedPackageDirectory(LOCAL_BUNDLE)).toMatch(/bundle-local\/$/u)
    expect(carriedPackageDirectory('@delorun/not-carried')).toBeUndefined()
  })
})

describe('a profile that skipped a Delorun bundle', () => {
  it('starts when no Delorun bundle was skipped, and is refused with each skipped bundle\'s reason and fix otherwise', () => {
    expect(() => { refuseSkippedDelorunBundles({ name: PROFILE, skippedBundles: [{ packageName: '@deepseek-ai/dsh-extra', reason: 'not installed' }] }) }).not.toThrow()
    expect(() => { refuseSkippedDelorunBundles({ name: PROFILE, skippedBundles: [{ packageName: LOCAL_BUNDLE, reason: 'not installed' }] }) })
      .toThrow(`Delorun's bundle, so Delorun did not start:\n  ${LOCAL_BUNDLE}: not installed\n  To fix it, run: delorun plugin --profile default add link:${String(carriedPackageDirectory(LOCAL_BUNDLE))}`)
    expect(() => {
      refuseSkippedDelorunBundles({ name: PROFILE, skippedBundles: [{ packageName: LOCAL_BUNDLE, reason: 'a' }, { packageName: '@delorun/not-carried', reason: 'b' }] })
    }).toThrow('  @delorun/not-carried: b\n  To fix it, reinstall Delorun, or run: delorun plugin --profile default install')
  })
})

describe('the rows of Delorun\'s bundles', () => {
  it('collects the ids a Delorun layer inserts, nested lists included, and none from other layers', () => {
    const ids = delorunRowIds({
      layers: [
        { packageName: LOCAL_BUNDLE, patches: [{ insert: [{ id: 'delorun-privacy', name: LOCAL_BUNDLE, config: { nested: [{ id: 'inner', name: '@delorun/inner' }] } }, 'text', null] }, {}] },
        { packageName: '@deepseek-ai/dsh-base', patches: [{ insert: [{ id: 'upstream-row', name: '@deepseek-ai/dsh-x' }] }] },
      ],
    } as never)
    expect([...ids].sort()).toEqual(['delorun-privacy', 'inner'])
  })

  it('reports the enabled Delorun rows that did not activate, with a fix for each', () => {
    const rows: BootedRow[] = [
      { id: 'delorun-privacy', name: LOCAL_BUNDLE, disabled: false, state: 'not-imported' },
      { id: 'delorun-other', name: '@delorun/not-carried', disabled: false, state: 'pending' },
      { id: 'delorun-off', name: '@delorun/not-carried', disabled: true, state: 'failed' },
      { id: 'inserted', name: '@deepseek-ai/dsh-x', disabled: false, state: 'failed' },
      { id: 'upstream', name: '@deepseek-ai/dsh-y', disabled: false, state: 'failed' },
      { id: 'delorun-ok', name: LOCAL_BUNDLE, disabled: false, state: 'active' },
    ]
    const inactive = inactiveDelorunRows(rows, new Set(['inserted']))
    expect(inactive.map(row => row.id)).toEqual(['delorun-privacy', 'delorun-other', 'inserted'])
    const message = inactiveRowsRefusal(PROFILE, inactive).message
    expect(message).toContain('plugins of Delorun\'s bundles did not start in the CLI profile default, so Delorun stopped:')
    expect(message).toContain(`  delorun-privacy (${LOCAL_BUNDLE}) failed to import\n  To fix it, build it in this source checkout with: pnpm --filter ${LOCAL_BUNDLE} run build`)
    expect(message).toContain('  delorun-other (@delorun/not-carried) waits for a service that never came\n  To fix it, reinstall Delorun')
    expect(message).toContain('  inserted (@deepseek-ai/dsh-x) failed to start')
    expect(inactiveRowsRefusal(PROFILE, [rows[0] as BootedRow]).message).toContain('a plugin of Delorun\'s bundles did not start')
  })
})
