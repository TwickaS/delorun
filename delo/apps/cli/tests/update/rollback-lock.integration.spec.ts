/**
 * A runtime rollback holds the profile's writer lock (`<profile>/package.json.lock`) across C3's whole rollback table
 * (`rollbackRecordedUpdate`): a lock another live process holds refuses the rollback before the record is marked or
 * the runtime is switched, and without another holder the lock exists while the mark and the switch run and is gone
 * when the rollback ends.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { DELO_HOME_ENTRIES, TRUST_FILES, type RuntimeVersion } from '@delo/contract-home-layout'
import type { UpdateJournal } from '@delo/contract-home-process'
import type { RollbackSteps } from '@delo/home-process'
import type { RootMetadata } from '@delo/contract-release-manifest'
import type { DeloLogger } from '@delo/logs'
import { ProfileSafetyError, recordSnapshot } from '@delo/profile-safety'
import { RuntimeStore } from '@delo/runtime-store'
import { runtimePlatformOf } from '../../src/update/channel.ts'
import { rollbackRecordedUpdate } from '../../src/update/support.ts'
import { fakeClosure, signedRelease, throwawayRoot, writeClosure } from './support.ts'

const platform = runtimePlatformOf(process.platform, process.arch)
const v = (text: string): RuntimeVersion => brandString<RuntimeVersion>(text)
const SILENT: DeloLogger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
const NOW = new Date('2026-11-10T12:00:00.000Z')

let base: string
let home: string
let profileDir: string
let lockPath: string
let store: RuntimeStore
let root: RootMetadata
let record: UpdateJournal

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'delo-rollback-lock-')))
  home = join(base, 'h')
  profileDir = join(home, 'profiles', 'default')
  lockPath = join(profileDir, 'package.json.lock')
  mkdirSync(join(home, DELO_HOME_ENTRIES.trust), { recursive: true })
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({ name: 'dsh-profile-default', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }, undefined, 2)}\n`)
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n')
  const trusted = throwawayRoot()
  root = trusted.metadata
  writeFileSync(join(home, DELO_HOME_ENTRIES.trust, TRUST_FILES.root), trusted.bytes, { mode: 0o600 })
  store = new RuntimeStore({ home, platform, logger: SILENT })
  const files = fakeClosure('1.0.0', { healthy: true, persistence: 'a'.repeat(64) })
  await store.install({ version: v('1.0.0'), root, fill: async (directory) => {
    writeClosure(directory, files)
    return Promise.resolve(signedRelease(trusted.keys.targets, platform, '1.0.0', files))
  } })
  const snapshot = await recordSnapshot({ profileDir, homeDir: home, summary: 'Before update to Delorun 1.1.0', changedBy: { kind: 'person' } })
  record = { v: 1, from: v('1.0.0'), to: v('1.1.0'), phase: 'committed', startedAt: NOW.toISOString(), dataDiffers: false, copy: false, targetStarted: true, snapshot }
}, 60_000)

afterEach(() => {
  // Installed runtimes are read-only, as C1 installs them; the owner's write permission comes back before removal.
  execFileSync('chmod', ['-R', 'u+rwX', base], { timeout: 30_000 })
  rmSync(base, { recursive: true, force: true })
})

/**
 * Run the runtime rollback with steps that note whether the profile's lock exists while they run.
 * @returns whether the lock existed while each step ran.
 */
async function rollBack(): Promise<{ readonly lockSeen: Record<'markRollingBack' | 'switchRuntime', boolean | undefined> }> {
  const lockSeen: Record<'markRollingBack' | 'switchRuntime', boolean | undefined> = { markRollingBack: undefined, switchRuntime: undefined }
  const steps: RollbackSteps = {
    profileOnly: false,
    markRollingBack: () => { lockSeen.markRollingBack = existsSync(lockPath); return Promise.resolve() },
    switchRuntime: () => { lockSeen.switchRuntime = existsSync(lockPath); return Promise.resolve() },
  }
  await rollbackRecordedUpdate({ home, profile: 'default', store, root: () => Promise.resolve(root), now: () => NOW }, record, steps)
  return { lockSeen }
}

describe('a runtime rollback and the profile\'s writer lock', () => {
  it('refuses with RECOVER_REFUSED while another live process holds the lock, before the record is marked or the runtime switched', async () => {
    // This process's own pid is a live holder that is never taken over.
    writeFileSync(lockPath, String(process.pid))
    const calls: string[] = []
    const steps: RollbackSteps = {
      profileOnly: false,
      markRollingBack: () => { calls.push('markRollingBack'); return Promise.resolve() },
      switchRuntime: () => { calls.push('switchRuntime'); return Promise.resolve() },
    }
    const refusal = await rollbackRecordedUpdate({ home, profile: 'default', store, root: () => Promise.resolve(root), now: () => NOW, profileLockWaitMs: 50 }, record, steps).catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(ProfileSafetyError)
    expect(refusal).toMatchObject({ code: 'RECOVER_REFUSED' })
    expect(calls).toEqual([])
    // The holder's lock stays as it was.
    expect(readFileSync(lockPath, 'utf8')).toBe(String(process.pid))
  })

  it('holds the lock while the mark and the runtime switch run, and releases it when the rollback ends', async () => {
    const { lockSeen } = await rollBack()
    expect(lockSeen).toEqual({ markRollingBack: true, switchRuntime: true })
    expect(existsSync(lockPath)).toBe(false)
  })
})
