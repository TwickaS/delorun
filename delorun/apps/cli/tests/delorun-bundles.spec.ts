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
  inactivePackRows,
  inactivePackWarning,
  inactiveRowsRefusal,
  LINKING_PROGRESS,
  linkDelorunBundles,
  refuseSkippedDelorunBundles,
  skippedPackNotices,
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
    expect(() => { refuseSkippedDelorunBundles({ name: PROFILE, skippedBundles: [{ packageName: '@deepseek-ai/dsh-extra', reason: 'not installed' }] }, new Set()) }).not.toThrow()
    expect(() => { refuseSkippedDelorunBundles({ name: PROFILE, skippedBundles: [{ packageName: LOCAL_BUNDLE, reason: 'not installed' }] }, new Set()) })
      .toThrow(`Delorun's bundle, so Delorun did not start:\n  ${LOCAL_BUNDLE}: not installed\n  To fix it, run: delorun plugin --profile default add link:${String(carriedPackageDirectory(LOCAL_BUNDLE))}`)
    expect(() => {
      refuseSkippedDelorunBundles({ name: PROFILE, skippedBundles: [{ packageName: LOCAL_BUNDLE, reason: 'a' }, { packageName: '@delorun/not-carried', reason: 'b' }] }, new Set())
    }).toThrow('  @delorun/not-carried: b\n  To fix it, reinstall Delorun, or run: delorun plugin --profile default install')
  })
})

describe('a profile that skipped a pack bundle of the running release', () => {
  const PACKS = new Set(['@delorun/bundle-webhooks'])

  it('starts without the pack and says so, and still refuses a skipped runtime bundle beside it', () => {
    const profile = { name: PROFILE, skippedBundles: [{ packageName: '@delorun/bundle-webhooks', reason: 'not installed' }] }
    expect(() => { refuseSkippedDelorunBundles(profile, PACKS) }).not.toThrow()
    expect(skippedPackNotices(profile, PACKS)).toEqual(['delorun: the plugin pack @delorun/bundle-webhooks did not load in the profile default (not installed), so Delorun starts without it. To fix it, run: delorun recover packs, or retry it in Plugins.\n'])
    expect(() => { refuseSkippedDelorunBundles(profile, new Set()) }).toThrow('@delorun/bundle-webhooks: not installed')
    expect(() => { refuseSkippedDelorunBundles({ name: PROFILE, skippedBundles: [...profile.skippedBundles, { packageName: LOCAL_BUNDLE, reason: 'gone' }] }, PACKS) }).toThrow(`${LOCAL_BUNDLE}: gone`)
    expect(skippedPackNotices({ name: PROFILE, skippedBundles: [{ packageName: LOCAL_BUNDLE, reason: 'gone' }] }, PACKS)).toEqual([])
  })
})

describe('a pack bundle\'s rows that did not activate', () => {
  const PACKS = new Set(['@delorun/bundle-webhooks'])
  const layers = [
    { packageName: LOCAL_BUNDLE, patches: [{ insert: [{ id: 'delorun-privacy', name: LOCAL_BUNDLE }] }] },
    { packageName: '@delorun/bundle-webhooks', patches: [{ insert: [{ id: 'webhook-runtime', name: '@deepseek-ai/dsh-webhook' }, { id: 'github-webhook-ingress', name: 'cordis:group', config: [{ id: 'github-webhook-server', name: '@delorun/bundle-webhooks/server' }] }] }] },
  ]
  const rows: BootedRow[] = [
    { id: 'webhook-runtime', name: '@deepseek-ai/dsh-webhook', disabled: false, state: 'failed' },
    { id: 'github-webhook-server', name: '@delorun/bundle-webhooks/server', disabled: false, state: 'not-imported' },
    { id: 'elsewhere', name: '@delorun/bundle-webhooks/other', disabled: false, state: 'pending' },
    { id: 'off', name: '@delorun/bundle-webhooks/off', disabled: true, state: 'failed' },
    { id: 'delorun-privacy', name: LOCAL_BUNDLE, disabled: false, state: 'failed' },
  ]

  it('do not stop the start; a runtime bundle\'s row still does', () => {
    const ids = delorunRowIds({ layers } as never, PACKS)
    expect(inactiveDelorunRows(rows, ids, PACKS).map(row => row.id)).toEqual(['delorun-privacy'])
    expect(inactiveDelorunRows(rows, delorunRowIds({ layers } as never, new Set()), new Set()).map(row => row.id)).toEqual(['webhook-runtime', 'github-webhook-server', 'elsewhere', 'delorun-privacy'])
  })

  it('are reported per pack with a warning that names each row, its state and the remedy', () => {
    const inactive = inactivePackRows({ layers } as never, rows, PACKS)
    expect(inactive.map(each => ({ pack: each.pack, rows: each.rows.map(row => row.id) }))).toEqual([{ pack: '@delorun/bundle-webhooks', rows: ['webhook-runtime', 'github-webhook-server', 'elsewhere'] }])
    expect(inactivePackWarning(PROFILE, inactive[0]!)).toBe('The plugin pack @delorun/bundle-webhooks did not start in the CLI profile default (webhook-runtime (@deepseek-ai/dsh-webhook) failed to start, github-webhook-server (@delorun/bundle-webhooks/server) failed to import, elsewhere (@delorun/bundle-webhooks/other) waits for a service that never came), so Delorun runs without it; Plugins shows it as not loaded. The warning above names the cause. To fix it, run: delorun recover packs, or turn the pack off in Plugins.')
    expect(inactivePackRows({ layers } as never, rows.filter(row => row.id === 'delorun-privacy'), PACKS)).toEqual([])
  })
})

describe('the rows of Delorun\'s bundles', () => {
  it('collects the ids a Delorun layer inserts, nested lists included, and none from other layers', () => {
    const ids = delorunRowIds({
      layers: [
        { packageName: LOCAL_BUNDLE, patches: [{ insert: [{ id: 'delorun-privacy', name: LOCAL_BUNDLE, config: { nested: [{ id: 'inner', name: '@delorun/inner' }] } }, 'text', null] }, {}] },
        { packageName: '@deepseek-ai/dsh-base', patches: [{ insert: [{ id: 'upstream-row', name: '@deepseek-ai/dsh-x' }] }] },
      ],
    } as never, new Set())
    expect([...ids].sort()).toEqual(['delorun-privacy', 'inner'])
  })

  it('leaves out every row a pack bundle of the running release inserts, nested ones included, and keeps another @delorun/ bundle\'s', () => {
    const ids = delorunRowIds({
      layers: [
        { packageName: LOCAL_BUNDLE, patches: [{ insert: [{ id: 'delorun-privacy', name: LOCAL_BUNDLE }] }] },
        { packageName: '@delorun/bundle-webhooks', patches: [{ insert: [{ id: 'webhook-runtime', name: '@deepseek-ai/dsh-webhook' }, { id: 'github-webhook-ingress', name: 'cordis:group', config: [{ id: 'github-webhook-server', name: '@delorun/bundle-webhooks/server' }] }] }] },
        { packageName: '@delorun/bundle-unlisted', patches: [{ insert: [{ id: 'unlisted-row', name: '@delorun/bundle-unlisted' }] }] },
      ],
    } as never, new Set(['@delorun/bundle-webhooks']))
    expect([...ids].sort()).toEqual(['delorun-privacy', 'unlisted-row'])
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
    const inactive = inactiveDelorunRows(rows, new Set(['inserted']), new Set())
    expect(inactive.map(row => row.id)).toEqual(['delorun-privacy', 'delorun-other', 'inserted'])
    const message = inactiveRowsRefusal(PROFILE, inactive).message
    expect(message).toContain('plugins of Delorun\'s bundles did not start in the CLI profile default, so Delorun stopped:')
    expect(message).toContain(`  delorun-privacy (${LOCAL_BUNDLE}) failed to import\n  To fix it, build it in this source checkout with: pnpm --filter ${LOCAL_BUNDLE} run build`)
    expect(message).toContain('  delorun-other (@delorun/not-carried) waits for a service that never came\n  To fix it, reinstall Delorun')
    expect(message).toContain('  inserted (@deepseek-ai/dsh-x) failed to start')
    expect(inactiveRowsRefusal(PROFILE, [rows[0] as BootedRow]).message).toContain('a plugin of Delorun\'s bundles did not start')
  })
})
