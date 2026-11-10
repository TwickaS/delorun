/** Test profiles under a temporary Harness home: a Delo CLI profile and upstream's web profile, and their composed rows. */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { composeEntries, initProfile, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { PROFILE_TEMPLATES } from '@deepseek-ai/dsh-official-bundles'
import { DELO_PROFILE_BUNDLES, LOCAL_BUNDLE, STUDIO_BUNDLE, UPSTREAM_TEMPLATE } from '../src/profile.ts'

/** The repository root. */
export const REPO = fileURLToPath(new URL('../../../../', import.meta.url))
/** This package's directory, which a profile links as `dsh plugin add` would. */
export const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))
/** `@delo/bundle-studio`'s directory, which a profile links beside this package, as `delorun setup` does. */
export const STUDIO_PACKAGE_DIR = fileURLToPath(new URL('../../bundle-studio/', import.meta.url))
/** Upstream's CLI package manifest, the first anchor of bundle resolution. */
export const INSTALL_ANCHOR = join(REPO, 'apps/cli/package.json')
/** The Delo CLI profile name C1 fixes. */
export const DELO_PROFILE = 'default'

/** A composed entry list. */
export type ComposedRows = ReturnType<typeof composeEntries>

/** A temporary Harness home holding a Delo CLI profile and upstream's web profile. */
export interface TestHome {
  readonly dir: string
  /**
   * The composed rows of one of the home's profiles, as boot and `--dump-config` compose them.
   * @param profile - {@link DELO_PROFILE} or {@link UPSTREAM_TEMPLATE}.
   * @returns the composed entry list.
   */
  rows(profile: string): ComposedRows
  /** Remove the home. */
  remove(): void
}

/**
 * Create a temporary Harness home with a Delo CLI profile, whose bundle list is {@link DELO_PROFILE_BUNDLES} and which
 * links this package and `@delo/bundle-studio` under its `node_modules`, and upstream's web profile from its shipped
 * template.
 * @param base - the directory the home is created under; the OS temporary directory by default. A spec whose subject
 *   is the sandbox's protection creates the home outside that directory, which upstream's profiles replace with a
 *   private `/tmp`.
 * @returns the home.
 */
export function createTestHome(base?: string): TestHome {
  const dir = mkdtempSync(join(base ?? tmpdir(), 'delo-bundle-local-'))
  const delo = join(dir, 'profiles', DELO_PROFILE)
  initProfile(delo, DELO_PROFILE_BUNDLES)
  for (const [name, target] of [[LOCAL_BUNDLE, PACKAGE_DIR], [STUDIO_BUNDLE, STUDIO_PACKAGE_DIR]] as const) {
    const link = join(delo, 'node_modules', name)
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(target, link, 'junction')
  }
  initProfile(join(dir, 'profiles', UPSTREAM_TEMPLATE), PROFILE_TEMPLATES[UPSTREAM_TEMPLATE]?.bundles ?? [])
  return {
    dir,
    rows: profile => composeEntries(loadProfileDirectory('dsh', join(dir, 'profiles', profile), INSTALL_ANCHOR).layers.map(layer => layer.patches)),
    remove: () => { rmSync(dir, { recursive: true, force: true }) },
  }
}
