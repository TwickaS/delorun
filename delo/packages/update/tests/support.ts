/**
 * Fixtures for the pre-update report's specs: two releases, a profile of plugins, bundles and layers, the target's
 * facts, and the sources a service reads them from. Every value is explicit, so a spec that changes one fact changes
 * one line.
 */
import type { ExemptionRecord } from '@delo/contract-plugin-versions'
import type { SemanticVersion, Sha256Hex, UtcTimestamp } from '@delo/contract-release-manifest'
import { DATA_FORMATS_SCHEMA, type DataCopySize, type DataFormats, type Installation, type InstallationStatus, type ReportReason, type ReportVersions, type UpdateReport, type UpdateState } from '@delo/contract-update-report'
import { readInstalledPlugin, type BundleFacts, type DataFacts, type InstalledPluginFact, type ProfileFacts, type ReportInput, type ReportSources, type RevokedPluginVersion, type TargetFacts } from '../src/index.ts'

/**
 * A plain string as the brand a fixture needs; the brands are compile-time only.
 * @param value - the string.
 * @returns the same string, branded.
 */
function brand<T>(value: string): T {
  return value as unknown as T
}

/**
 * A semantic version for a fixture.
 * @param text - the version.
 * @returns the version, branded.
 */
export function version(text: string): SemanticVersion {
  return brand<SemanticVersion>(text)
}

/** When the default report was built. */
export const GENERATED = brand<UtcTimestamp>('2026-05-04T09:30:00.000Z')

/** The default verified manifest's digest. */
export const MANIFEST = brand<Sha256Hex>('b'.repeat(64))

/**
 * One release's identity.
 * @param delo - Delo's version.
 * @param dsh - DSH's version.
 * @param channel - the channel; `stable` by default.
 * @returns the versions.
 */
export function release(delo: string, dsh: string, channel: 'stable' | 'beta' = 'stable'): ReportVersions {
  return { delo: version(delo), dsh: version(dsh), channel }
}

/** The release the default fixture runs: Delo 0.9.0 on DSH 0.2.2. */
export const FROM: ReportVersions = release('0.9.0', '0.2.2')

/** The release the default fixture would install: Delo 1.0.0 on DSH 0.3.0. */
export const TO: ReportVersions = release('1.0.0', '0.3.0')

/**
 * An installed plugin read the way the profile's reader reads one.
 * @param name - the package name.
 * @param at - the installed exact version.
 * @param engines - the `engines` object its manifest declares, if any.
 * @returns the plugin.
 */
export function installed(name: string, at: string, engines?: Readonly<Record<string, unknown>>): InstalledPluginFact {
  const manifest = { name, version: at, ...engines === undefined ? {} : { engines } }
  return readInstalledPlugin(name, version(at), JSON.stringify(manifest))
}

/**
 * An installed plugin whose `package.json` does not parse.
 * @param name - the package name.
 * @param at - the installed exact version.
 * @returns the plugin, with no readable requirements.
 */
export function unreadable(name: string, at: string): InstalledPluginFact {
  return readInstalledPlugin(name, version(at), '{"name": ')
}

/**
 * The target release's facts.
 * @param overrides - the fields to replace.
 * @returns the facts; every check passed, no retired bundle, no template, no skipped bundle, no revocation.
 */
export function target(overrides: Partial<TargetFacts> = {}): TargetFacts {
  return {
    versions: TO,
    release: { manifest: MANIFEST, signature: 'passed', freshness: 'passed', log: 'passed' },
    bundles: { retired: [], skipped: [] },
    revocations: [],
    ...overrides,
  }
}

/**
 * The profile's facts.
 * @param overrides - the fields to replace.
 * @returns the facts; no plugin, bundle or layer, and empty exemption files.
 */
export function profile(overrides: Partial<ProfileFacts> = {}): ProfileFacts {
  return { plugins: [], bundles: [], layers: [], exemptions: { dsh: {}, delo: {} }, ...overrides }
}

/**
 * Both exemption files.
 * @param dsh - `compatibility.json`'s contents.
 * @param delo - `delo-compatibility.json`'s contents.
 * @returns the files.
 */
export function exemptions(dsh: ExemptionRecord, delo: ExemptionRecord = {}): Readonly<Record<'dsh' | 'delo', ExemptionRecord>> {
  return { dsh, delo }
}

/**
 * One installation's status record.
 * @param id - the installation.
 * @param delo - its Delo version, absent when its record is unknown.
 * @param dsh - its DSH version, absent when its record is unknown.
 * @param state - its update state.
 * @param target - the version it is updating to, when it is.
 * @returns the record.
 */
export function status(id: Installation, delo: string | undefined, dsh: string | undefined, state: UpdateState, target?: string): InstallationStatus {
  return {
    id,
    state,
    ...delo === undefined ? {} : { delo: version(delo) },
    ...dsh === undefined ? {} : { dsh: version(dsh) },
    ...target === undefined ? {} : { target: version(target) },
  }
}

/** The profile the report specs use: ten plugins, three bundles and three layers, one of them an Include. */
export const PROFILE: ProfileFacts = profile({
  plugins: [
    installed('dsh-tools', '1.4.0', { dsh: '^0.3.0' }),
    installed('calendar', '2.0.0', { dsh: '^0.1.0' }),
    installed('bridge', '0.5.0', { dsh: '^0.3.0', delo: '^0.10.0' }),
    installed('notes', '1.0.0', { delo: '^1.0.0' }),
    installed('legacy', '3.0.0'),
    installed('exempt-plugin', '1.2.0', { dsh: '^0.2.0' }),
    installed('old-exempt', '0.1.0', { dsh: '^0.2.0' }),
    unreadable('broken', '1.0.0'),
    installed('revoked-plugin', '0.4.0', { dsh: '^0.3.0' }),
    installed('weird', '1.0.0', { dsh: 42 }),
    installed('legacy-x', '1.0.0', { dsh: '^0.1.0' }),
  ],
  bundles: ['dsh-base', 'dsh-retired-thing', 'dsh-tools-bundle'],
  layers: [
    { layer: 'dsh-base', rows: [{ id: 'core', name: 'dsh-core', plugins: ['calendar'] }, { name: 'cordis-plugin-notes', plugins: ['notes'] }] },
    { layer: 'profile patch', rows: [{ name: 'include-legacy', include: { file: 'legacy.yml', rows: [{ name: 'row-a', plugins: ['legacy-x'] }, { name: 'row-b', plugins: ['dsh-tools'] }] } }] },
    { layer: 'home patch', rows: [{ name: 'cordis-plugin-broken', plugins: ['broken'] }] },
  ],
  exemptions: exemptions({ 'exempt-plugin@1.2.0': [version('0.3.0')], 'old-exempt@0.1.0': [version('0.2.2')] }),
})

/** The target's bundle facts for the default fixture: one bundle retired, one the target cannot load. */
export const BUNDLE_FACTS: BundleFacts = { retired: ['dsh-retired-thing'], skipped: [{ package: 'dsh-tools-bundle', reason: 'engines.dsh does not match' }] }

/**
 * The revocation the default fixture's target list holds.
 * @param name - the package to revoke.
 * @param at - the version to revoke.
 * @returns the list.
 */
export function revocations(name = 'revoked-plugin', at = '0.4.0'): readonly RevokedPluginVersion[] {
  return [{ package: name, versions: [version(at)], reason: 'malicious', message: 'exfiltrates tokens from the workspace' }]
}

/** Both installations' records for the default fixture: the CLI home runs, the desktop Host has a newer release offered. */
export const STATUSES = {
  'cli-home': status('cli-home', '0.9.0', '0.2.2', 'reporting', '1.0.0'),
  'desktop-host': status('desktop-host', '0.9.0', '0.2.2', 'available', '1.0.0'),
}

/** A `data-formats.json` record for a fixture release. */
export const FORMATS: DataFormats = { schema: DATA_FORMATS_SCHEMA, persistence: brand<Sha256Hex>('c'.repeat(64)), deloRecords: { 'update-record': 1 } }

/** A copy of three files and 300 bytes on a filesystem with 10,000 bytes free. */
export const COPY: DataCopySize = { files: 3, bytes: 300, free: 10_000 }

/** Two releases that read each other's data. */
export const DATA: DataFacts = { from: { dsh: version('0.2.2'), formats: FORMATS }, to: { dsh: version('0.2.2'), formats: FORMATS }, copy: COPY }

/**
 * A report input over the default fixture.
 * @param overrides - the fields to replace.
 * @returns the input.
 */
export function input(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    installation: 'cli-home',
    from: FROM,
    target: target({ bundles: BUNDLE_FACTS, revocations: revocations() }),
    profile: PROFILE,
    statuses: STATUSES,
    data: DATA,
    generated: GENERATED,
    ...overrides,
  }
}

/**
 * The sources a service reads, each answering from a fixture.
 * @param overrides - the readers to replace.
 * @returns the sources; the default ones answer the fixture above.
 */
export function sources(overrides: Partial<ReportSources> = {}): ReportSources {
  return {
    running: async () => FROM,
    statuses: async () => STATUSES,
    profile: async () => PROFILE,
    target: async () => target({ bundles: BUNDLE_FACTS, revocations: revocations() }),
    data: async () => DATA,
    now: () => GENERATED,
    ...overrides,
  }
}

/**
 * The reason one plugin item states, for a spec that cares about the decision rather than the whole item.
 * @param report - the report.
 * @param name - the plugin's package name.
 * @returns the first reason the report states for that plugin, or undefined when it names none.
 */
export function reasonOf(report: UpdateReport, name: string): ReportReason | undefined {
  return report.items.find(item => item.kind === 'plugin' && item.subject.name === name)?.reason
}
