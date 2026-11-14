/**
 * The update support of a home process running from the store (`delorun/apps/cli/src/update/store-support.ts`): the
 * channel opener checks the running release under the root the launcher's roots anchor before it opens the channel
 * that release names, the support it builds serves the store's pointers, dates a session-data copy by the clock and
 * refuses every update and rollback when the launcher named no roots, and C3's health check H1 runs C1's start check on
 * the stored runtime. A prepare refuses before it opens the channel, and a rollback before its first step, when git
 * cannot run. Nothing here reaches the network; the channel is only opened.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { DELORUN_HOME_ENTRIES, DELORUN_LAUNCHER_ROOTS_ENV, TRUST_FILES, type RuntimeVersion } from '@delorun/contract-home-layout'
import type { UpdateJournal } from '@delorun/contract-home-process'
import { ensureHomeTree } from '@delorun/home'
import { HomeProcessError } from '@delorun/home-process'
import { InstallError, LauncherChannel } from '@delorun/install'
import type { DelorunLogger } from '@delorun/logs'
import { RuntimeStore } from '@delorun/runtime-store'
import { runtimePlatformOf } from '../../src/update/channel.ts'
import { checkStoredRuntime, storeChannelOpener, storeUpdateSupport } from '../../src/update/store-support.ts'
import { storeReportSources } from '../../src/update/sources.ts'
import { homeUpdateSupport } from '../../src/update/support.ts'
import { launcherAnchor } from '../../src/update/trusted-root.ts'
import { fakeClosure, signedRelease, throwawayRoot, writeClosure } from './support.ts'

const platform = runtimePlatformOf(process.platform, process.arch)
const v = (text: string): RuntimeVersion => brandString<RuntimeVersion>(text)
const SILENT: DelorunLogger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }

let base: string
let home: string
let store: RuntimeStore
/** The environment of a home process the launcher started: its roots' directory holds the home's root. */
let launched: Record<string, string>

beforeAll(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'dss-')))
  home = join(base, 'h')
  await ensureHomeTree(home, 'default')
  const root = throwawayRoot()
  writeFileSync(join(home, DELORUN_HOME_ENTRIES.trust, TRUST_FILES.root), root.bytes, { mode: 0o600 })
  mkdirSync(join(base, 'roots'))
  writeFileSync(join(base, 'roots', '1.root.json'), root.bytes)
  launched = { [DELORUN_LAUNCHER_ROOTS_ENV]: join(base, 'roots') }
  store = new RuntimeStore({ home, platform, logger: SILENT })
  const files = fakeClosure('1.0.0', { healthy: true, persistence: 'a'.repeat(64) })
  await store.install({ version: v('1.0.0'), root: root.metadata, fill: async (directory) => {
    writeClosure(directory, files)
    return Promise.resolve(signedRelease(root.keys.targets, platform, '1.0.0', files))
  } })
})

afterAll(() => {
  // Installed runtimes are read-only, as C1 installs them; the owner's write permission comes back before removal.
  execFileSync('chmod', ['-R', 'u+rwX', base], { timeout: 30_000 })
  rmSync(base, { recursive: true, force: true })
})

describe('storeChannelOpener', () => {
  it('opens the launcher\'s channel for a running release that passes its start check', async () => {
    expect(await storeChannelOpener(home, store, v('1.0.0'), launcherAnchor(home, launched), 7)(() => {})).toBeInstanceOf(LauncherChannel)
  })

  it('opens no channel when the running release is not installed', async () => {
    await expect(storeChannelOpener(home, store, v('9.9.9'), launcherAnchor(home, launched), 7)(() => {})).rejects.toMatchObject({ code: 'RUNTIME_CHANGED' })
  })

  it('opens no channel when the launcher named no roots', async () => {
    await expect(storeChannelOpener(home, store, v('1.0.0'), launcherAnchor(home, {}), 7)(() => {})).rejects.toMatchObject({ code: 'ROOT_NOT_ANCHORED' })
  })
})

/**
 * The prepare of a home update support whose channel opens as given.
 * @param openChannel - the channel opener.
 * @returns the prepare's result.
 */
function preparing(openChannel: Parameters<typeof homeUpdateSupport>[0]['openChannel']): ReturnType<ReturnType<typeof homeUpdateSupport>['store']['prepare']> {
  const support = homeUpdateSupport({
    home, profile: 'default', store, now: () => new Date(), root: launcherAnchor(home, launched).root, fullCheckDays: 7, openChannel,
    sources: storeReportSources({ home, profile: 'default', store, running: v('1.0.0'), root: launcherAnchor(home, launched).root, fullCheckDays: 7 }),
  })
  return support.store.prepare(undefined, () => {}, () => {})
}

/**
 * Run with a `PATH` that names only an empty directory, so no git command is found.
 * @param run - what runs.
 */
async function withoutGit(run: () => Promise<void>): Promise<void> {
  const noGit = mkdtempSync(join(tmpdir(), 'delorun-no-git-'))
  const searchPath = process.env.PATH
  process.env.PATH = noGit
  try {
    await run()
  } finally {
    process.env.PATH = searchPath
    rmSync(noGit, { recursive: true, force: true })
  }
}

describe('the prepare of an update', () => {
  it('reports a release the channel refused as VERIFY_FAILED, with the refusal delorun prints for it', async () => {
    const tampered = new InstallError('INSTALL_VERIFY_FAILED', 'https://releases.example/1.1.0', 'data-formats.json does not match its digest in the signed manifest')
    const support = homeUpdateSupport({
      home, profile: 'default', store, now: () => new Date(), root: launcherAnchor(home, launched).root, fullCheckDays: 7,
      openChannel: () => Promise.reject(tampered),
      sources: storeReportSources({ home, profile: 'default', store, running: v('1.0.0'), root: launcherAnchor(home, launched).root, fullCheckDays: 7 }),
    })
    const refused = support.store.prepare(undefined, () => {}, () => {})
    await expect(refused).rejects.toBeInstanceOf(HomeProcessError)
    await expect(refused).rejects.toMatchObject({ code: 'VERIFY_FAILED', detail: expect.stringContaining('data-formats.json does not match its digest in the signed manifest') })
  })

  it('reports a download that did not finish as CHANNEL_UNREACHABLE, and a body past its limit as VERIFY_FAILED', async () => {
    const cases: readonly [InstallError, string][] = [
      [new InstallError('DOWNLOAD_FAILED', 'https://releases.example/timestamp.json', 'the connection did not open: ECONNREFUSED'), 'CHANNEL_UNREACHABLE'],
      [new InstallError('DOWNLOAD_FAILED', 'https://releases.example/timestamp.json', 'the host answered 503', { status: 503 }), 'CHANNEL_UNREACHABLE'],
      [new InstallError('DOWNLOAD_FAILED', 'https://releases.example/timestamp.json', 'the file passed its limit of 10 bytes', { oversize: true }), 'VERIFY_FAILED'],
    ]
    for (const [failure, code] of cases) {
      const refused = preparing(() => Promise.reject(failure))
      await expect(refused).rejects.toMatchObject({ code, detail: expect.stringContaining(failure.detail) })
    }
    await expect(preparing(() => Promise.reject(cases[0]![0]))).rejects.toMatchObject({ detail: expect.stringContaining('Check this computer\'s connection') })
  })

  it('refuses with GIT_UNAVAILABLE before it opens the channel when git cannot run', async () => {
    let opened = false
    await withoutGit(async () => {
      await expect(preparing(() => { opened = true; return Promise.reject(new Error('unreached')) })).rejects.toMatchObject({ code: 'GIT_UNAVAILABLE', detail: expect.stringContaining('no git command is on PATH') })
    })
    expect(opened).toBe(false)
  })
})

describe('a rollback when git cannot run', () => {
  it('refuses with GIT_UNAVAILABLE before its first step, so it never stops half-way', async () => {
    const support = storeUpdateSupport(home, 'default', v('1.0.0'), SILENT, launched)
    const steps: string[] = []
    const record: UpdateJournal = { v: 1, from: v('1.0.0'), to: v('1.1.0'), phase: 'committed', startedAt: '2026-11-01T00:00:00.000Z', dataDiffers: false, copy: false, targetStarted: true }
    await withoutGit(async () => {
      await expect(support.copies.rollback(record, {
        profileOnly: false,
        switchRuntime: async () => { steps.push('switch') },
        markRollingBack: async () => { steps.push('mark') },
      })).rejects.toMatchObject({ code: 'GIT_UNAVAILABLE' })
    })
    expect(steps).toEqual([])
  })
})

describe('a channel record that names an origin the launcher refuses', () => {
  it('ends the prepare in VERIFY_FAILED, naming the record, instead of leaving it unanswered', async () => {
    const path = join(home, DELORUN_HOME_ENTRIES.trust, 'channel.json')
    writeFileSync(path, '{"v":1,"channelOrigin":"http://192.0.2.1:8123"}\n', { mode: 0o600 })
    try {
      const refused = storeUpdateSupport(home, 'default', v('1.0.0'), SILENT, launched).store.prepare(undefined, () => {}, () => {})
      await expect(refused).rejects.toMatchObject({ code: 'VERIFY_FAILED', detail: expect.stringContaining('the recorded release channel is not a channel record') })
    } finally {
      rmSync(path, { force: true })
    }
  })
})

describe('storeUpdateSupport', () => {
  it('serves the pointers of this machine\'s store, and dates a session-data copy by the clock', async () => {
    const support = storeUpdateSupport(home, 'default', v('1.0.0'), SILENT, launched)
    expect(await support.store.pointers()).toEqual({ current: v('1.0.0') })
    const before = Date.now()
    await support.copies.save(v('1.0.0'), v('1.0.0'))
    const record: { created: string } = JSON.parse(readFileSync(join(home, 'data-copies', '1.0.0', 'copy.json'), 'utf8'))
    expect(Date.parse(record.created)).toBeGreaterThanOrEqual(before - 1000)
  })

  it('refuses an update with VERIFY_FAILED and a rollback report with ROLLBACK_TARGET_UNUSABLE when the launcher named no roots, installing nothing', async () => {
    const support = storeUpdateSupport(home, 'default', v('1.0.0'), SILENT, {})
    await expect(support.store.prepare(v('1.0.0'), () => {}, () => {})).rejects.toMatchObject({ code: 'VERIFY_FAILED', detail: expect.stringContaining('ROOT_NOT_ANCHORED') })
    await expect(support.store.prepare(undefined, () => {}, () => {})).rejects.toMatchObject({ code: 'VERIFY_FAILED', detail: expect.stringContaining('start Delorun with its launcher') })
    await expect(support.store.reportRollback(v('1.0.0'))).rejects.toMatchObject({ code: 'ROLLBACK_TARGET_UNUSABLE', detail: expect.stringContaining('ROOT_NOT_ANCHORED') })
    await expect(support.store.reportRollback(v('9.9.9'))).rejects.toMatchObject({ code: 'ROLLBACK_TARGET_UNUSABLE', detail: expect.stringContaining('NOT_INSTALLED') })
  })

  it('passes a prepare whose failure is not a check, such as an unreadable report, through unchanged', async () => {
    const support = storeUpdateSupport(home, 'default', v('1.0.0'), SILENT, launched)
    rmSync(join(home, 'profiles', 'default'), { recursive: true, force: true })
    await expect(support.store.prepare(v('1.0.0'), () => {}, () => {})).rejects.not.toMatchObject({ code: 'VERIFY_FAILED' })
    await expect(support.store.reportRollback(v('1.0.0'))).rejects.not.toMatchObject({ code: 'ROLLBACK_TARGET_UNUSABLE' })
  })
})

describe('checkStoredRuntime', () => {
  it('passes an installed runtime and refuses one that is not installed, or one the launcher\'s roots cannot anchor', async () => {
    await checkStoredRuntime(home, v('1.0.0'), SILENT, launcherAnchor(home, launched).root, 7)
    await expect(checkStoredRuntime(home, v('9.9.9'), SILENT, launcherAnchor(home, launched).root, 7)).rejects.toMatchObject({ code: 'RUNTIME_CHANGED' })
    await expect(checkStoredRuntime(home, v('1.0.0'), SILENT, launcherAnchor(home, {}).root, 7)).rejects.toMatchObject({ code: 'ROOT_NOT_ANCHORED' })
  })
})
