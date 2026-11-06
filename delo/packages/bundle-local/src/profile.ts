/**
 * The bundle list of Delo's CLI profiles and the upstream rows that `@delo/bundle-local` writes. `delorun` writes
 * {@link DELO_PROFILE_BUNDLES} into a new CLI profile's `dsh.profile.bundles`; the package's composition spec checks
 * that the composed profile differs from upstream's web profile only in the rows of `LOCAL_ROWS` (`./rows`).
 *
 * @module @delo/bundle-local/profile
 */
import { PROFILE_TEMPLATES } from '@deepseek-ai/dsh-official-bundles'

/** This bundle's package name, as a profile's `dsh.profile.bundles` lists it. */
export const LOCAL_BUNDLE = '@delo/bundle-local'

/** Upstream's shipped profile template that Delo's CLI profiles extend. */
export const UPSTREAM_TEMPLATE = 'web'

const upstream = PROFILE_TEMPLATES[UPSTREAM_TEMPLATE]
if (upstream === undefined) throw new Error(`@delo/bundle-local: upstream ships no ${UPSTREAM_TEMPLATE} profile template`)

/**
 * The ordered bundle layers of a Delo CLI profile: upstream's web template, then this bundle, which therefore
 * writes after every upstream bundle and before the profile's own `cordis.patch.yml`.
 *
 * Contract for `delorun`, which owns the CLI profiles: it writes this list into the `dsh.profile.bundles` of every
 * CLI profile it creates, and it refuses to start a CLI profile when upstream's profile loader reports this bundle
 * skipped (`skippedBundles`), because the privacy defaults of {@link LOCAL_ROWS} hold only while the bundle loads.
 * This package does neither itself.
 */
export const DELO_PROFILE_BUNDLES: readonly string[] = [...upstream.bundles, LOCAL_BUNDLE]

export { LOCAL_ROWS, parityPatches, type LocalRow, type LocalRowParity, type PatchRow } from './rows.ts'
