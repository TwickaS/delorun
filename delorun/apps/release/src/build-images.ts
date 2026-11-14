/**
 * Builds the S2 and S3 images after `build-closure.ts`, as part of the same recipe:
 *
 * `node_modules/.bin/tsx delorun/apps/release/src/build-images.ts --version <version> --out <dir> --oci <dir>
 * [--attestation-key <file> --attestation <file>]`
 *
 * `--out` is the closure build's output, whose Linux archives the S3 image carries and whose entries' mtime is the
 * release's `SOURCE_DATE_EPOCH`; the command writes `delorun-<version>.images.json` and each image's seccomp profile
 * `delorun-<version>.<image>.seccomp.json` with its licence `delorun-<version>.<image>.seccomp.LICENSE` there, which
 * the rebuild comparison compares byte for byte, and rewrites the SBOM so it describes both images. The OCI layout
 * tars go to `--oci`, from which the release workflow pushes the images by digest. It needs Docker with BuildKit and
 * emulation for the other architecture. On the targets-key holder's machine, `--attestation-key` and `--attestation`
 * name the attestation `build-closure.ts` wrote: before building, the command refuses unless its HMAC verifies with
 * the key and it covers exactly the files in `--out`; afterwards it extends it with the images file, the seccomp
 * profiles, their licences and the rewritten SBOM, keeping its commit, so a directory this machine's build did not
 * write gets no attestation.
 *
 * @module @delorun/release/build-images
 */
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { archiveEntries } from '@delorun/release-formats/archive/inspect'
import { semanticVersion } from '@delorun/release-formats/brands'
import { closureFileNames } from './closure/tree.ts'
import { readRecipe } from './closure/config.ts'
import { builderProblems, builderVersions, buildImages, imagesName, readImagesRecipe, seccompLicenceName, seccompName } from './images/build.ts'
import { attestationText, extendAttestation, readAttestation, readAttestationKey, type AttestedBuild } from './rebuild/attestation.ts'
import { isWithin, outputRefs } from './rebuild/record.ts'
import { sbomName, writeReleaseSbom } from './sbom/release-sbom.ts'

async function main(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({ args: [...argv], strict: true, options: { 'version': { type: 'string' }, 'out': { type: 'string' }, 'oci': { type: 'string' }, 'attestation-key': { type: 'string' }, 'attestation': { type: 'string' } } })
  try {
    if (values.version === undefined || values.out === undefined || values.oci === undefined) throw new Error('pass --version <version>, --out <dir> and --oci <dir>')
    const version = semanticVersion(values.version)
    const out = resolve(values.out)
    if ((values['attestation-key'] === undefined) !== (values.attestation === undefined)) throw new Error('pass --attestation-key and --attestation together')
    const attestationKey = values['attestation-key'] === undefined ? undefined : readAttestationKey(resolve(values['attestation-key']))
    const attestationPath = values.attestation === undefined ? undefined : resolve(values.attestation)
    let attested: AttestedBuild | undefined
    if (attestationKey !== undefined && attestationPath !== undefined) {
      if (isWithin(attestationPath, out)) throw new Error(`the attestation ${attestationPath} lies in ${out}`)
      attested = readAttestation(attestationKey, readFileSync(attestationPath))
      if (attested.version !== version) throw new Error(`the attestation covers release ${attested.version}, not ${version}`)
      extendAttestation(attested, await outputRefs(out), [])
    }
    const entries = archiveEntries(join(out, closureFileNames(version, 'linux-x64').archive), 'tar.gz')
    const first = await entries.next()
    await entries.return(undefined)
    if (first.done === true) throw new Error('the linux-x64 closure holds no entry')
    await mkdir(resolve(values.oci), { recursive: true })
    const builder = builderVersions()
    const recipe = readRecipe()
    const problems = builderProblems(recipe.toolchain.images, builder)
    if (problems.length > 0) throw new Error(problems.join('\n'))
    const images = await buildImages({ recipe: readImagesRecipe(), out, oci: resolve(values.oci), version, epoch: first.value.mtime, builder })
    for (const [name, image] of Object.entries(images)) console.log(`build-images: ${name}: ${image.repository}@${image.index}`)
    const complete = recipe.closure.platforms.every(platform => existsSync(join(out, closureFileNames(version, platform).archive)))
    if (complete) console.log(`build-images: rewrote ${await writeReleaseSbom(out, version, recipe.closure.platforms, recipe.toolchain, readImagesRecipe().base)} with both images`)
    else console.log('build-images: the output does not hold every release platform\'s closure, so no SBOM is written')
    if (attestationKey !== undefined && attestationPath !== undefined && attested !== undefined) {
      const extended = extendAttestation(attested, await outputRefs(out), [imagesName(version), sbomName(version), ...(['s2', 's3'] as const).flatMap(image => [seccompName(version, image), seccompLicenceName(version, image)])])
      await writeFile(attestationPath, attestationText(attestationKey, extended), { mode: 0o644 })
      console.log(`build-images: extended the attestation in ${attestationPath} with the images file, the seccomp profiles, their licences and the SBOM`)
    }
    return 0
  } catch (error) {
    console.error(`build-images: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
