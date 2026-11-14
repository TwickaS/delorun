/**
 * Checked constructors of contract C2's branded values. Each validates its input, so a branded value in the release
 * tooling always has the form its brand names.
 *
 * @module @delorun/release-formats/brands
 */
import type { SemanticVersion, Sha256Hex } from '@delorun/contract-release-manifest'
import { brandString } from '@deepseek-ai/dsh-brand'

const SHA256 = /^[0-9a-f]{64}$/u

/** SemVer 2.0 without build metadata, as contract C1 names runtime versions. */
const SEMANTIC_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/u

/**
 * A SHA-256 digest.
 * @param value - lowercase hex.
 * @returns the branded digest.
 * @throws Error when the value is not 64 lowercase hex digits.
 */
export function sha256Hex(value: string): Sha256Hex {
  if (!SHA256.test(value)) throw new Error(`${JSON.stringify(value)} is not a lowercase hex SHA-256`)
  return brandString<Sha256Hex>(value)
}

/**
 * A release version.
 * @param value - the version without a leading `v`.
 * @returns the branded version.
 * @throws Error when the value is not a semantic version of at most 64 characters.
 */
export function semanticVersion(value: string): SemanticVersion {
  if (value.length > 64 || !SEMANTIC_VERSION.test(value)) throw new Error(`${JSON.stringify(value)} is not a release version`)
  return brandString<SemanticVersion>(value)
}
