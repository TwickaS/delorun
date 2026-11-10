/**
 * The update support of a home process running from the store (`delo/apps/cli/src/update/store-support.ts`): the
 * channel opener checks the running release under the root the launcher's roots anchor before it opens the channel
 * that release names, the support it builds serves the store's pointers, dates a session-data copy by the clock and
 * refuses every update and rollback when the launcher named no roots, and C3's health check H1 runs C1's start check on
 * the stored runtime. Nothing here reaches the network; the channel is only opened.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { DELO_HOME_ENTRIES, DELO_LAUNCHER_ROOTS_ENV, TRUST_FILES, type RuntimeVersion } from '@delo/contract-home-layout'
import { ensureHomeTree } from '@delo/home'
import { LauncherChannel } from '@delo/install'
import type { DeloLogger } from '@delo/logs'
import { RuntimeStore } from '@delo/runtime-store'
import { runtimePlatformOf } from '../../src/update/channel.ts'
import { checkStoredRuntime, storeChannelOpener, storeUpdateSupport } from '../../src/update/store-support.ts'
import { launcherAnchor } from '../../src/update/trusted-root.ts'
import { fakeClosure, signedRelease, throwawayRoot, writeClosure } from './support.ts'

const platform = runtimePlatformOf(process.platform, process.arch)
const v = (text: string): RuntimeVersion => brandString<RuntimeVersion>(text)
const SILENT: DeloLogger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }

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
  writeFileSync(join(home, DELO_HOME_ENTRIES.trust, TRUST_FILES.root), root.bytes, { mode: 0o600 })
  mkdirSync(join(base, 'roots'))
  writeFileSync(join(base, 'roots', '1.root.json'), root.bytes)
  launched = { [DELO_LAUNCHER_ROOTS_ENV]: join(base, 'roots') }
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
    expect(await storeChannelOpener(home, store, v('1.0.0'), launcherAnchor(home, launched))(() => {})).toBeInstanceOf(LauncherChannel)
  })

  it('opens no channel when the running release is not installed', async () => {
    await expect(storeChannelOpener(home, store, v('9.9.9'), launcherAnchor(home, launched))(() => {})).rejects.toMatchObject({ code: 'RUNTIME_CHANGED' })
  })

  it('opens no channel when the launcher named no roots', async () => {
    await expect(storeChannelOpener(home, store, v('1.0.0'), launcherAnchor(home, {}))(() => {})).rejects.toMatchObject({ code: 'ROOT_NOT_ANCHORED' })
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
    await expect(support.store.prepare(undefined, () => {}, () => {})).rejects.toMatchObject({ code: 'VERIFY_FAILED', detail: expect.stringContaining('start Delo with its launcher') })
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
    await checkStoredRuntime(home, v('1.0.0'), SILENT, launcherAnchor(home, launched).root)
    await expect(checkStoredRuntime(home, v('9.9.9'), SILENT, launcherAnchor(home, launched).root)).rejects.toMatchObject({ code: 'RUNTIME_CHANGED' })
    await expect(checkStoredRuntime(home, v('1.0.0'), SILENT, launcherAnchor(home, {}).root)).rejects.toMatchObject({ code: 'ROOT_NOT_ANCHORED' })
  })
})
