/**
 * The release log entry of contract C18: a Rekor v2 `hashedrekord` v0.0.2 whose signature is a log-entry key's
 * signature over the signed file's bytes, with the digest the entry key type carries and the public key in DER: ECDSA
 * P-256 with SHA-256, or Ed25519ph (RFC 8032, empty context) with SHA-512, by a key the trusted root lists in
 * `logEntryKeys` ({@link module:@delorun/release-formats/log/entry-keys}); a root without the list trusts no entry. The
 * signing machine writes the request; Rekor v2 builds the entry body from it, and the log's leaf is the body's RFC 8785
 * serialization. Node's crypto has no Ed25519ph, so Ed25519ph signing and verifying use `@noble/curves`.
 *
 * @module @delorun/release-formats/log/entry
 */
import { createPublicKey, type KeyObject } from 'node:crypto'
import { RELEASE_LOG_ENTRY_API_VERSION, RELEASE_LOG_ENTRY_KEY_DETAILS, RELEASE_LOG_ENTRY_TYPE, type HashedRekordBody, type HashedRekordRequest, type LogEntryKeyDetails } from '@delorun/contract-release-log'
import { ed25519ph } from '@noble/curves/ed25519.js'
import { z } from 'zod'
import { entryDigest, entryDigestAlgorithm, isLogEntryKeyDetails, signLogEntry } from './entry-keys.ts'
import { rawPublicKey } from '../sign/envelope.ts'
import { canonicalJson, parseStrictJson, toJsonValue } from '../sign/json.ts'

const base64 = z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u)

/** The fields of a Rekor v2 `Signature` message; `keyDetails` is any string, so a caller can name the refusal. */
const Signature = z.strictObject({
  content: base64,
  verifier: z.strictObject({ publicKey: z.strictObject({ rawBytes: base64 }), keyDetails: z.string() }),
})

/** The entry body as Rekor v2 serializes a `hashedrekord` v0.0.2; unknown fields fail it. */
export const EntryBodySchema = z.strictObject({
  apiVersion: z.literal(RELEASE_LOG_ENTRY_API_VERSION),
  kind: z.literal(RELEASE_LOG_ENTRY_TYPE),
  spec: z.strictObject({ hashedRekordV002: z.strictObject({ data: z.strictObject({ algorithm: z.string(), digest: base64 }), signature: Signature }) }),
})

/** A request file's size limit before parsing. */
const ENTRY_REQUEST_SIZE_LIMIT = 16 * 1024

/** A request file's JSON fields; unknown fields fail it. */
const RequestSchema = z.strictObject({ hashedRekordRequestV002: z.strictObject({ digest: base64, signature: Signature }) })

/** An entry body that parsed, whose algorithm and key details the verifier still checks. */
export type ParsedEntryBody = z.infer<typeof EntryBodySchema>

/**
 * Sign bytes with Ed25519ph and an empty context.
 * @param key - an Ed25519 private key.
 * @param message - the bytes; Ed25519ph signs their SHA-512.
 * @returns the 64-byte signature.
 */
export function signEd25519ph(key: KeyObject, message: Uint8Array): Buffer {
  const seed = key.export({ format: 'jwk' }).d
  if (seed === undefined) throw new Error('Ed25519ph signing needs a private key')
  return Buffer.from(ed25519ph.sign(message, Buffer.from(seed, 'base64url')))
}

/**
 * Verify an Ed25519ph signature with an empty context as RFC 8032 does, with canonical encodings and the cofactorless
 * equation (not ZIP-215), as the envelope verifier's Ed25519 does.
 * @param key - an Ed25519 public key.
 * @param message - the signed bytes.
 * @param signature - the signature.
 * @returns whether it verifies; a signature of the wrong length or encoding does not.
 */
export function verifyEd25519ph(key: KeyObject, message: Uint8Array, signature: Uint8Array): boolean {
  try {
    return ed25519ph.verify(signature, message, rawPublicKey(key), { zip215: false })
  } catch (error) {
    // noble refuses a signature of the wrong length by throwing; such a signature does not verify.
    return error instanceof Error ? false : false
  }
}

/**
 * The request the release workflow submits for a signed file.
 * @param manifest - the signed file's bytes.
 * @param key - the log-entry private key; the targets key under a root without `logEntryKeys`.
 * @param keyDetails - the entry key type the key signs under; Ed25519ph by default.
 * @returns the request, as `delorun-<version>.manifest.entry.json` holds it.
 * @throws Error when the key is not a private key of the type's kind.
 */
export function entryRequest(manifest: Uint8Array, key: KeyObject, keyDetails: LogEntryKeyDetails = RELEASE_LOG_ENTRY_KEY_DETAILS): HashedRekordRequest {
  return {
    hashedRekordRequestV002: {
      digest: entryDigest(keyDetails, manifest),
      signature: {
        content: signLogEntry(keyDetails, key, manifest).toString('base64'),
        verifier: { publicKey: { rawBytes: createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64') }, keyDetails },
      },
    },
  }
}

/**
 * Read a request file.
 * @param bytes - the file's bytes.
 * @returns the request.
 * @throws Error when it exceeds 16 KiB, is not strict JSON, has other fields or names an entry key type this client
 *   does not implement.
 */
export function readEntryRequest(bytes: Uint8Array): HashedRekordRequest {
  const parsed = RequestSchema.safeParse(parseStrictJson(bytes, ENTRY_REQUEST_SIZE_LIMIT))
  if (!parsed.success) throw new Error(`log entry request: ${z.prettifyError(parsed.error).replaceAll('\n', '; ')}`)
  const { digest, signature } = parsed.data.hashedRekordRequestV002
  const keyDetails = signature.verifier.keyDetails
  if (!isLogEntryKeyDetails(keyDetails)) throw new Error(`log entry request: key details ${keyDetails} are not an entry key type this client implements`)
  return { hashedRekordRequestV002: { digest, signature: { content: signature.content, verifier: { publicKey: signature.verifier.publicKey, keyDetails } } } }
}

/**
 * The entry body Rekor v2 builds from a request, in the RFC 8785 serialization that is the log's leaf.
 * @param request - the request.
 * @returns the body's bytes.
 */
export function entryBody(request: HashedRekordRequest): Buffer {
  const { digest, signature } = request.hashedRekordRequestV002
  const algorithm = entryDigestAlgorithm(signature.verifier.keyDetails)
  const body: HashedRekordBody = { apiVersion: RELEASE_LOG_ENTRY_API_VERSION, kind: RELEASE_LOG_ENTRY_TYPE, spec: { hashedRekordV002: { data: { algorithm, digest }, signature } } }
  return Buffer.from(canonicalJson(toJsonValue(body)))
}
