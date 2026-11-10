/**
 * What `delorun` prints for each typed error its commands can raise, and the gate that keeps it complete: every error
 * class a fork package or app exports is either described by `delorun`'s describers or named, with the reason, as one
 * that never reaches `delorun`'s entry point.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { UpdatePendingError } from '@delo/bundle-local/update-gate'
import { describeFailure, homeLayoutDescriber, type Refusal } from '@delo/home'
import { installDescriber } from '@delo/install'
import { ProfileSafetyError, type ProfileSafetyRemedy } from '@delo/profile-safety'
import { LogVerificationError } from '@delo/release-formats/log/bundle'
import { TileError } from '@delo/release-formats/log/tiles'
import { VerificationError } from '@delo/release-formats/sign/verify'
import { RELEASE_VERIFY_DESCRIBERS } from '@delo/release-verify/refusal'
import { runtimeStoreDescriber } from '@delo/runtime-store'
import { TrashError } from '@delo/trash'
import { DataSafetyError, UpdateReportError, type DataSafetyErrorCode } from '@delo/update'
import { describe, expect, it } from 'vitest'
import { CliError, EXIT } from '../src/exit.ts'
import { DataInUseError } from '../src/home-exclusion.ts'
import { CLI_DESCRIBERS, cliRefusal, namedProfile } from '../src/refusals.ts'
import { SetupCancelled } from '../src/setup/prompts.ts'
import { BundleReadError } from '../src/update/bundle-layers.ts'
import { DeloVersionError } from '../src/version.ts'

/** The fork's root: `delo/`. */
const FORK = fileURLToPath(new URL('../../../', import.meta.url))

const PLUGIN = 'raised inside a plugin of the home process and reported to the studio or the model, never to delorun'
const TOOLS = 'developer tooling under delo/apps/tools with its own entry points'
const RELEASE_PIPELINE = 'the release pipeline\'s signing and advisory commands, which delorun does not import'

/** The exported error classes that never reach `delorun`'s entry point, each with the reason. */
const OUTSIDE_DELORUN: Readonly<Record<string, string>> = {
  FullAccessConsentRefusedError: PLUGIN,
  PermissionStoreError: PLUGIN,
  UnsupportedHostError: PLUGIN,
  InvalidPathError: PLUGIN,
  InstructionsRefusedError: PLUGIN,
  WorkspaceRefusedError: PLUGIN,
  FetchGuardRefusedError: PLUGIN,
  TrashRequestError: 'raised by the studio\'s trash client in the browser',
  ChatStateRefusedError: PLUGIN,
  ChatStatesRequestError: 'raised by the studio\'s chat-states client in the browser',
  TrashOperationError: PLUGIN,
  OwnerNotesError: PLUGIN,
  MainChatToolError: PLUGIN,
  AcceptanceStoreError: PLUGIN,
  BuildRootBusyError: 'raised by the release tooling\'s closure build, which no runtime carries',
  HomeAuthError: 'raised by the home process\'s Web sign-in, which answers the browser over HTTP',
  RelayError: 'raised by the relay server under delo/apps/relay, which delorun does not run',
  UsageError: TOOLS,
  BatchError: TOOLS,
  BodyTooLarge: TOOLS,
  UpstreamUpdateError: TOOLS,
  NetworkGuardRefusal: TOOLS,
  SigningRefusal: RELEASE_PIPELINE,
  FeedFailure: RELEASE_PIPELINE,
}

/**
 * Every TypeScript source file under a directory.
 * @param directory - the directory.
 * @returns the files' paths.
 */
function sources(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && /\.tsx?$/u.test(entry.name) && !entry.name.endsWith('.d.ts'))
    .map(entry => join(entry.parentPath, entry.name))
}

/**
 * Every exported class of the fork's packages and apps that extends `Error`, a class whose name ends in `Error`, or
 * another such class.
 * @returns each class's name and the file that declares it.
 */
function exportedErrorClasses(): ReadonlyArray<{ readonly name: string, readonly file: string }> {
  const declared: Array<{ name: string, base: string, file: string }> = []
  for (const group of ['packages', 'apps']) {
    for (const member of readdirSync(join(FORK, group), { withFileTypes: true })) {
      if (!member.isDirectory()) continue
      const source = join(FORK, group, member.name, 'src')
      let files: string[]
      try {
        files = sources(source)
      } catch (error) {
        // A member without `src/` (ENOENT) exports no source classes; any other failure stops the gate.
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue
        throw error
      }
      for (const file of files) {
        for (const match of readFileSync(file, 'utf8').matchAll(/^export (?:abstract )?class (\w+)(?:<[^>]*>)? extends (\w+)/gmu)) {
          declared.push({ name: match[1]!, base: match[2]!, file: file.slice(FORK.length) })
        }
      }
    }
  }
  const errors = new Set<string>()
  let grew = true
  while (grew) {
    grew = false
    for (const { name, base } of declared) {
      if (!errors.has(name) && (base === 'Error' || base.endsWith('Error') || errors.has(base))) {
        errors.add(name)
        grew = true
      }
    }
  }
  return declared.filter(({ name }) => errors.has(name))
}

describe('the error classes the fork exports', () => {
  const classes = exportedErrorClasses()
  const described = new Set(CLI_DESCRIBERS.map(describer => describer.type.name))

  it('finds the fork\'s error classes, each under one name', () => {
    expect(classes.length).toBeGreaterThan(40)
    expect(classes.map(({ name }) => name)).toContain('HomeProcessError')
    const names = classes.map(({ name }) => name)
    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([])
  })

  it('are each described by delorun, or named as never reaching it', () => {
    const unmapped = classes.filter(({ name }) => !described.has(name) && OUTSIDE_DELORUN[name] === undefined)
    expect(unmapped.map(({ name, file }) => `${name} (${file})`)).toEqual([])
  })

  it('name no class twice and no class that no longer exists', () => {
    const names = new Set(classes.map(({ name }) => name))
    expect(Object.keys(OUTSIDE_DELORUN).filter(name => described.has(name) || !names.has(name))).toEqual([])
    expect([...described].filter(name => !names.has(name))).toEqual([])
  })

  it('include every describer the npm launcher composes, so both programs print the same refusal', () => {
    for (const describer of [homeLayoutDescriber, installDescriber, runtimeStoreDescriber, ...RELEASE_VERIFY_DESCRIBERS]) expect(CLI_DESCRIBERS).toContain(describer)
  })
})

/**
 * The refusal `delorun` prints for one error.
 * @param error - the error.
 * @param profile - the profile the command named.
 * @returns the refusal.
 */
function refusalOf(error: unknown, profile?: string): Refusal {
  return describeFailure(error, CLI_DESCRIBERS, profile === undefined ? {} : { profile })
}

describe('a delorun refusal', () => {
  it('prints a CliError as it is and exits with its code', () => {
    expect(cliRefusal(new CliError(EXIT.usage, 'delorun: unknown command "x"'), [])).toEqual({ text: 'delorun: unknown command "x"\n', exit: EXIT.usage })
    expect(cliRefusal(new SetupCancelled(), [])).toEqual({ text: 'delorun setup: cancelled\n', exit: EXIT.failed })
    expect(cliRefusal(new Error('boom'), [])).toEqual({ text: 'Delo stopped: boom\n', exit: EXIT.failed })
  })

  it('names the profile the command line named in its remedies', () => {
    expect(namedProfile(['update', '--profile', 'work'])).toBe('work')
    expect(namedProfile(['update', '--profile=work'])).toBe('work')
    expect(namedProfile(['headless', '--', '--profile', 'work'])).toBeUndefined()
    expect(namedProfile(['update'])).toBeUndefined()
    expect(cliRefusal(new TrashError('TRASH_ITEM_NOT_FOUND', 'no item x'), ['trash', 'restore', 'x', '--profile', 'work']).text).toBe('Delo did not change the trash.\nWhy: TRASH_ITEM_NOT_FOUND: no item x\nWhat you can do:\n  See what the trash holds: delorun trash list --profile work\n')
    expect(refusalOf(new TrashError('TRASH_RESTORE_CONFLICT', 'the chat exists')).remedies).toEqual([])
  })

  it('reads delorun\'s own errors with their facts', () => {
    expect(refusalOf(new DeloVersionError('package.json', 'package.json carries no version'))).toEqual({ lead: 'Delo could not read its own version.', reason: 'package.json carries no version', remedies: [] })
    expect(refusalOf(new DataInUseError('process 12 (delorun import) uses the chat data'))).toEqual({ lead: 'Delo did not go ahead: another process uses the chat data.', reason: 'process 12 (delorun import) uses the chat data', remedies: ['Wait for it to end, then run the same command again.'] })
    expect(refusalOf(new BundleReadError('BUNDLE_PATCH_UNREADABLE', '@delo/bundle-local', 'patch.yml is not YAML'))).toEqual({ lead: 'Delo could not read the metadata of the bundle @delo/bundle-local.', reason: 'BUNDLE_PATCH_UNREADABLE: patch.yml is not YAML', remedies: [] })
  })

  it('offers each profile-safety remedy, and tells a refusal from a failed snapshot', () => {
    const remedies: readonly ProfileSafetyRemedy[] = ['skip-update', 'keep', 'update-plugin', 'keep-disabled', 'eject', 'restore', 'rollback', 'safe-mode', 'repair-profile']
    const refused = refusalOf(new ProfileSafetyError('ROW_NOT_CARRIED', '/h/profiles/work', 'row x is not carried', remedies), 'work')
    expect(refused.lead).toBe('Delo refused the change and left the profile as it was.')
    expect(refused.reason).toBe('ROW_NOT_CARRIED: row x is not carried')
    expect(refused.remedies).toEqual([
      'Do not take this update.',
      'Keep what the message names in place and wait for a release that carries it.',
      'Update the plugin to a version the new release runs.',
      'Keep the plugin disabled.',
      'Eject the plugin, which keeps its rows and configuration in the profile.',
      'Restore a profile history version: delorun recover restore <version> --profile work',
      'Switch back to the previous release: delorun recover rollback --profile work',
      'Start in safe mode: delorun recover safe-mode --profile work',
      'Repair the profile file the message names, then run the same command again.',
    ])
    expect(refusalOf(new ProfileSafetyError('SNAPSHOT_FAILED', '/h/profiles/work', 'the disk is full')).lead).toBe('Delo could not write the profile snapshot it takes before a change.')
  })

  it('reads each session-data refusal, the ones the home process shares as its own', () => {
    const leads: ReadonlyArray<readonly [DataSafetyErrorCode, string]> = [
      ['DATA_COPY_NO_SPACE', 'Delo did not copy the chat data: the copy does not fit on the home\'s disk.'],
      ['ROLLBACK_NEEDS_DATA_COPY', 'Delo did not roll back: going back would hand newer chat data to an older release, and no copy of the older data exists.'],
      ['DATA_RESTORE_INCONSISTENT', 'Delo did not restore the chat data: the restore\'s journal or directories are not in a state a restore leaves.'],
      ['NOT_KEPT_DATA', 'Delo did not remove that path: it is not a copy or set-aside directory of this home.'],
      ['DATA_NOT_A_DIRECTORY', 'Delo did not copy the chat data: sessions/ or storages/ is a symbolic link or not a directory.'],
      ['DATA_IN_USE', 'Delo did not remove or replace the copy: a restore or rollback runs, or an update record refers to it.'],
    ]
    for (const [code, lead] of leads) {
      const refusal = refusalOf(new DataSafetyError(code, 'the detail'))
      expect(refusal.lead, code).toBe(lead)
      expect(refusal.reason, code).toBe(`${code}: the detail`)
    }
    expect(refusalOf(new DataSafetyError('NOT_KEPT_DATA', '/etc is not kept'), 'work').remedies).toEqual(['See what Delo keeps: delorun recover status --profile work'])
  })

  it('reads each refused update report', () => {
    expect(refusalOf(new UpdateReportError('REPORT_TARGET_UNVERIFIED', 'the signature does not verify'))).toEqual({ lead: 'Delo made no update report: the release did not verify.', reason: 'REPORT_TARGET_UNVERIFIED: the signature does not verify', remedies: ['See every check: delorun verify'] })
    expect(refusalOf(new UpdateReportError('REPORT_VERSION_INVALID', 'x')).lead).toBe('Delo made no update report: the version is not a semantic version.')
    expect(refusalOf(new UpdateReportError('REPORT_DISPOSED'))).toEqual({ lead: 'Delo stopped before the update report was ready.', reason: 'REPORT_DISPOSED', remedies: [] })
  })

  it('reads a held turn and the release package\'s verification failures', () => {
    expect(refusalOf(new UpdatePendingError()).reason).toContain('UPDATE_PENDING: ')
    expect(refusalOf(new VerificationError('root 2 names key k without listing it'))).toEqual({ lead: 'Delo refused a release file that did not verify.', reason: 'root 2 names key k without listing it', remedies: ['See every check: delorun verify'] })
    expect(refusalOf(new LogVerificationError('inclusion-proof-invalid', 'the proof does not reproduce the root')).reason).toBe('inclusion-proof-invalid: the proof does not reproduce the root')
    expect(refusalOf(new TileError('a tile of 31 bytes'))).toEqual({ lead: 'The release log served a tile that does not hold together.', reason: 'a tile of 31 bytes', remedies: ['Report this if it repeats.'] })
  })
})
