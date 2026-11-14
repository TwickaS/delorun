/**
 * Signs timestamp metadata with the online timestamp key (contract C2, timestamp metadata), in the release workflow's
 * protected environment: every 24 hours, and when a release is published.
 *
 * `node_modules/.bin/tsx delorun/apps/release/src/sign-timestamp.ts --state <state.json> --root <root file>... [--first]
 * --stable <manifest file> --beta <manifest file> [--replaced <manifest file>]... --out <timestamp.json>
 * [--release-branch <revision>]`
 *
 * `node_modules/.bin/tsx delorun/apps/release/src/sign-timestamp.ts --init-state --root <root file> --state <state.json>`
 *
 * `--state` is the signer's state (`delorun.release-timestamp-state/1`): the root it trusts and the last timestamp it
 * signed, with its version, SHA-256 and bytes, which the next signing continues from. It lives where the release
 * workflow's protected environment keeps it, never on the metadata host; the package README states where.
 * `--init-state` writes it once, in the owner's ceremony, from the first root, and refuses to overwrite a file.
 * `--root` starts at the state's root and repeats for each later version, newest last. `--first` signs without a
 * previous timestamp, only while the state records none. `--replaced` passes the manifest a channel names when a
 * re-signed manifest of the same release replaces it after a targets-key rotation. The private key is read from the
 * environment variable `DELORUN_TIMESTAMP_KEY` as PKCS #8 PEM, the workflow environment's secret; it is never a file or
 * an argument. It must be a production key: the command refuses a key that `delorun/release/production-keys.json`, as
 * `--release-branch` (`origin/v5` by default) of the repository it runs in commits it, does not list, so an empty
 * registry stops every signing. The command writes the new state and then the timestamp, each through a temporary file renamed into
 * place, so no timestamp exists that the state does not record.
 *
 * @module @delorun/release/sign-timestamp
 */
import { createPrivateKey } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { repositoryRoot } from '@delorun/tools/src/git.ts'
import { publicKeyEntry, signEnvelope } from '@delorun/release-formats/sign/envelope'
import { toJsonValue } from '@delorun/release-formats/sign/json'
import { productionKeyProblem, DEFAULT_RELEASE_BRANCH } from './sign/source.ts'
import { initialState, nextTimestamp, readTimestampState, stateAfter, type ManifestFile } from './sign/timestamp.ts'
import { trustRootChain, verifyTimestamp } from '@delorun/release-formats/sign/verify'

function manifestFile(path: string): ManifestFile {
  return { name: basename(path), bytes: readFileSync(resolve(path)) }
}

function replaceFile(path: string, bytes: Uint8Array | string): void {
  writeFileSync(`${path}.signing`, bytes, { flag: 'wx', mode: 0o644 })
  renameSync(`${path}.signing`, path)
}

async function main(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    options: {
      'state': { type: 'string' },
      'init-state': { type: 'boolean' },
      'root': { type: 'string', multiple: true },
      'first': { type: 'boolean' },
      'stable': { type: 'string' },
      'beta': { type: 'string' },
      'replaced': { type: 'string', multiple: true },
      'out': { type: 'string' },
      'release-branch': { type: 'string', default: DEFAULT_RELEASE_BRANCH },
    },
  })
  try {
    if (values.state === undefined || values.root === undefined) throw new Error('pass --state <file> and --root <file>')
    const now = Math.floor(Date.now() / 1000)
    const statePath = resolve(values.state)
    const roots = trustRootChain(values.root.map(path => readFileSync(resolve(path))), now)
    if (values['init-state'] === true) {
      if (roots.length !== 1) throw new Error('--init-state takes the one root the state starts from')
      if (existsSync(statePath)) throw new Error(`${statePath} exists; the state is written once`)
      writeFileSync(statePath, `${JSON.stringify(initialState(roots[0]!), undefined, 2)}\n`, { flag: 'wx', mode: 0o644 })
      console.log(`sign-timestamp: wrote the state for root ${String(roots[0]!.metadata.version)} to ${statePath}`)
      return 0
    }
    if (values.stable === undefined || values.beta === undefined || values.out === undefined) throw new Error('pass --stable <manifest>, --beta <manifest> and --out <file>')
    const pem = process.env.DELORUN_TIMESTAMP_KEY
    if (pem === undefined || pem === '') throw new Error('DELORUN_TIMESTAMP_KEY holds no key')
    const key = createPrivateKey(pem)
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('DELORUN_TIMESTAMP_KEY is not an Ed25519 key')
    const unlisted = await productionKeyProblem(repositoryRoot(process.cwd()), values['release-branch'], publicKeyEntry(key).keyid, 'timestamp')
    if (unlisted !== undefined) throw new Error(unlisted)
    const content = nextTimestamp({
      state: readTimestampState(readFileSync(statePath)),
      roots,
      first: values.first === true,
      manifests: { stable: manifestFile(values.stable), beta: manifestFile(values.beta) },
      replaced: (values.replaced ?? []).map(manifestFile),
      now,
    })
    const bytes = Buffer.from(`${JSON.stringify(signEnvelope({ signed: toJsonValue(content), signatures: [] }, [key]), undefined, 2)}\n`)
    const newest = roots.at(-1)!
    verifyTimestamp(newest, bytes, now)
    replaceFile(statePath, `${JSON.stringify(stateAfter(newest, bytes, content.version), undefined, 2)}\n`)
    replaceFile(resolve(values.out), bytes)
    console.log(`sign-timestamp: version ${String(content.version)}, expires ${content.expires}`)
    return 0
  } catch (error) {
    console.error(`sign-timestamp: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
