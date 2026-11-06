/**
 * Builds the S2 and S3 images after `build-closure.ts`, as part of the same recipe:
 *
 * `node_modules/.bin/tsx delo/apps/release/src/build-images.ts --version <version> --out <dir> --oci <dir>
 * [--commit <rev>] [--attestation-key <file> --attestation <file>]`
 *
 * `--out` is the closure build's output, whose Linux archives the S3 image carries and whose entries' mtime is the
 * release's `SOURCE_DATE_EPOCH`; the command writes `delorun-<version>.images.json` there, which the rebuild
 * comparison compares byte for byte, and rewrites the SBOM so it describes both images. The OCI layout tars go to
 * `--oci`, from which the release workflow pushes the images by digest. It needs Docker with BuildKit and emulation
 * for the other architecture. On the targets-key holder's machine, `--attestation-key` and `--attestation` rewrite
 * the attestation `build-closure.ts` wrote so it covers the images file and the rewritten SBOM too; `--commit` (`HEAD`
 * when omitted) is the commit the closures were built from.
 *
 * @module @delo/release/build-images
 */
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { RUNTIME_PLATFORMS } from '@delo/contract-release-manifest'
import { repositoryRoot } from '@delo/tools/src/git.ts'
import { archiveEntries } from './archive/inspect.ts'
import { semanticVersion } from './brands.ts'
import { closureFileNames } from './closure/tree.ts'
import { readRecipe } from './closure/config.ts'
import { buildImages, readImagesRecipe } from './images/build.ts'
import { attestationText, readAttestationKey } from './rebuild/attestation.ts'
import { commitOf, isWithin, outputRefs } from './rebuild/record.ts'
import { writeReleaseSbom } from './sbom/release-sbom.ts'

async function main(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({ args: [...argv], strict: true, options: { 'version': { type: 'string' }, 'out': { type: 'string' }, 'oci': { type: 'string' }, 'commit': { type: 'string', default: 'HEAD' }, 'attestation-key': { type: 'string' }, 'attestation': { type: 'string' } } })
  try {
    if (values.version === undefined || values.out === undefined || values.oci === undefined) throw new Error('pass --version <version>, --out <dir> and --oci <dir>')
    const version = semanticVersion(values.version)
    const out = resolve(values.out)
    if ((values['attestation-key'] === undefined) !== (values.attestation === undefined)) throw new Error('pass --attestation-key and --attestation together')
    const attestationKey = values['attestation-key'] === undefined ? undefined : readAttestationKey(resolve(values['attestation-key']))
    const entries = archiveEntries(join(out, closureFileNames(version, 'linux-x64').archive), 'tar.gz')
    const first = await entries.next()
    await entries.return(undefined)
    if (first.done === true) throw new Error('the linux-x64 closure holds no entry')
    await mkdir(resolve(values.oci), { recursive: true })
    const images = await buildImages({ recipe: readImagesRecipe(), out, oci: resolve(values.oci), version, epoch: first.value.mtime })
    for (const [name, image] of Object.entries(images)) console.log(`build-images: ${name}: ${image.repository}@${image.index}`)
    const complete = RUNTIME_PLATFORMS.every(platform => existsSync(join(out, closureFileNames(version, platform).archive)))
    if (complete) console.log(`build-images: rewrote ${await writeReleaseSbom(out, version, readRecipe().toolchain, readImagesRecipe().base)} with both images`)
    else console.log('build-images: the output does not hold every platform\'s closure, so no SBOM is written')
    if (attestationKey !== undefined && values.attestation !== undefined) {
      const path = resolve(values.attestation)
      if (isWithin(path, out)) throw new Error(`write the attestation outside ${out}`)
      await writeFile(path, attestationText(attestationKey, { version, commit: commitOf(repositoryRoot(process.cwd()), values.commit), outputs: await outputRefs(out) }), { mode: 0o644 })
      console.log(`build-images: attested ${out} with the images in ${path}`)
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
