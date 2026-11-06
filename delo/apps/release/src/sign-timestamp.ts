/**
 * Signs timestamp metadata with the online timestamp key (contract C2, timestamp metadata), in the release workflow's
 * protected environment: every 24 hours, and when a release is published.
 *
 * `node_modules/.bin/tsx delo/apps/release/src/sign-timestamp.ts --root <newest root file> [--previous
 * <timestamp.json>] [--manifest <delorun-<version>.manifest.json> --channel <stable|beta>] --out <timestamp.json>`
 *
 * The private key is read from the environment variable `DELO_TIMESTAMP_KEY` as PKCS #8 PEM, the workflow
 * environment's secret; it is never a file or an argument. A channel moves only to a manifest that verifies with the
 * root's targets keys, the version is one above `--previous`, and the file expires 3 days after it is issued.
 *
 * @module @delo/release/sign-timestamp
 */
import { createPrivateKey } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { RELEASE_CHANNELS } from '@delo/contract-release-manifest'
import { signEnvelope } from './sign/envelope.ts'
import { toJsonValue } from './sign/json.ts'
import { readEnvelope } from './sign/schemas.ts'
import { nextTimestamp, type ChannelRelease } from './sign/timestamp.ts'
import { readTrustedRoot, verifyTimestamp } from './sign/verify.ts'

function main(argv: readonly string[]): number {
  const { values } = parseArgs({ args: [...argv], strict: true, options: { root: { type: 'string' }, previous: { type: 'string' }, manifest: { type: 'string' }, channel: { type: 'string' }, out: { type: 'string' } } })
  try {
    if (values.root === undefined || values.out === undefined) throw new Error('pass --root <file> and --out <file>')
    const pem = process.env.DELO_TIMESTAMP_KEY
    if (pem === undefined || pem === '') throw new Error('DELO_TIMESTAMP_KEY holds no key')
    const key = createPrivateKey(pem)
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('DELO_TIMESTAMP_KEY is not an Ed25519 key')
    const rootBytes = readFileSync(resolve(values.root))
    const root = readTrustedRoot(rootBytes)
    const now = Math.floor(Date.now() / 1000)
    const previous = values.previous === undefined ? undefined : readEnvelope('timestamp', readFileSync(resolve(values.previous))).signed
    if ((values.manifest === undefined) !== (values.channel === undefined)) throw new Error('pass --manifest and --channel together')
    let release: ChannelRelease | undefined
    if (values.manifest !== undefined && values.channel !== undefined) {
      const channel = RELEASE_CHANNELS.find(candidate => candidate === values.channel)
      if (channel === undefined) throw new Error('--channel is stable or beta')
      release = { channel, name: basename(values.manifest), bytes: readFileSync(resolve(values.manifest)) }
    }
    const content = nextTimestamp({ metadata: root, bytes: rootBytes }, previous, release, now)
    const bytes = Buffer.from(`${JSON.stringify(signEnvelope({ signed: toJsonValue(content), signatures: [] }, [key]), undefined, 2)}\n`)
    verifyTimestamp(root, bytes, now)
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
