/**
 * The self-hosted relay's configuration: `/etc/delorun-relay/relay.yaml` inside its container,
 * the bindings that tie a studio name to one home public key, the token key at
 * `<stateDir>/token-key.pem` at mode 0600, and the relay id the token key derives. The relay
 * refuses to start when a name appears twice, when a home key appears twice, when its own
 * tunnel host is a bound name, when a name is not a DNS host name, or when a rebind statement
 * does not describe its own binding (C6, "Relay configuration").
 *
 * @module @delorun/relay/config
 */
import type { Base64Url, RelayBinding } from '@delorun/contract-relay-protocol'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { RelayId } from '@delorun/contract-relay-protocol'
import { chmodSync, lstatSync, mkdirSync, readFileSync, writeFileSync, type Stats } from 'node:fs'
import { join } from 'node:path'
import type { KeyObject } from 'node:crypto'
import { parse } from 'yaml'
import { z } from 'zod'
import { RelayError } from './errors.ts'
import { fromBase64Url, generateEd25519, keyIdOf, privateKeyFromPem, publicKeyFromRaw, rawPublicKey } from './keys.ts'
import { isHostName } from './client-hello.ts'

/** The configuration file's path inside the relay container. */
export const RELAY_CONFIG_PATH = '/etc/delorun-relay/relay.yaml'

/** Where the token key and the binding history live by default. */
export const DEFAULT_STATE_DIR = '/var/lib/delorun-relay'

/** A validated binding: one studio name, the key bound to it and that key's id. */
export interface RelayBindingView {
  /** The studio name, in lowercase. */
  readonly name: string
  /** The 32-byte raw Ed25519 public key. */
  readonly homePublicKey: KeyObject
  /** The home key id: the SHA-256 hash of the raw public key, base64url. */
  readonly homeKeyId: Base64Url
}

/** The relay's configuration after validation, with the token key and the id it derives. */
export interface RelaySettings {
  /** The relay's own name; it terminates TLS for this name only. */
  readonly tunnelHost: string
  /** The PEM certificate chain for {@link tunnelHost}. */
  readonly tunnelCertFile: string
  /** The PEM private key for {@link tunnelHost}. */
  readonly tunnelKeyFile: string
  /** The bound names, by lowercase name. */
  readonly bindings: ReadonlyMap<string, RelayBindingView>
  /** Where the token key and the binding history live. */
  readonly stateDir: string
  /** The token key, the relay's only private key. */
  readonly tokenKey: KeyObject
  /** The relay id: the SHA-256 hash of the token public key, base64url. */
  readonly relayId: RelayId
  /** The instant the relay started, before which it accepts no token. */
  readonly startedAt: number
}

/** The options of {@link loadRelayConfig}. */
export interface LoadConfigOptions {
  /** The configuration file's path; {@link RELAY_CONFIG_PATH} by default. */
  readonly path?: string
  /** The clock, in milliseconds since the epoch. */
  readonly now: () => number
}

const rebindStatementSchema = z.strictObject({
  v: z.literal(1),
  name: z.string().min(1).max(253),
  previousHomeKeyId: z.string().min(1).max(128),
  newHomePublicKey: z.string().min(1).max(128),
  issuedAt: z.number().int(),
  signature: z.string().min(1).max(128),
})

const bindingSchema = z.strictObject({
  name: z.string(),
  homePublicKey: z.string(),
  rebindStatement: rebindStatementSchema.optional(),
  forceRebind: z.literal(true).optional(),
})

const documentSchema = z.strictObject({
  tunnelHost: z.string(),
  tunnelCertFile: z.string().min(1),
  tunnelKeyFile: z.string().min(1),
  bindings: z.array(bindingSchema).min(1),
  stateDir: z.string().min(1).optional(),
})

/** The configuration file as the schema reads it. */
type ConfigDocument = z.infer<typeof documentSchema>

/**
 * Parse the configuration text into its schema, refusing a field the protocol does not define.
 * @param text - the YAML text.
 * @returns the document and the state directory it names or the default.
 * @throws RelayError `CONFIG_INVALID` for a document the schema refuses.
 */
function parseDocument(text: string): { readonly document: ConfigDocument; readonly stateDir: string } {
  let raw: unknown
  try {
    raw = parse(text)
  } catch (error: unknown) {
    throw new RelayError('CONFIG_INVALID', `the configuration is not YAML: ${error instanceof Error ? error.message : 'unknown error'}`)
  }
  const parsed = documentSchema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues.map(issue => `${issue.path.length === 0 ? 'the document' : issue.path.join('.')}: ${issue.message}`)
    throw new RelayError('CONFIG_INVALID', `the configuration does not match its schema: ${issues.join('; ')}`)
  }
  return { document: parsed.data, stateDir: parsed.data.stateDir ?? DEFAULT_STATE_DIR }
}

/** Check one binding's rebind statement against the binding it is written in. */
function checkRebindStatement(binding: RelayBinding, name: string): void {
  if (binding.forceRebind === true && binding.rebindStatement !== undefined) {
    throw new RelayError('CONFIG_INVALID', `the binding for ${name} carries both a rebind statement and forceRebind; C6 uses forceRebind only without the old key's signature`)
  }
  const statement = binding.rebindStatement
  if (statement === undefined) return
  if (statement.name.toLowerCase() !== name) throw new RelayError('CONFIG_INVALID', `the rebind statement of ${name} names ${statement.name}`)
  if (statement.newHomePublicKey !== binding.homePublicKey) throw new RelayError('CONFIG_INVALID', `the rebind statement of ${name} names another new home public key than its binding`)
}

/** Build the validated settings from a parsed document and the token key. */
function buildSettings(document: ConfigDocument, stateDir: string, tokenKey: KeyObject, now: () => number): RelaySettings {
  const tunnelHost = document.tunnelHost.toLowerCase()
  if (!isHostName(tunnelHost)) throw new RelayError('CONFIG_INVALID', `tunnelHost "${document.tunnelHost}" is not a DNS host name`)
  const bindings = new Map<string, RelayBindingView>()
  const keyIds = new Map<string, string>()
  for (const binding of document.bindings) {
    const name = binding.name.toLowerCase()
    if (!isHostName(name)) throw new RelayError('CONFIG_INVALID', `the binding name "${binding.name}" is not a DNS host name`)
    if (name === tunnelHost) throw new RelayError('CONFIG_INVALID', `the binding name ${name} is also tunnelHost, and the relay terminates TLS for tunnelHost only`)
    if (bindings.has(name)) throw new RelayError('CONFIG_INVALID', `the name ${name} appears in two bindings`)
    const raw = (() => {
      try {
        return fromBase64Url(binding.homePublicKey, 32)
      } catch (_error: unknown) {
        throw new RelayError('CONFIG_INVALID', `the home public key of ${name} is not 32 bytes of base64url`)
      }
    })()
    const homeKeyId = brandString<Base64Url>(keyIdOf(raw))
    const otherName = keyIds.get(homeKeyId)
    if (otherName !== undefined) throw new RelayError('CONFIG_INVALID', `the home public key of ${name} is bound to ${otherName} too, and C6 binds one key to one name`)
    keyIds.set(homeKeyId, name)
    checkRebindStatement(binding as RelayBinding, name)
    bindings.set(name, { name, homePublicKey: publicKeyFromRaw(raw), homeKeyId })
  }
  return {
    tunnelHost,
    tunnelCertFile: document.tunnelCertFile,
    tunnelKeyFile: document.tunnelKeyFile,
    bindings,
    stateDir,
    tokenKey,
    relayId: brandString<RelayId>(keyIdOf(rawPublicKey(tokenKey))),
    startedAt: now(),
  }
}

/**
 * The token key of a relay, creating it at its first start.
 *
 * The key is `<stateDir>/token-key.pem`, an Ed25519 PKCS #8 PEM at mode 0600. An existing key
 * that another user can read, that is a symbolic link or that is not Ed25519 is refused rather
 * than replaced, so a relay never silently re-issues tokens under another identity.
 * @param stateDir - the directory the configuration names.
 * @param create - whether to create the key and its directory when they are missing.
 * @returns the token private key.
 * @throws RelayError `TOKEN_KEY_UNPROTECTED` for an existing key another user can reach or a
 *   state directory that is not private; `CONFIG_UNREADABLE` when the key cannot be written.
 */
export function loadTokenKey(stateDir: string, create = true): KeyObject {
  const path = join(stateDir, 'token-key.pem')
  const existing = lstatOrMissing(path)
  if (existing === undefined) {
    if (!create) throw new RelayError('CONFIG_UNREADABLE', `the token key ${path} does not exist`)
    return createTokenKey(stateDir, path)
  }
  if (existing.isSymbolicLink()) throw new RelayError('TOKEN_KEY_UNPROTECTED', `the token key ${path} is a symbolic link`)
  if (!existing.isFile()) throw new RelayError('TOKEN_KEY_UNPROTECTED', `the token key ${path} is not a file`)
  if ((existing.mode & 0o077) !== 0) throw new RelayError('TOKEN_KEY_UNPROTECTED', `the token key ${path} has mode 0${existing.mode.toString(8)}, and C6 requires 0600`)
  return privateKeyFromPem(readFileSync(path, 'utf8'))
}

/** `lstat` a path, or `undefined` when nothing is there. */
function lstatOrMissing(path: string): Stats | undefined {
  try {
    return lstatSync(path)
  } catch (error: unknown) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new RelayError('CONFIG_UNREADABLE', `the token key ${path} cannot be read: ${error instanceof Error ? error.message : 'unknown error'}`)
  }
}

/** Create the state directory and the token key at its first start. */
function createTokenKey(stateDir: string, path: string): KeyObject {
  const key = generateEd25519()
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    writeFileSync(path, key.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' })
    chmodSync(path, 0o600)
  } catch (error: unknown) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'EEXIST') return loadTokenKey(stateDir, false)
    throw new RelayError('CONFIG_UNREADABLE', `the token key ${path} cannot be written: ${error instanceof Error ? error.message : 'unknown error'}`)
  }
  return key
}

/**
 * Build the relay's settings from its configuration text.
 * @param text - the YAML text.
 * @param options - the token key and the clock.
 * @returns the validated settings.
 * @throws RelayError `CONFIG_INVALID` for a document the schema refuses or a binding rule of C6
 *   the document breaks.
 */
export function parseRelayConfig(text: string, options: { readonly tokenKey: KeyObject; readonly now: () => number }): RelaySettings {
  const { document, stateDir } = parseDocument(text)
  return buildSettings(document, stateDir, options.tokenKey, options.now)
}

/**
 * Read the relay's configuration file, load or create its token key, and validate both.
 * @param options - the file's path and the clock.
 * @returns the validated settings.
 * @throws RelayError `CONFIG_UNREADABLE` when the file cannot be read, and the refusals of
 *   {@link parseRelayConfig} and {@link loadTokenKey}.
 */
export function loadRelayConfig(options: LoadConfigOptions): RelaySettings {
  const path = options.path ?? RELAY_CONFIG_PATH
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error: unknown) {
    throw new RelayError('CONFIG_UNREADABLE', `the configuration file ${path} cannot be read: ${error instanceof Error ? error.message : 'unknown error'}`)
  }
  const { document, stateDir } = parseDocument(text)
  return buildSettings(document, stateDir, loadTokenKey(stateDir), options.now)
}
