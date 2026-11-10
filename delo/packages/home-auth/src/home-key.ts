/**
 * The home key (contract C5, "Keys and storage"): an Ed25519 key in `~/.delo/secrets/home-auth/home-key.pem`, PKCS #8,
 * mode 0600, generated at the home's first start and kept across resets. Its 32-byte raw public key is what an approval
 * request's answer carries and what the match code commits to, and the SHA-256 of that raw key is the home key id.
 *
 * @module @delo/home-auth/home-key
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { join } from 'node:path'
import { readProtectedFile, writeProtectedFile } from '@delo/home'
import { brandString } from '@deepseek-ai/dsh-brand'
import { HOME_AUTH_FILES, type Base64Url, type HomeKeyId } from '@delo/contract-device-approval'
import { HomeAuthError } from './errors.ts'

/** The DER prefix of an Ed25519 SubjectPublicKeyInfo, before the 32 raw key bytes. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

/** A loaded home key. */
export interface HomeKey {
  /** The 32-byte raw public key. */
  readonly publicKey: Uint8Array
  /** The raw public key as base64url, as an approval request's answer carries it. */
  readonly publicKeyText: Base64Url
  /** SHA-256 of the raw public key, base64url. */
  readonly id: HomeKeyId
}

/**
 * Load the home key, generating it when the file does not exist.
 * @param directory - the secrets directory.
 * @returns the key's public half.
 * @throws {HomeAuthError} `STORE_INVALID` when the file is refused by C1's protected-file check or is not an Ed25519
 *   private key.
 */
export async function loadHomeKey(directory: string): Promise<HomeKey> {
  const file = join(directory, HOME_AUTH_FILES.homeKey)
  let pem: string
  try {
    pem = Buffer.from(await readProtectedFile(file)).toString('utf8')
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw new HomeAuthError('STORE_INVALID', 'home-key.pem is not a protected file this home can read')
    }
    const generated = generateKeyPairSync('ed25519')
    pem = generated.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    await writeProtectedFile(file, pem)
  }
  let key: KeyObject
  try {
    key = createPrivateKey(pem)
  } catch {
    throw new HomeAuthError('STORE_INVALID', 'home-key.pem is not a private key')
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new HomeAuthError('STORE_INVALID', 'home-key.pem is not an Ed25519 key')
  const spki = createPublicKey(key).export({ type: 'spki', format: 'der' })
  const publicKey = new Uint8Array(spki.subarray(ED25519_SPKI_PREFIX.length))
  return {
    publicKey,
    publicKeyText: brandString<Base64Url>(Buffer.from(publicKey).toString('base64url')),
    id: brandString<HomeKeyId>(createHash('sha256').update(publicKey).digest('base64url')),
  }
}
