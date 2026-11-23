/**
 * Logs a signed release manifest in the release log (contract C18), in the release workflow after the targets-key
 * holder has signed and before the release is published:
 *
 * `node_modules/.bin/tsx delorun/apps/release/src/log-release.ts --root <root file> --manifest <manifest file> --entry
 * <delorun-<version>.manifest.entry.json> [--entry <delorun-<version>.manifest.entry.<n>.json>]... --submit <url>
 * --checkpoint <url> --tiles <url> --out <bundle file>`
 * [`--kind packs`, with the packs file as `--manifest` and its `delorun-<version>.packs.entry[.<n>].json` files as
 * `--entry`, logs the release's packs file as its own record]
 *
 * It submits the Rekor v2 entry requests the signing command wrote, one per log-entry key, in the order given (the
 * order the signing command numbered them, which is the root's): it verifies each request under the root before
 * submitting it, moves to the next only when the log refuses the entry's key type with one of the two refusal answers
 * of `log/client.ts`, and stops at any other answer. It waits for a checkpoint that a witness the root lists has
 * cosigned and that covers the accepted entry, and writes `delorun-<version>.manifest.log.json` only when the bundle
 * verifies with the root's log and witness keys; when the log accepted a later request, it rewrites the first `--entry`
 * file with that request, so the file names the entry the log holds. It holds no key. `--submit` is the log's `/api/v2/log/entries`, `--checkpoint` returns the
 * witnessed checkpoint as signed-note text, and `--tiles` is the prefix below which the log serves its tiles, from
 * which the command computes the entry's inclusion proof. It polls every 30 seconds, at most 60 times.
 *
 * @module @delorun/release/log-release
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { logFirstAccepted } from './log/client.ts'
import { readEntryRequest } from '@delorun/release-formats/log/entry'
import { readEnvelope } from '@delorun/release-formats/sign/schemas'
import { trustRootChain } from '@delorun/release-formats/sign/verify'

/**
 * The kind of signed document being logged.
 * @param kind - `--kind`'s value, or `undefined` for the manifest.
 * @returns `manifest` or `packs`.
 * @throws Error when the value is neither.
 */
export function logKind(kind: string | undefined): 'manifest' | 'packs' {
  if (kind === undefined || kind === 'manifest') return 'manifest'
  if (kind === 'packs') return 'packs'
  throw new Error(`--kind is ${JSON.stringify(kind)}; use manifest or packs`)
}

/**
 * Run the command.
 * @param argv - the arguments after the script.
 * @returns the exit code: 0 when the bundle verified and was written, 1 otherwise.
 */
export async function main(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({ args: [...argv], strict: true, options: { root: { type: 'string' }, manifest: { type: 'string' }, entry: { type: 'string', multiple: true }, submit: { type: 'string' }, checkpoint: { type: 'string' }, tiles: { type: 'string' }, out: { type: 'string' }, kind: { type: 'string' } } })
  try {
    const { root: rootPath, manifest: manifestPath, entry, submit, checkpoint, tiles, out } = values
    if (rootPath === undefined || manifestPath === undefined || entry === undefined || submit === undefined || checkpoint === undefined || tiles === undefined || out === undefined) {
      throw new Error('pass --root, --manifest, --entry, --submit, --checkpoint, --tiles and --out')
    }
    const root = trustRootChain([readFileSync(resolve(rootPath))], Math.floor(Date.now() / 1000)).at(-1)!.metadata
    const manifest = readFileSync(resolve(manifestPath))
    const kind = logKind(values.kind)
    const version = (kind === 'packs' ? readEnvelope('packs', manifest) : readEnvelope('manifest', manifest)).signed.version
    const requests = entry.map(path => readEntryRequest(readFileSync(resolve(path))))
    const logged = await logFirstAccepted({ submit, checkpoint, tiles }, root, basename(manifestPath), manifest, version, requests, 60, () => delay(30_000), kind, line => console.warn(`log-release: ${line}`))
    const { bundle } = logged
    writeFileSync(resolve(out), `${JSON.stringify(bundle, undefined, 2)}\n`, { flag: 'wx', mode: 0o644 })
    if (logged.signer > 0) {
      const first = resolve(entry[0]!)
      writeFileSync(`${first}.tmp`, `${JSON.stringify(logged.entry, undefined, 2)}\n`, { flag: 'wx', mode: 0o644 })
      renameSync(`${first}.tmp`, first)
    }
    console.log(`log-release: ${basename(manifestPath)} is entry ${String(bundle.entry.logIndex)} (${logged.entry.hashedRekordRequestV002.signature.verifier.keyDetails}, request ${String(logged.signer + 1)}), witnessed at tree size ${String(bundle.inclusion.treeSize)}`)
    return 0
  } catch (error) {
    console.error(`log-release: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
