/**
 * The release workflow's side of contract C18: submit a signed manifest's `hashedrekord` entry to the log, wait until
 * a listed witness has cosigned a checkpoint at or above the entry's tree size, and assemble the release-log bundle,
 * which must verify before the release is published.
 *
 * @module @delo/release/log/client
 */
import { createHash } from 'node:crypto'
import { RELEASE_LOG_BUNDLE_SCHEMA, RELEASE_LOG_REQUEST_TIMEOUT_SECONDS, type ReleaseLogBundle } from '@delo/contract-release-log'
import type { RootMetadata } from '@delo/contract-release-manifest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'
import { LogVerificationError, verifyBundle } from './bundle.ts'

/** Where the log and the witnessed checkpoints are. */
export interface LogEndpoints {
  /** The log's entry submission URL. */
  readonly submit: string
  /** The URL that returns the latest checkpoint with witness cosignatures. */
  readonly checkpoint: string
  /** The URL that returns an entry's inclusion proof for a tree size, with `{index}` and `{size}` placeholders. */
  readonly proof: string
}

const Submitted = z.looseObject({ logIndex: z.number().int().min(0), integratedTime: z.number().int().min(0), body: z.string() })
const Proof = z.looseObject({ hashes: z.array(z.string().regex(/^[0-9a-f]{64}$/u)), rootHash: z.string().regex(/^[0-9a-f]{64}$/u) })

async function request(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(RELEASE_LOG_REQUEST_TIMEOUT_SECONDS * 1000) })
  if (!response.ok) throw new Error(`${url} answered HTTP ${String(response.status)}`)
  const body: unknown = await response.json()
  return body
}

/**
 * Log a manifest and assemble its verified bundle.
 * @param endpoints - the log's and the distributor's URLs.
 * @param root - the trusted root, whose log and witness keys the bundle must verify with.
 * @param manifestName - the manifest file's name.
 * @param manifest - the manifest file's bytes.
 * @param version - the release version.
 * @param entryBody - the `hashedrekord` body to submit.
 * @param attempts - how many times to ask for a witnessed checkpoint that covers the entry.
 * @param wait - waits between attempts.
 * @returns the bundle, verified offline.
 * @throws Error when the log refuses the entry, no checkpoint a listed witness cosigned covers it in time, or the bundle
 * fails any other step.
 */
export async function logRelease(endpoints: LogEndpoints, root: RootMetadata, manifestName: string, manifest: Uint8Array, version: string, entryBody: Uint8Array, attempts: number, wait: () => Promise<void>): Promise<ReleaseLogBundle> {
  const entry = Submitted.parse(await request(endpoints.submit, { method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.from(entryBody) }))
  for (let attempt = 0; attempt < attempts; attempt++) {
    const checkpoint = z.string().parse(await request(endpoints.checkpoint))
    const size = Number(checkpoint.split('\n')[1])
    if (Number.isSafeInteger(size) && size > entry.logIndex) {
      const proof = Proof.parse(await request(endpoints.proof.replace('{index}', String(entry.logIndex)).replace('{size}', String(size))))
      const bundle: ReleaseLogBundle = {
        schema: RELEASE_LOG_BUNDLE_SCHEMA,
        manifest: { name: manifestName, sha256: brandString<ReleaseLogBundle['manifest']['sha256']>(createHash('sha256').update(manifest).digest('hex')) },
        entry,
        inclusion: { logIndex: entry.logIndex, treeSize: size, rootHash: proof.rootHash, hashes: proof.hashes },
        checkpoint,
      }
      try {
        verifyBundle(root, manifest, version, bundle)
        return bundle
      } catch (error) {
        if (!(error instanceof LogVerificationError && error.failure === 'witness-cosignature-missing')) throw error
      }
    }
    await wait()
  }
  throw new Error(`no checkpoint cosigned by a listed witness covered log index ${String(entry.logIndex)} after ${String(attempts)} attempts; the release is not published`)
}
