/**
 * Asks the release log, before a cut builds anything, which entry key types it accepts: for each type the root lists as
 * an `active` log-entry key, it submits one throwaway entry over
 * 64 random bytes, signed by a key generated for the probe and discarded after it, and reports whether the log accepted
 * it. No release key is read, so nothing the probe logs names Delorun or a key a client trusts.
 *
 * `tsx delorun/apps/release/scripts/probe-log.ts --root <root file> --log-submit <url>`
 *
 * Each accepted entry is a real, permanent entry in the log it is sent to. Exit 0 when the log accepts at least one
 * listed type, 1 when it accepts none, 2 on a usage error, a root that does not verify by its own signatures, or a
 * root that lists no active log-entry key of a type this tool implements.
 *
 * @module probe-log
 */
import { generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { RELEASE_LOG_REQUEST_TIMEOUT_SECONDS, type LogEntryKeyDetails } from '@delorun/contract-release-log'
import type { RootMetadata } from '@delorun/contract-release-manifest'
import { entryRequest } from '@delorun/release-formats/log/entry'
import { isLogEntryKeyDetails } from '@delorun/release-formats/log/entry-keys'
import { readRoot } from '@delorun/release-formats/sign/verify'

/** What the log answered for one entry key type. */
export interface ProbeResult {
  /** The entry key type. */
  readonly keyDetails: LogEntryKeyDetails
  /** Whether the log accepted the entry. */
  readonly accepted: boolean
  /** The log's answer: the status and, for a refusal, the body's first line; or why it could not be asked. */
  readonly answer: string
}

/** The fetch the probe posts through. */
export type ProbeFetch = (url: string, init: RequestInit) => Promise<Response>

/**
 * The entry key types to probe for a root: the types of its listed `active` log-entry keys this tool implements, each
 * once in the root's order.
 * @param root - the root.
 * @returns the types; none for a root without `logEntryKeys`.
 */
export function probedTypes(root: Pick<RootMetadata, 'logEntryKeys'>): readonly LogEntryKeyDetails[] {
  const types: LogEntryKeyDetails[] = []
  for (const key of root.logEntryKeys ?? []) {
    if (key.status === 'active' && isLogEntryKeyDetails(key.keyDetails) && !types.includes(key.keyDetails)) types.push(key.keyDetails)
  }
  return types
}

/**
 * A throwaway private key of a type's kind.
 * @param keyDetails - the entry key type.
 * @returns a new key, held only in memory.
 */
function throwawayKey(keyDetails: LogEntryKeyDetails): KeyObject {
  return keyDetails === 'PKIX_ED25519_PH' ? generateKeyPairSync('ed25519').privateKey : generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
}

/**
 * Submit one throwaway entry per type.
 * @param types - the entry key types.
 * @param submit - the log's `/api/v2/log/entries`.
 * @param fetch - the fetch to post through.
 * @returns one result per type, in order.
 */
export async function probeLog(types: readonly LogEntryKeyDetails[], submit: string, fetch: ProbeFetch): Promise<readonly ProbeResult[]> {
  const results: ProbeResult[] = []
  for (const keyDetails of types) {
    const request = entryRequest(randomBytes(64), throwawayKey(keyDetails), keyDetails)
    try {
      const response = await fetch(submit, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(RELEASE_LOG_REQUEST_TIMEOUT_SECONDS * 1000) })
      const body = (await response.text()).split('\n')[0]!.slice(0, 200)
      results.push({ keyDetails, accepted: response.ok, answer: response.ok ? `HTTP ${String(response.status)}` : `HTTP ${String(response.status)} ${body}` })
    } catch (error) {
      results.push({ keyDetails, accepted: false, answer: `no answer: ${error instanceof Error ? error.message : String(error)}` })
    }
  }
  return results
}

/**
 * Run the probe.
 * @param argv - the arguments.
 * @param fetch - the fetch to post through.
 * @param say - prints one line.
 * @returns the exit code.
 */
export async function main(argv: readonly string[], fetch: ProbeFetch = globalThis.fetch, say: (line: string) => void = console.log): Promise<number> {
  let root: RootMetadata
  let submit: string
  try {
    const { values } = parseArgs({ args: [...argv], options: { 'root': { type: 'string' }, 'log-submit': { type: 'string' } } })
    if (values.root === undefined || values['log-submit'] === undefined) throw new Error('pass --root <root file> and --log-submit <url>')
    root = readRoot(readFileSync(resolve(values.root))).metadata
    submit = values['log-submit']
  } catch (error) {
    say(`probe-log: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  const types = probedTypes(root)
  if (types.length === 0) {
    say(`probe-log: root ${String(root.version)} lists no active log-entry key of a type this tool implements, so no release can be logged under it`)
    return 2
  }
  const results = await probeLog(types, submit, fetch)
  for (const result of results) say(`probe-log: ${result.keyDetails} ${result.accepted ? 'accepted' : 'refused'} (${result.answer})`)
  const accepted = results.filter(result => result.accepted).map(result => result.keyDetails)
  say(accepted.length === 0
    ? `probe-log: ${submit} accepts none of the entry key types root ${String(root.version)} lists (${types.join(', ')}); a release cannot be logged there`
    : `probe-log: ${submit} accepts ${accepted.join(', ')}`)
  return accepted.length === 0 ? 1 : 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
