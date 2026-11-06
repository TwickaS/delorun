/**
 * Signs timestamp metadata with the online timestamp key (contract C2, timestamp metadata), in the release workflow's
 * protected environment: every 24 hours, and when a release is published.
 *
 * `node_modules/.bin/tsx delo/apps/release/src/sign-timestamp.ts --root <root file>... [--previous <timestamp.json>]
 * --stable <manifest file> --beta <manifest file> --out <timestamp.json>`
 *
 * `--root` repeats for a root rotation since the previous timestamp: the root the previous timestamp names first,
 * then each later version, the newest last. The private key is read from the environment variable
 * `DELO_TIMESTAMP_KEY` as PKCS #8 PEM, the workflow environment's secret; it is never a file or an argument. The
 * previous timestamp must verify with the root it names, each channel's manifest must verify with the newest root's
 * targets keys, no channel moves to a lower version, the version is one above the previous one, and the file
 * expires 3 days after it is issued.
 *
 * @module @delo/release/sign-timestamp
 */
import { createPrivateKey } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { signEnvelope } from './sign/envelope.ts'
import { toJsonValue } from './sign/json.ts'
import { nextTimestamp, type ManifestFile } from './sign/timestamp.ts'
import { trustRootChain, verifyTimestamp } from './sign/verify.ts'

function manifestFile(path: string): ManifestFile {
  return { name: basename(path), bytes: readFileSync(resolve(path)) }
}

function main(argv: readonly string[]): number {
  const { values } = parseArgs({ args: [...argv], strict: true, options: { root: { type: 'string', multiple: true }, previous: { type: 'string' }, stable: { type: 'string' }, beta: { type: 'string' }, out: { type: 'string' } } })
  try {
    if (values.root === undefined || values.stable === undefined || values.beta === undefined || values.out === undefined) {
      throw new Error('pass --root <file>, --stable <manifest>, --beta <manifest> and --out <file>')
    }
    const pem = process.env.DELO_TIMESTAMP_KEY
    if (pem === undefined || pem === '') throw new Error('DELO_TIMESTAMP_KEY holds no key')
    const key = createPrivateKey(pem)
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('DELO_TIMESTAMP_KEY is not an Ed25519 key')
    const now = Math.floor(Date.now() / 1000)
    const roots = trustRootChain(values.root.map(path => readFileSync(resolve(path))), now)
    const previous = values.previous === undefined ? undefined : readFileSync(resolve(values.previous))
    const content = nextTimestamp(roots, previous, { stable: manifestFile(values.stable), beta: manifestFile(values.beta) }, now)
    const bytes = Buffer.from(`${JSON.stringify(signEnvelope({ signed: toJsonValue(content), signatures: [] }, [key]), undefined, 2)}\n`)
    verifyTimestamp(roots.at(-1)!, bytes, now)
    writeFileSync(resolve(values.out), bytes, { mode: 0o644 })
    console.log(`sign-timestamp: version ${String(content.version)}, expires ${content.expires}`)
    return 0
  } catch (error) {
    console.error(`sign-timestamp: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
