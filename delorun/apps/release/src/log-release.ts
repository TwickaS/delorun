/**
 * Logs a signed release manifest in the release log (contract C18), in the release workflow after the targets-key
 * holder has signed and before the release is published:
 *
 * `node_modules/.bin/tsx delorun/apps/release/src/log-release.ts --root <root file> --manifest <manifest file> --entry
 * <delorun-<version>.manifest.entry.json> --submit <url> --checkpoint <url> --tiles <url> --out <bundle file>`
 *
 * It submits the Rekor v2 entry request the signing command wrote, waits for a checkpoint that a witness the root lists has
 * cosigned and that covers the entry, and writes `delorun-<version>.manifest.log.json` only when the bundle verifies
 * with the root's log and witness keys. `--submit` is the log's `/api/v2/log/entries`, `--checkpoint` returns the
 * witnessed checkpoint as signed-note text, and `--tiles` is the prefix below which the log serves its tiles, from
 * which the command computes the entry's inclusion proof. It polls every 30 seconds, at most 60 times.
 *
 * @module @delorun/release/log-release
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { logRelease } from './log/client.ts'
import { readEntryRequest } from '@delorun/release-formats/log/entry'
import { readEnvelope } from '@delorun/release-formats/sign/schemas'
import { trustRootChain } from '@delorun/release-formats/sign/verify'

async function main(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({ args: [...argv], strict: true, options: { root: { type: 'string' }, manifest: { type: 'string' }, entry: { type: 'string' }, submit: { type: 'string' }, checkpoint: { type: 'string' }, tiles: { type: 'string' }, out: { type: 'string' } } })
  try {
    const { root: rootPath, manifest: manifestPath, entry, submit, checkpoint, tiles, out } = values
    if (rootPath === undefined || manifestPath === undefined || entry === undefined || submit === undefined || checkpoint === undefined || tiles === undefined || out === undefined) {
      throw new Error('pass --root, --manifest, --entry, --submit, --checkpoint, --tiles and --out')
    }
    const root = trustRootChain([readFileSync(resolve(rootPath))], Math.floor(Date.now() / 1000)).at(-1)!.metadata
    const manifest = readFileSync(resolve(manifestPath))
    const version = readEnvelope('manifest', manifest).signed.version
    const bundle = await logRelease({ submit, checkpoint, tiles }, root, basename(manifestPath), manifest, version, readEntryRequest(readFileSync(resolve(entry))), 60, () => delay(30_000))
    writeFileSync(resolve(out), `${JSON.stringify(bundle, undefined, 2)}\n`, { flag: 'wx', mode: 0o644 })
    console.log(`log-release: ${basename(manifestPath)} is entry ${String(bundle.entry.logIndex)}, witnessed at tree size ${String(bundle.inclusion.treeSize)}`)
    return 0
  } catch (error) {
    console.error(`log-release: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
