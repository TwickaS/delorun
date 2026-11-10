/**
 * The home key an export signs with and an import trusts: the Ed25519 key of
 * contract C5 at `<home>/secrets/home-auth/home-key.pem`, PKCS #8, mode 0600
 * inside a 0700 directory. Its identifier is the SHA-256 of the raw 32-byte
 * public key, base64url. The key is read through C1's protected-file rules, so
 * a key file that is a symbolic link, another user's, or readable by others is
 * refused rather than used. A home without the key gets one on first use, by
 * an exclusive link of a fully written file, so two first uses at once never
 * replace each other's key.
 *
 * @module @delo/archive/home-key
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto'
import { constants } from 'node:fs'
import { link, mkdir, open, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { HOME_AUTH_FILES } from '@delo/contract-device-approval'
import { DELO_HOME_ENTRIES, PRIVATE_DIR_MODE, PROTECTED_FILE_MODE } from '@delo/contract-home-layout'
import { checkPrivateDirectory, readProtectedFile } from '@delo/home'
import { encodePublicKey, keyFingerprint } from './signature.ts'

/** The directory under the home's `secrets/` that holds the home key, as contract C5 names it. */
export const HOME_AUTH_DIRECTORY = 'home-auth'

/** The home's signing key, in the encodings an archive uses. */
export interface HomeKey {
  /** The home key id: the SHA-256 of the raw public key, base64url. */
  readonly keyId: string
  /** The base64url raw public key. */
  readonly publicKey: string
  /** The private key, which signs a manifest. */
  readonly privateKey: KeyObject
}

/**
 * The path of a home's key file.
 * @param home - the Delo home.
 * @returns `<home>/secrets/home-auth/home-key.pem`.
 */
export function homeKeyPath(home: string): string {
  return join(home, DELO_HOME_ENTRIES.secrets, HOME_AUTH_DIRECTORY, HOME_AUTH_FILES.homeKey)
}

/**
 * Read the home key, or create it when the home has none and `create` is set.
 * @param home - the Delo home.
 * @param options - `create` makes a key when the file does not exist.
 * @returns the key, or `undefined` when the home has none and `create` is not set.
 * @throws {HomeLayoutError} when the key file or its directory breaks C1's protected-path rules.
 * @throws Error when the file holds a key that is not Ed25519.
 */
export async function loadHomeKey(home: string, options: { readonly create?: boolean } = {}): Promise<HomeKey | undefined> {
  const path = homeKeyPath(home)
  const directory = join(home, DELO_HOME_ENTRIES.secrets, HOME_AUTH_DIRECTORY)
  let pem: Buffer
  try {
    pem = await readProtectedFile(path)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    if (options.create !== true) return undefined
    await mkdir(directory, { recursive: true, mode: PRIVATE_DIR_MODE })
    await checkPrivateDirectory(directory)
    await createKeyFile(path)
    pem = await readProtectedFile(path)
  }
  return homeKeyOf(createPrivateKey(pem))
}

/**
 * Describe one private key as a home key.
 * @param privateKey - the private key.
 * @returns the home key.
 * @throws Error when the key is not Ed25519.
 */
function homeKeyOf(privateKey: KeyObject): HomeKey {
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('the home key is not an Ed25519 key')
  const publicKey = encodePublicKey(createPublicKey(privateKey))
  return { keyId: keyFingerprint(publicKey), publicKey, privateKey }
}

/**
 * Write a new key file: the PEM goes to a temporary sibling created exclusively
 * at 0600, then is linked to the key's path, which fails when another process
 * created the key first; that key is kept and this one is dropped.
 * @param path - the key file's path.
 */
async function createKeyFile(path: string): Promise<void> {
  const { privateKey } = generateKeyPairSync('ed25519')
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' })
  const temporary = `${path}.tmp-${randomBytes(8).toString('hex')}`
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, PROTECTED_FILE_MODE)
  try {
    await handle.writeFile(pem)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await link(temporary, path)
  } catch (error: unknown) {
    // EEXIST: another process created the key between the read and this link; its key is the home's key.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  } finally {
    await unlink(temporary)
  }
}
