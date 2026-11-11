/**
 * The bundle list of Delo's CLI profiles and the upstream rows that `@delo/bundle-local` writes. `delorun` writes
 * {@link DELO_PROFILE_BUNDLES} into a new CLI profile's `dsh.profile.bundles`; the package's composition spec checks
 * that the composed profile differs from upstream's web profile only in the rows of `LOCAL_ROWS` (`./rows`) and the
 * rows `@delo/bundle-studio` inserts.
 *
 * @module @delo/bundle-local/profile
 */
import { PROFILE_TEMPLATES } from '@deepseek-ai/dsh-official-bundles'

/** This bundle's package name, as a profile's `dsh.profile.bundles` lists it. */
export const LOCAL_BUNDLE = '@delo/bundle-local'

/** Delo's studio bundle, which mounts the studio additions after this bundle. */
export const STUDIO_BUNDLE = '@delo/bundle-studio'

/**
 * Delo's headless bundle, which `delorun headless` links into the home's `headless` profile after upstream's
 * `headless` template: the guard rows a one-shot task runs under.
 */
export const HEADLESS_BUNDLE = '@delo/bundle-headless'

/** Upstream's shipped profile template that Delo's CLI profiles extend. */
export const UPSTREAM_TEMPLATE = 'web'

/**
 * The environment variable the `workspace-controller` row reads its `defaultWorkspaceDirectory` from. `delorun start`
 * sets it in the Host's own process before the profile boots; any other boot leaves it unset, so upstream's own
 * documents lookup applies.
 */
export const DEFAULT_WORKSPACE_ENV = 'DELO_DEFAULT_WORKSPACE'

/**
 * The environment variable the `plugin-manager` row reads its `fallbackRegistries` from: `on` adds the npmmirror
 * registry, anything else none. `delorun start` and `delorun headless` set it in the Host's own process from the
 * `npmMirror` setting of the profile's `delo-plugin-install-check` row before the profile boots.
 */
export const NPM_MIRROR_ENV = 'DELO_NPM_MIRROR'

const upstream = PROFILE_TEMPLATES[UPSTREAM_TEMPLATE]
if (upstream === undefined) throw new Error(`@delo/bundle-local: upstream ships no ${UPSTREAM_TEMPLATE} profile template`)

/**
 * The ordered bundle layers of a Delo CLI profile: upstream's web template, then this bundle, which therefore
 * writes after every upstream bundle, then {@link STUDIO_BUNDLE}, and then the profile's own `cordis.patch.yml`.
 *
 * Contract for `delorun`, which owns the CLI profiles: it writes this list into the `dsh.profile.bundles` of every
 * CLI profile it creates, and it refuses to start a CLI profile when upstream's profile loader reports this bundle
 * skipped (`skippedBundles`), because the privacy defaults of {@link LOCAL_ROWS} hold only while the bundle loads.
 * This package does neither itself.
 */
export const DELO_PROFILE_BUNDLES: readonly string[] = [...upstream.bundles, LOCAL_BUNDLE, STUDIO_BUNDLE]

export { LOCAL_ROWS, parityPatches, type LocalRow, type LocalRowParity, type PatchRow } from './rows.ts'
