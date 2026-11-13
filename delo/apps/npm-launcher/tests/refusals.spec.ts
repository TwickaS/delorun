/**
 * What the launcher prints for each refusal, in `@delo/home`'s refusal format: what Delo did, why with the code, and
 * what the person can do, for every install failure, every runtime-store failure, a refused home and a refused
 * release-log check, with the store's remedies as commands for the profile; every refusal redacted, and a failure the
 * launcher did not catch reported the same way.
 */
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { HomeLayoutError, homeLayoutDescriber } from '@delo/home'
import { InstallError, installDescriber, installRemedies, type InstallErrorCode } from '@delo/install'
import { ReleaseLogRefusalError } from '@delo/release-verify/errors'
import { LogUnreachableError } from '@delo/release-verify/online'
import { RELEASE_VERIFY_DESCRIBERS } from '@delo/release-verify/refusal'
import { RuntimeStoreError, runtimeStoreDescriber, type RuntimeRemedy } from '@delo/runtime-store'
import { installLauncherLastResort, LAUNCHER_DESCRIBERS, LAUNCHER_EXIT, LAUNCHER_NO_LOG_POINTER, refusalFor } from '../src/refusals.ts'

const CONTEXT = { home: '/home/.delo', profile: 'work' }

describe('an install refusal', () => {
  const leads: ReadonlyArray<readonly [InstallErrorCode, string]> = [
    ['DOWNLOAD_REFUSED', 'Delo refused to download the source.'],
    ['DOWNLOAD_FAILED', 'The download of the source did not finish.'],
    ['INSTALL_VERIFY_FAILED', 'Delo refused release the source, which did not verify. Nothing was installed.'],
    ['ARCHIVE_REFUSED', 'Delo refused the runtime archive the source. Nothing was installed.'],
    ['RELEASE_LOG_FAILED', 'Delo refused the source because its release-log check failed.'],
    ['RELEASE_NOT_OFFERED', 'Delo did not install that release.'],
    ['PLATFORM_NOT_RELEASED', 'Release the source has no runtime for this computer. Nothing was installed.'],
    ['RELEASE_METADATA_INVALID', 'Delo could not read the release metadata at the source. Nothing was installed.'],
    ['TRUST_STATE_INVALID', 'Delo could not read what it stored about verified releases. Nothing was installed.'],
    ['NO_TRUSTED_ROOT', 'This launcher cannot verify any release.'],
  ]

  for (const [code, lead] of leads) {
    it(`leads with what Delo did for ${code}, then why, then the remedies`, () => {
      const refusal = refusalFor(new InstallError(code, 'the source', 'what is wrong'), CONTEXT)
      expect(refusal.text).toBe(`${lead}\nWhy: ${code}: what is wrong\nWhat you can do:\n${installRemedies(code).map(remedy => `  ${remedy}\n`).join('')}`)
      expect(refusal.remedies).toEqual(installRemedies(code))
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
    ['RUNTIME_CHANGED', 'Delorun did not start the installed runtime.'],
    ['RUNTIME_INCOMPATIBLE', 'Delorun did not start the installed runtime.'],
    ['ROOT_NOT_ANCHORED', 'Delorun did not start the installed runtime.'],
    ['NO_ACTIVE_RUNTIME', 'Delo found no installed runtime to start.'],
    ['STORE_BUSY', 'Another Delo command is changing the installed runtimes.'],
    ['POINTER_REPLACE_FAILED', 'Delo did not change which runtime is active.'],
    ['POINTER_CHANGED', 'Delo did not change which runtime is active.'],
    ['NOT_INSTALLED', 'Delo did not change which runtime is active.'],
    ['NO_PREVIOUS', 'Delo did not change which runtime is active.'],
    ['INSTALL_VERIFY_FAILED', 'Delo refused the release it downloaded.'],
  ]

  for (const [code, lead] of leads) {
    it(`leads with what Delo did for ${code}, then why`, () => {
      const refusal = refusalFor(new RuntimeStoreError(code, '/home/.delo/runtimes', 'what is wrong'), CONTEXT)
      expect(refusal.text).toBe(`${lead}\nWhy: ${code}: what is wrong\n`)
      expect(refusal.remedies).toEqual([])
    })
  }

  it('offers each remedy the store names as a command for the profile', () => {
    const remedies: readonly RuntimeRemedy[] = ['reinstall', 'rollback', 'update', 'launcher-update']
    const refusal = refusalFor(new RuntimeStoreError('RUNTIME_CHANGED', '/home/.delo/runtimes', 'what is wrong', remedies), CONTEXT)
    expect(refusal.text.split('\n').slice(2, -1)).toEqual([
      'What you can do:',
      '  Install the release again: delorun update --profile work',
      '  Go back to the version before the last update: delorun recover rollback --profile work',
      '  Update the runtime: delorun update --profile work',
      '  Update the launcher to a version that reads this runtime.',
    ])
  })
})

describe('a refused home or release-log check', () => {
  it('names the path, the code and the fix of a refused home', () => {
    const refusal = refusalFor(new HomeLayoutError('HOME_MODE', '/home/.delo', '/home/.delo has mode 0755', 'chmod 700 /home/.delo'), CONTEXT)
    expect(refusal.text).toBe('Delorun stopped before using /home/.delo.\nWhy: HOME_MODE: /home/.delo has mode 0755\nWhat you can do:\n  Fix it with: chmod 700 /home/.delo\n')
  })

  it('names the check that refused and what the log did', () => {
    expect(refusalFor(new ReleaseLogRefusalError('consistency-proof-invalid', 'the log forked'), CONTEXT).text).toContain('Why: consistency-proof-invalid: the log forked\n')
    expect(refusalFor(new LogUnreachableError('the connection was reset'), CONTEXT).text).toBe('Delo could not reach the release log.\nWhy: the connection was reset\nWhat you can do:\n  Check this computer\'s connection, then run the same command again.\n')
  })
})

describe('the launcher\'s describers', () => {
  it('are the packages\' own, the ones delorun composes too', () => {
    expect(LAUNCHER_DESCRIBERS).toEqual([homeLayoutDescriber, installDescriber, runtimeStoreDescriber, ...RELEASE_VERIFY_DESCRIBERS])
  })
})

describe('any other failure', () => {
  it('is reported with its own message, no stack and no remedy', () => {
    expect(refusalFor(new Error('the disk is full'), CONTEXT)).toEqual({ text: 'Delorun stopped: the disk is full\n', exit: LAUNCHER_EXIT.failed, remedies: [] })
    expect(refusalFor('plain text', CONTEXT).text).toBe('Delorun stopped: plain text\n')
  })
})

/** A provider key in the form `@delo/logs`'s redactor specs use. */
const PROVIDER_KEY = ['sk', '0123456789abcdef0123456789abcdef'].join('-')

describe('a refusal carrying a secret', () => {
  it('prints it redacted, through a described error and through the message no describer knows', () => {
    expect(refusalFor(new Error(`the proxy sent ${PROVIDER_KEY}`), CONTEXT).text).toBe('Delorun stopped: the proxy sent [redacted:provider-key]\n')
    const described = refusalFor(new InstallError('DOWNLOAD_FAILED', 'the source', `the host answered ${PROVIDER_KEY}`), CONTEXT).text
    expect(described).toContain('Why: DOWNLOAD_FAILED: the host answered [redacted:provider-key]\n')
    expect(described).not.toContain(PROVIDER_KEY)
  })
})

describe('the launcher\'s last-resort handler', () => {
  it('prints a failure the launcher did not catch as a redacted refusal without a stack, and exits 1, once per process', () => {
    const emitter = new EventEmitter()
    const output: string[] = []
    const exit = vi.fn()
    const uninstall = installLauncherLastResort({ process: emitter, stderr: text => { output.push(text) }, exit })
    expect(() => installLauncherLastResort({ process: emitter, stderr: () => {}, exit: () => {} })).toThrow('already installed')
    emitter.emit('unhandledRejection', new TypeError(`fetch ${PROVIDER_KEY} failed`))
    expect(output.join('')).toBe(`Delorun stopped: fetch [redacted:provider-key] failed\nWhat you can do:\n  ${LAUNCHER_NO_LOG_POINTER}\n`)
    expect(exit).toHaveBeenCalledWith(1)
    uninstall()
    expect(emitter.listenerCount('unhandledRejection')).toBe(0)
  })
})
