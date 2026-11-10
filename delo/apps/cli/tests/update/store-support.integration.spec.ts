/**
 * The update support of a home process running from the store (`delo/apps/cli/src/update/store-support.ts`): the
 * channel opener checks the running release before it opens the channel that release names, the support it builds
 * serves the store's pointers and dates a session-data copy by the clock, and C3's health check H1 runs C1's start check on the stored runtime. Nothing here
 * reaches the network; the channel is only opened.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { DELO_HOME_ENTRIES, TRUST_FILES, type RuntimeVersion } from '@delo/contract-home-layout'
import { ensureHomeTree } from '@delo/home'
import { LauncherChannel } from '@delo/install'
import type { DeloLogger } from '@delo/logs'
import { RuntimeStore } from '@delo/runtime-store'
import { runtimePlatformOf } from '../../src/update/channel.ts'
import { checkStoredRuntime, storeChannelOpener, storeUpdateSupport } from '../../src/update/store-support.ts'
import { fakeClosure, signedRelease, throwawayRoot, writeClosure } from './support.ts'

const platform = runtimePlatformOf(process.platform, process.arch)
const v = (text: string): RuntimeVersion => brandString<RuntimeVersion>(text)
const SILENT: DeloLogger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }

let base: string
let home: string
let store: RuntimeStore

beforeAll(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'dss-')))
  home = join(base, 'h')
  await ensureHomeTree(home, 'default')
  const root = throwawayRoot()
  writeFileSync(join(home, DELO_HOME_ENTRIES.trust, TRUST_FILES.root), root.bytes, { mode: 0o600 })
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
    expect(await storeChannelOpener(home, store, v('1.0.0'))(() => {})).toBeInstanceOf(LauncherChannel)
  })

  it('opens no channel when the running release is not installed', async () => {
    await expect(storeChannelOpener(home, store, v('9.9.9'))(() => {})).rejects.toMatchObject({ code: 'RUNTIME_CHANGED' })
  })
})

describe('storeUpdateSupport', () => {
  it('serves the pointers of this machine\'s store, and dates a session-data copy by the clock', async () => {
    const support = storeUpdateSupport(home, 'default', v('1.0.0'), SILENT)
    expect(await support.store.pointers()).toEqual({ current: v('1.0.0') })
    const before = Date.now()
    await support.copies.save(v('1.0.0'), v('1.0.0'))
    const record: { created: string } = JSON.parse(readFileSync(join(home, 'data-copies', '1.0.0', 'copy.json'), 'utf8'))
    expect(Date.parse(record.created)).toBeGreaterThanOrEqual(before - 1000)
  })
})

describe('checkStoredRuntime', () => {
  it('passes an installed runtime and refuses one that is not installed', async () => {
    await checkStoredRuntime(home, v('1.0.0'), SILENT)
    await expect(checkStoredRuntime(home, v('9.9.9'), SILENT)).rejects.toMatchObject({ code: 'RUNTIME_CHANGED' })
  })
})
