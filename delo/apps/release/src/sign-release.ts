/**
 * The signing command of contract C2, run by the targets-key holder on their own machine, outside CI:
 *
 * `node_modules/.bin/tsx delo/apps/release/src/sign-release.ts --release <dir> --rebuild <dir> --record <file>
 * --attestation <file> --attestation-key <file> --key <targets.pem> [--first-of-line]`
 *
 * `--release` holds the release workflow's files with its `manifest-draft.json`; `--rebuild` is the holder's own
 * rebuild output on this machine, `--record` the rebuild record `record-rebuild.ts` wrote and `--attestation` the
 * attestation `build-closure.ts --attestation-key` wrote, all outside `--release`. The command refuses, naming the
 * required source, without a rebuild record, when the release directory already holds one, with a record that does
 * not report a match or says it was made in CI, when `CI` or `GITHUB_ACTIONS` is set, when the rebuild output does
 * not reproduce the record's digests or lacks a runtime archive or file list, when the record's commit is not the
 * tag's or its recipe and toolchain are not those committed there, when the attestation does not verify with the
 * holder's `--attestation-key` over the rebuild's files, or when comparing the workflow's output with the rebuild
 * again finds a difference, or when the dependency advisory check, run again against contract C2's feed with the
 * acceptances committed at the release's commit, fails. It also refuses a draft whose runtime files are not the
 * release's closure file names, a draft without `security` or a valid `summary`, a draft whose `dsh` is not the
 * app-boot version at the tagged commit, and a patch release that the patch rule of `sign/patch-rule.ts` refuses. A
 * patch version (such as `0.1.3`) with no earlier release of its major and minor tagged and listed in the committed
 * changelog refuses unless `--first-of-line` states that it is the first release of that line.
 * Otherwise it writes each signed runtime file list, the record as `delorun-<version>.rebuild.json` and
 * `delorun-<version>.manifest.json` under temporary names and renames them into place. The key is a PKCS #8 PEM file
 * with an Ed25519 private key and mode 0600; the guide in the package README states how the holder makes it and the
 * attestation key.
 *
 * @module @delo/release/sign-release
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { ADVISORY_FEED_URL } from '@delo/contract-release-manifest'
import { repositoryRoot } from '@delo/tools/src/git.ts'
import { readAttestationKey } from './rebuild/attestation.ts'
import { readSigningKey } from '@delo/release-formats/sign/envelope'
import { signRelease, SigningRefusal } from './sign/release.ts'

async function main(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({ args: [...argv], strict: true, options: { 'release': { type: 'string' }, 'rebuild': { type: 'string' }, 'record': { type: 'string' }, 'attestation': { type: 'string' }, 'attestation-key': { type: 'string' }, 'key': { type: 'string' }, 'first-of-line': { type: 'boolean', default: false } } })
  if (values.release === undefined || values.rebuild === undefined || values.record === undefined || values.attestation === undefined || values['attestation-key'] === undefined || values.key === undefined) {
    console.error('sign-release: pass --release <dir>, --rebuild <dir>, --record <file>, --attestation <file>, --attestation-key <file> and --key <targets.pem>, and optionally --first-of-line')
    return 2
  }
  try {
    const signed = await signRelease({
      repository: repositoryRoot(process.cwd()),
      release: resolve(values.release),
      rebuild: resolve(values.rebuild),
      record: resolve(values.record),
      attestation: resolve(values.attestation),
      attestationKey: readAttestationKey(resolve(values['attestation-key'])),
      key: readSigningKey(resolve(values.key)),
      env: process.env,
      now: new Date(),
      feed: ADVISORY_FEED_URL,
      firstOfLine: values['first-of-line'],
    })
    for (const item of signed.comparison.accepted) console.log(`sign-release: accepted ${item.file}: ${item.entry} (rebuild exception ${item.exception})`)
    console.log(`sign-release: signed ${signed.manifestName} for ${signed.manifest.version} on ${signed.manifest.channel}`)
    return 0
  } catch (error) {
    console.error(error instanceof SigningRefusal ? error.message : `sign-release: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
