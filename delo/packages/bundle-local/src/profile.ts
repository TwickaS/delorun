/**
 * The bundle list of Delo's CLI profiles and the upstream rows that `@delo/bundle-local` writes. `delorun` writes
 * {@link DELO_PROFILE_BUNDLES} into a new CLI profile's `dsh.profile.bundles`; the package's composition spec checks
 * that the composed profile differs from upstream's web profile only in the rows of {@link LOCAL_ROWS}.
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
 */
export const DELO_PROFILE_BUNDLES: readonly string[] = [...upstream.bundles, LOCAL_BUNDLE]

/** One row of the composition that `@delo/bundle-local` changes or adds, with the reason the change exists. */
export interface LocalRow {
  /** The row's entry id. */
  readonly id: string
  /** `changed` for an upstream row whose fields the bundle sets, `added` for a row the bundle inserts. */
  readonly kind: 'changed' | 'added'
  /** Why the row differs from upstream's web profile, in one sentence. */
  readonly reason: string
}

/** Every row in which a Delo CLI profile's composition differs from upstream's web profile. */
export const LOCAL_ROWS: readonly LocalRow[] = []
