/**
 * The rebuild attestation: an HMAC-SHA256 over the version, commit and output digests of a `build-closure.ts` run,
 * keyed with a secret that exists only on the targets-key holder's machine. Signing checks it, so a rebuild directory
 * that this machine's build did not write, such as a downloaded copy of the release workflow's output, is refused.
 * It cannot stop a holder who sets out to cheat: they hold the key and can attest any directory. Contract C2 already
 * states that a rebuild's independence cannot be proven.
 *
 * @module @delorun/release/rebuild/attestation
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import type { FileRef } from '@delorun/contract-release-manifest'
import { z } from 'zod'
import { sha256Hex } from '@delorun/release-formats/brands'
import { canonicalJson, parseStrictJson, toJsonValue } from '@delorun/release-formats/sign/json'

/** The attestation file's schema id. */
export const ATTESTATION_SCHEMA = 'delorun.release-rebuild-attestation/1'

/** The fewest key bytes an attestation key holds. */
const MIN_KEY_BYTES = 32

const AttestationSchema = z.strictObject({
  schema: z.literal(ATTESTATION_SCHEMA),
  version: z.string().min(1),
  commit: z.string().regex(/^[0-9a-f]{40}$/u),
  outputs: z.array(z.strictObject({ name: z.string().min(1), length: z.number().int().min(0), sha256: z.string().regex(/^[0-9a-f]{64}$/u).transform(value => sha256Hex(value)) })),
  hmac: z.string().regex(/^[0-9a-f]{64}$/u),
})

/** What an attestation covers. */
export interface AttestedBuild {
  /** The release version. */
  readonly version: string
  /** The commit built. */
  readonly commit: string
  /** Every output file, in byte-wise name order. */
  readonly outputs: readonly FileRef[]
}

/**
 * Read the holder's attestation key: a file only its owner can read, of at least 32 bytes.
 * @param path - the key file.
 * @returns the key bytes.
 * @throws Error when the file is readable or writable by its group or others, or is shorter than 32 bytes.
 */
export function readAttestationKey(path: string): Buffer {
  const mode = statSync(path).mode & 0o777
  if ((mode & 0o077) !== 0) throw new Error(`${path} has mode ${mode.toString(8).padStart(4, '0')}; the attestation key must be readable by its owner only (chmod 600)`)
  const key = readFileSync(path)
  if (key.byteLength < MIN_KEY_BYTES) throw new Error(`${path} holds ${String(key.byteLength)} bytes; the attestation key holds at least ${String(MIN_KEY_BYTES)}`)
  return key
}

function mac(key: Buffer, build: AttestedBuild): string {
  const covered = toJsonValue({ schema: ATTESTATION_SCHEMA, version: build.version, commit: build.commit, outputs: build.outputs })
  return createHmac('sha256', key).update(canonicalJson(covered)).digest('hex')
}

/**
 * The attestation file's text for a build.
 * @param key - the holder's attestation key.
 * @param build - the build.
 * @returns the JSON text.
 */
export function attestationText(key: Buffer, build: AttestedBuild): string {
  return `${JSON.stringify({ schema: ATTESTATION_SCHEMA, version: build.version, commit: build.commit, outputs: build.outputs, hmac: mac(key, build) }, undefined, 2)}\n`
}

/**
 * Check an attestation against the build signing found.
 * @param key - the holder's attestation key.
 * @param bytes - the attestation file.
 * @param build - the version, commit and outputs signing found.
 * @returns why the attestation fails, or `undefined` when it covers exactly that build under this key.
 */
export function attestationProblem(key: Buffer, bytes: Uint8Array, build: AttestedBuild): string | undefined {
  let parsed: z.output<typeof AttestationSchema>
  try {
    const result = AttestationSchema.safeParse(parseStrictJson(bytes, 1024 * 1024))
    if (!result.success) return `it is not a rebuild attestation: ${z.prettifyError(result.error).replaceAll('\n', '; ')}`
    parsed = result.data
  } catch (error) {
    return `it does not read: ${(error as Error).message}`
  }
  if (parsed.version !== build.version || parsed.commit !== build.commit) return `it attests ${parsed.version} at ${parsed.commit}, not ${build.version} at ${build.commit}`
  if (JSON.stringify(parsed.outputs) !== JSON.stringify(build.outputs)) return 'it attests other output files than the rebuild directory holds'
  const expected = Buffer.from(mac(key, build), 'hex')
  if (!timingSafeEqual(expected, Buffer.from(parsed.hmac, 'hex'))) return 'its HMAC does not verify with this machine\'s attestation key'
  return undefined
}

/**
 * Read an attestation whose HMAC verifies with the key, with the version, commit and outputs it covers.
 * @param key - the holder's attestation key.
 * @param bytes - the attestation file.
 * @returns the attested build.
 * @throws Error when the file does not read or its HMAC does not verify with the key.
 */
export function readAttestation(key: Buffer, bytes: Uint8Array): AttestedBuild {
  let parsed: z.output<typeof AttestationSchema>
  try {
    const result = AttestationSchema.safeParse(parseStrictJson(bytes, 1024 * 1024))
    if (!result.success) throw new Error(z.prettifyError(result.error).replaceAll('\n', '; '))
    parsed = result.data
  } catch (error) {
    throw new Error(`the attestation is not a rebuild attestation: ${(error as Error).message}`, { cause: error })
  }
  const build = { version: parsed.version, commit: parsed.commit, outputs: parsed.outputs }
  if (!timingSafeEqual(Buffer.from(mac(key, build), 'hex'), Buffer.from(parsed.hmac, 'hex'))) throw new Error('the attestation\'s HMAC does not verify with this machine\'s attestation key')
  return build
}

/**
 * Extend an attested build with the files a later step added or rewrote in the same output directory: every attested
 * file the step did not rewrite must be unchanged, every file present must be attested or added, and the commit and
 * version stay the attestation's.
 * @param prior - the attested build, as {@link readAttestation} returned it.
 * @param outputs - every file the directory now holds.
 * @param changed - the names the step may add or rewrite.
 * @returns the extended build.
 * @throws Error naming a file the step changed, added or removed outside `changed`.
 */
export function extendAttestation(prior: AttestedBuild, outputs: readonly FileRef[], changed: readonly string[]): AttestedBuild {
  const now = new Map(outputs.map(ref => [ref.name, ref]))
  for (const ref of prior.outputs) {
    if (changed.includes(ref.name)) continue
    const current = now.get(ref.name)
    if (current === undefined) throw new Error(`${ref.name}, which the attestation covers, is gone`)
    if (current.length !== ref.length || current.sha256 !== ref.sha256) throw new Error(`${ref.name} is not the file the attestation covers`)
  }
  const attested = new Set(prior.outputs.map(ref => ref.name))
  const unexpected = outputs.filter(ref => !attested.has(ref.name) && !changed.includes(ref.name))
  if (unexpected.length > 0) throw new Error(`${unexpected.map(ref => ref.name).join(', ')} is neither attested nor written by this step`)
  return { version: prior.version, commit: prior.commit, outputs }
}
