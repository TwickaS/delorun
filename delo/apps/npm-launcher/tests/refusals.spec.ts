/**
 * The sentence the launcher prints for each refusal, in the order of what Delo did, why and what the person can do: one
 * sentence for every install failure and every runtime-store failure, with the store's own remedies as commands.
 */
import { describe, expect, it } from 'vitest'
import { InstallError, type InstallErrorCode } from '@delo/install'
import { RuntimeStoreError, type RuntimeRemedy } from '@delo/runtime-store'
import { installRemedies, LAUNCHER_EXIT, refusalFor, storeRemedies } from '../src/refusals.ts'

const CONTEXT = { home: '/home/.delo', profile: 'work' }

describe('an install refusal', () => {
  const leads: ReadonlyArray<readonly [InstallErrorCode, string]> = [
    ['DOWNLOAD_REFUSED', 'Delo refused to download the source: what is wrong'],
    ['DOWNLOAD_FAILED', 'The download of the source did not finish: what is wrong'],
    ['INSTALL_VERIFY_FAILED', 'Delo refused release the source, which did not verify: what is wrong. Nothing was installed.'],
    ['ARCHIVE_REFUSED', 'Delo refused the runtime archive the source: what is wrong. Nothing was installed.'],
    ['RELEASE_LOG_FAILED', 'Delo refused the source because its release-log check failed: what is wrong'],
    ['RELEASE_NOT_OFFERED', 'Delo did not install that release: what is wrong'],
    ['RELEASE_METADATA_INVALID', 'Delo could not read the release metadata at the source: what is wrong. Nothing was installed.'],
    ['TRUST_STATE_INVALID', 'Delo could not read what it stored about verified releases: what is wrong Nothing was installed.'],
    ['NO_TRUSTED_ROOT', 'This launcher cannot verify any release: what is wrong'],
  ]

  for (const [code, lead] of leads) {
    it(`leads with what Delo did for ${code}, then the remedies`, () => {
      const refusal = refusalFor(new InstallError(code, 'the source', 'what is wrong'), CONTEXT)
      expect(refusal.text.split('\n')[0]).toBe(lead)
      expect(refusal.text.split('\n').slice(1, -1)).toEqual(installRemedies(code).map(remedy => `  ${remedy}`))
      expect(refusal.exit).toBe(LAUNCHER_EXIT.failed)
    })
  }

  it('never offers a release-log failure as something to retry, and offers a lost connection as one', () => {
    expect(installRemedies('RELEASE_LOG_FAILED')[0]).toContain('report this if it repeats')
    expect(installRemedies('DOWNLOAD_FAILED')).toEqual(['Check this computer\'s connection, then run the same command again.'])
  })
})

describe('a runtime store refusal', () => {
  const leads: ReadonlyArray<readonly [RuntimeStoreError['code'], string]> = [
    ['RUNTIME_CHANGED', 'Delo did not start the installed runtime: what is wrong'],
    ['RUNTIME_INCOMPATIBLE', 'Delo did not start the installed runtime: what is wrong'],
    ['NO_ACTIVE_RUNTIME', 'Delo found no installed runtime to start: what is wrong'],
    ['STORE_BUSY', 'Another Delo command is changing the installed runtimes: what is wrong'],
    ['POINTER_REPLACE_FAILED', 'Delo did not change which runtime is active: what is wrong'],
    ['POINTER_CHANGED', 'Delo did not change which runtime is active: what is wrong'],
    ['NOT_INSTALLED', 'Delo did not change which runtime is active: what is wrong'],
    ['NO_PREVIOUS', 'Delo did not change which runtime is active: what is wrong'],
    ['INSTALL_VERIFY_FAILED', 'Delo refused the release it downloaded: what is wrong'],
  ]

  for (const [code, lead] of leads) {
    it(`leads with what Delo did for ${code}`, () => {
      const refusal = refusalFor(new RuntimeStoreError(code, '/home/.delo/runtimes', 'what is wrong'), CONTEXT)
      expect(refusal.text).toBe(`${lead}\n`)
      expect(refusal.remedies).toEqual([])
    })
  }

  it('offers each remedy the store names as a command for the profile', () => {
    const remedies: readonly RuntimeRemedy[] = ['reinstall', 'rollback', 'update', 'launcher-update']
    const error = new RuntimeStoreError('RUNTIME_CHANGED', '/home/.delo/runtimes', 'what is wrong', remedies)
    expect(storeRemedies(error, CONTEXT)).toEqual([
      'Install the release again: delorun update --profile work',
      'Switch back to the version kept for rollback: delorun recover --runtime previous --profile work',
      'Update the runtime: delorun update --profile work',
      'Update the launcher to a version that reads this runtime.',
    ])
    expect(refusalFor(error, CONTEXT).text.split('\n').slice(1, -1)).toEqual(storeRemedies(error, CONTEXT).map(remedy => `  ${remedy}`))
  })
})

describe('any other failure', () => {
  it('is reported with its own message and no remedy', () => {
    expect(refusalFor(new Error('the disk is full'), CONTEXT)).toEqual({ text: 'Delo stopped: the disk is full\n', exit: LAUNCHER_EXIT.failed, remedies: [] })
    expect(refusalFor('plain text', CONTEXT).text).toBe('Delo stopped: plain text\n')
  })
})
