/**
 * Signs root metadata in the owner's signing ceremony (contract C2, root metadata and key rotation), on the offline
 * machine that holds the root keys:
 *
 * `node_modules/.bin/tsx delo/apps/release/src/sign-root.ts --draft <root draft.json> --key <root.pem>...
 * [--previous <root/<n-1>.root.json>] --out <root/<n>.root.json>`
 *
 * The draft is the root's `signed` content as JSON. The command checks it against the schema and the 365-day
 * lifetime, signs it with every `--key`, and writes the file only when it verifies with its own root threshold and,
 * for a rotation, as the next version after `--previous` with that root's threshold too. It never creates a key.
 *
 * @module @delo/release/sign-root
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { RELEASE_FILE_SIZE_LIMITS } from '@delo/contract-release-manifest'
import { readSigningKey, signEnvelope } from './sign/envelope.ts'
import { parseStrictJson } from './sign/json.ts'
import { RootSchema } from './sign/schemas.ts'
import { trustRootChain } from './sign/verify.ts'

function main(argv: readonly string[]): number {
  const { values } = parseArgs({ args: [...argv], strict: true, options: { draft: { type: 'string' }, key: { type: 'string', multiple: true }, previous: { type: 'string' }, out: { type: 'string' } } })
  try {
    if (values.draft === undefined || values.key === undefined || values.out === undefined) throw new Error('pass --draft <file>, at least one --key <root.pem> and --out <file>')
    const draft = parseStrictJson(readFileSync(resolve(values.draft)), RELEASE_FILE_SIZE_LIMITS.root)
    const checked = RootSchema.safeParse(draft)
    if (!checked.success) throw new Error(`the draft is not root metadata: ${checked.error.message}`)
    const envelope = signEnvelope({ signed: draft, signatures: [] }, values.key.map(path => readSigningKey(resolve(path))))
    const bytes = Buffer.from(`${JSON.stringify(envelope, undefined, 2)}\n`)
    const chain = values.previous === undefined ? [bytes] : [readFileSync(resolve(values.previous)), bytes]
    const root = trustRootChain(chain, Math.floor(Date.now() / 1000)).at(-1)!
    writeFileSync(resolve(values.out), bytes, { flag: 'wx', mode: 0o644 })
    console.log(`sign-root: wrote root version ${String(root.metadata.version)} to ${values.out}`)
    return 0
  } catch (error) {
    console.error(`sign-root: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
