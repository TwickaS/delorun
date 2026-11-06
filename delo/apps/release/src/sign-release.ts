/**
 * The signing command of contract C2, run by the targets-key holder on their own machine, outside CI:
 *
 * `node_modules/.bin/tsx delo/apps/release/src/sign-release.ts --release <dir> --rebuild <dir> --key <targets.pem>`
 *
 * `--release` holds the release workflow's files with its `manifest-draft.json` and the holder's rebuild record;
 * `--rebuild` is the holder's own rebuild output on this machine. The command refuses, naming the required source,
 * without a rebuild record, with a record that does not report a match or says it was made in CI, when `CI` or
 * `GITHUB_ACTIONS` is set, when the rebuild output does not reproduce the record's digests, when the record's commit
 * is not the tag's, or when comparing the workflow's output with the rebuild again finds a difference. Otherwise it
 * signs each runtime file list in place and writes `delorun-<version>.manifest.json`. The key is a PKCS #8 PEM file
 * with an Ed25519 private key and mode 0600; the guide in the package README states how the holder makes one.
 *
 * @module @delo/release/sign-release
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { repositoryRoot } from '@delo/tools/src/git.ts'
import { readRecipe } from './closure/config.ts'
import { readSigningKey } from './sign/envelope.ts'
import { signRelease, SigningRefusal } from './sign/release.ts'

async function main(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({ args: [...argv], strict: true, options: { release: { type: 'string' }, rebuild: { type: 'string' }, key: { type: 'string' } } })
  if (values.release === undefined || values.rebuild === undefined || values.key === undefined) {
    console.error('sign-release: pass --release <dir>, --rebuild <dir> and --key <targets.pem>')
    return 2
  }
  try {
    const signed = await signRelease({
      repository: repositoryRoot(process.cwd()),
      release: resolve(values.release),
      rebuild: resolve(values.rebuild),
      key: readSigningKey(resolve(values.key)),
      recipe: readRecipe(),
      env: process.env,
      now: new Date(),
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
