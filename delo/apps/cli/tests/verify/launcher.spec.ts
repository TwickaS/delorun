/**
 * The launcher line of `delorun verify`: the version of the launcher that started the run against the `npm` entries of
 * the installed release's signed manifest, with the integrity a person compares with npm's own record.
 */
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { NpmIntegrity, ReleaseManifest, SemanticVersion } from '@delo/contract-release-manifest'
import { launcherComparison } from '../../src/verify/checks.ts'
import { fixtureRelease, VERSION } from '../../../install/tests/support.ts'

/**
 * The fixture manifest with other `npm` entries.
 * @param npm - the entries.
 * @returns the manifest.
 */
async function listing(npm: ReleaseManifest['npm']): Promise<ReleaseManifest> {
  return { ...(await fixtureRelease()).manifest, npm }
}

const INTEGRITY = brandString<NpmIntegrity>(`sha512-${'B'.repeat(86)}==`)

describe('the launcher line', () => {
  it('names the integrity the signed manifest gives the running launcher version, and the npm command to compare it with', async () => {
    const manifest = await listing([{ name: 'delorun', version: brandString<SemanticVersion>(VERSION), integrity: INTEGRITY }])
    expect(launcherComparison(VERSION, manifest)).toBe(`delorun@${VERSION} as the launcher reported it, which release ${VERSION}'s signed manifest lists with integrity ${String(INTEGRITY)}; compare it with npm view delorun@${VERSION} dist.integrity`)
  })

  it('says the launcher is another version than the one the release lists, without passing it', async () => {
    const manifest = await listing([{ name: 'delorun', version: brandString<SemanticVersion>(VERSION), integrity: INTEGRITY }])
    const line = launcherComparison('0.0.9', manifest)
    expect(line).toContain(`lists delorun@${VERSION}, so compare the launcher with the manifest of release 0.0.9`)
    expect(line).not.toContain('integrity')
  })

  it('says a release that lists no launcher package has nothing to compare it with', async () => {
    expect(launcherComparison(VERSION, await listing([{ name: 'create-delorun', version: brandString<SemanticVersion>(VERSION), integrity: INTEGRITY }]))).toContain('lists no delorun npm package')
  })

  it('says the launcher named no version when it set none', async () => {
    expect(launcherComparison(undefined, await listing([]))).toContain('reported no version (DELO_LAUNCHER_VERSION)')
  })
})
