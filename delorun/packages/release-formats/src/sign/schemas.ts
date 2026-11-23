/**
 * Readers of contract C2's signed release files: each checks the file's size limit before parsing, refuses duplicate
 * keys, an unknown `schema` and unknown fields, and returns the envelope typed as the contract types it.
 *
 * @module @delorun/release-formats/sign/schemas
 */
import {
  DESKTOP_PLATFORMS,
  RELEASE_CHANNELS,
  NPM_PACKAGE_NAME_PATTERN,
  PACK_DOWNLOAD_MAX_BYTES,
  RELEASE_FILE_SIZE_LIMITS,
  RELEASE_SCHEMAS,
  RELEASE_SUMMARY_MAX_LENGTH,
  RUNTIME_PLATFORMS,
  isValidSummary,
  type AdvisoryId,
  type KeyId,
  type NpmIntegrity,
  type OciDigest,
  type ReleaseManifest,
  type RebuildRecord,
  type RootMetadata,
  type RuntimeFileList,
  type SemanticVersion,
  type Sha256Hex,
  type Sha512Base64,
  type SignedEnvelope,
  type TimestampMetadata,
  type UtcTimestamp,
} from '@delorun/contract-release-manifest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'
import { entryPublicKey, isLogEntryKeyDetails } from '../log/entry-keys.ts'
import { parseStrictJson, type JsonValue } from './json.ts'

const sha256 = z.string().regex(/^[0-9a-f]{64}$/u).transform(value => brandString<Sha256Hex>(value))
const keyId = z.string().regex(/^[0-9a-f]{64}$/u).transform(value => brandString<KeyId>(value))
const version = z.string().max(64).regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/u).transform(value => brandString<SemanticVersion>(value))
const timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u).refine(value => new Date(value).toISOString() === value.replace('Z', '.000Z'), 'a valid UTC time')
  .transform(value => brandString<UtcTimestamp>(value))
const oci = z.string().regex(/^sha256:[0-9a-f]{64}$/u).transform(value => brandString<OciDigest>(value))
const positive = z.number().int().min(1)
/** A file name in a release directory: one path segment, never `.` or `..`, so a reference cannot leave the directory. */
const fileName = z.string().max(255).regex(/^[A-Za-z0-9._+-]+$/u).refine(name => name !== '.' && name !== '..', 'a file name, not . or ..')
const fileRef = z.strictObject({ name: fileName, length: z.number().int().min(0), sha256 })
const roleKeys = z.strictObject({ keyids: z.array(keyId), threshold: positive })

const logIdentity = z.strictObject({ origin: z.string().min(1), vkey: z.string().min(1) })
/** Standard base64 with padding that decodes to at least one byte and encodes back to itself. */
const canonicalBase64 = z.string().min(4).refine(value => Buffer.from(value, 'base64').toString('base64') === value, 'canonical standard base64')

/** The signed content of root metadata. */
export const RootSchema = z.strictObject({
  schema: z.literal(RELEASE_SCHEMAS.root),
  version: positive,
  issued: timestamp,
  expires: timestamp,
  keys: z.record(z.string().regex(/^[0-9a-f]{64}$/u), z.strictObject({ algorithm: z.literal('ed25519'), public: z.string() })),
  roles: z.strictObject({
    root: roleKeys,
    targets: z.strictObject({
      keys: z.array(z.strictObject({ keyid: keyId, status: z.enum(['active', 'retired', 'revoked']), lastRelease: version.optional() })),
      threshold: positive,
    }),
    timestamp: roleKeys,
    catalogue: roleKeys,
  }),
  log: logIdentity,
  logs: z.array(logIdentity).min(1).optional(),
  logEntryKeys: z.array(z.strictObject({
    keyDetails: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/u),
    public: canonicalBase64,
    status: z.enum(['active', 'retired', 'revoked']),
    lastRelease: version.optional(),
  })).min(1).optional(),
  witnesses: z.strictObject({ keys: z.array(z.strictObject({ name: z.string().min(1), vkey: z.string().min(1) })), threshold: positive }),
}).superRefine((root, context) => {
  const roles = new Map<string, string>()
  const assigned: Array<[string, readonly string[]]> = [
    ['root', root.roles.root.keyids],
    ['targets', root.roles.targets.keys.map(key => key.keyid)],
    ['timestamp', root.roles.timestamp.keyids],
    ['catalogue', root.roles.catalogue.keyids],
  ]
  for (const [role, keyids] of assigned) {
    for (const keyid of keyids) {
      const other = roles.get(keyid)
      if (other !== undefined) context.addIssue({ code: 'custom', path: ['roles', role], message: `key ${keyid} is already in role ${other}; each key holds one role` })
      roles.set(keyid, role)
    }
  }
  const active = root.roles.targets.keys.filter(key => key.status === 'active').length
  if (active !== 1) context.addIssue({ code: 'custom', path: ['roles', 'targets', 'keys'], message: `${String(active)} targets keys are active; exactly one must be` })
  if (root.logs !== undefined) {
    if (!root.logs.some(log => log.origin === root.log.origin && log.vkey === root.log.vkey)) context.addIssue({ code: 'custom', path: ['logs'], message: 'logs does not list the root\'s log with its verifier key' })
    const origins = new Set(root.logs.map(log => log.origin))
    if (origins.size !== root.logs.length) context.addIssue({ code: 'custom', path: ['logs'], message: 'logs lists one origin more than once' })
  }
  if (root.logEntryKeys !== undefined) {
    const seen = new Set<string>()
    for (const [index, key] of root.logEntryKeys.entries()) {
      const path = ['logEntryKeys', index]
      if ((key.status === 'retired') !== (key.lastRelease !== undefined)) context.addIssue({ code: 'custom', path, message: 'a retired log-entry key carries lastRelease, and only a retired one' })
      if (isLogEntryKeyDetails(key.keyDetails) && entryPublicKey(key.keyDetails, Buffer.from(key.public, 'base64')) === undefined) {
        context.addIssue({ code: 'custom', path, message: `the ${key.keyDetails} log-entry key is not a DER public key of that type` })
      }
      if (seen.has(`${key.keyDetails} ${key.public}`)) context.addIssue({ code: 'custom', path, message: `the ${key.keyDetails} log-entry key is listed more than once` })
      seen.add(`${key.keyDetails} ${key.public}`)
    }
    if (!root.logEntryKeys.some(key => key.status === 'active' && isLogEntryKeyDetails(key.keyDetails))) {
      context.addIssue({ code: 'custom', path: ['logEntryKeys'], message: 'no log-entry key of a type this client verifies is active, so no release could be logged' })
    }
  }
})

/**
 * Open map: a reader drops the keys of `keys` it does not know before validating the rest, so a platform or channel a
 * later release adds never makes an older reader refuse the file. Dropped keys stay inside the signed bytes and are
 * never used.
 */
function onlyKeys<T extends z.ZodType>(keys: readonly string[], schema: T): z.ZodType<z.output<T>, unknown> {
  return z.preprocess(value => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
    return Object.fromEntries(Object.entries(value).filter(([key]) => keys.includes(key)))
  }, schema)
}

const channelPointer = z.strictObject({ release: version, manifest: fileRef })

/** The signed content of timestamp metadata. */
export const TimestampSchema = z.strictObject({
  schema: z.literal(RELEASE_SCHEMAS.timestamp),
  version: positive,
  issued: timestamp,
  expires: timestamp,
  root: z.strictObject({ version: positive, sha256 }),
  channels: onlyKeys(RELEASE_CHANNELS, z.strictObject({ stable: channelPointer, beta: channelPointer })),
})

const desktopRef = fileRef.extend({ sha512: z.string().regex(/^[A-Za-z0-9+/]{86}==$/u).transform(value => brandString<Sha512Base64>(value)) })
/** An image's reference; `seccomp`, when present, is the release file holding the profile its containers run under. */
export const ImageRefSchema = z.strictObject({ repository: z.string().min(1), index: oci, platforms: z.strictObject({ 'linux/amd64': oci, 'linux/arm64': oci }), seccomp: fileRef.exactOptional() })

/** A release summary as `isValidSummary` of the contract package defines it. */
export const ReleaseSummarySchema = z.string().refine(isValidSummary, `a release summary: 1 to ${String(RELEASE_SUMMARY_MAX_LENGTH)} characters, no control, format, line-break or lone surrogate character, and no whitespace at either end`)

/**
 * The `rebuild.builders[].name` of a release `delorun/apps/release/src/local-release.ts` built: no second builder rebuilt
 * it and no allowed signer tagged it. A launcher fetching from contract C2's production publication refuses a manifest
 * that names this builder.
 */
export const LOCAL_RELEASE_BUILDER = 'local release (no independent rebuild)'

/** The desktop files of every desktop platform; optional in {@link ManifestSchema}, required to sign. */
export const DesktopSchema = z.strictObject(Object.fromEntries(DESKTOP_PLATFORMS.map(platform => [platform, z.strictObject({ installer: desktopRef, update: desktopRef, blockmap: fileRef })])) as Record<(typeof DESKTOP_PLATFORMS)[number], z.ZodObject<{ installer: typeof desktopRef, update: typeof desktopRef, blockmap: typeof fileRef }, z.core.$strict>>)
/** The S2 and S3 images; optional in {@link ManifestSchema}, required to sign. */
export const ImagesSchema = z.strictObject({ s2: ImageRefSchema, s3: ImageRefSchema })
/** The release notes file's reference: a file reference whose length is within the notes limit and above zero. */
export const ReleaseNotesRefSchema = fileRef.refine(ref => ref.length >= 1 && ref.length <= RELEASE_FILE_SIZE_LIMITS.notes, `release notes of 1 to ${String(RELEASE_FILE_SIZE_LIMITS.notes)} bytes`)

/** The install scripts; optional in {@link ManifestSchema}, required to sign. */
export const InstallSchema = z.strictObject({ sh: fileRef, ps1: fileRef })

const runtimeArtifacts = z.strictObject({ archive: fileRef, files: fileRef })

/**
 * The runtime table a signer accepts: a platform key outside {@link RUNTIME_PLATFORMS}, such as a misspelt one, is
 * refused instead of dropped, so the signed manifest lists every platform the draft names. Only readers ignore unknown
 * platforms ({@link ManifestSchema}).
 */
export const StrictRuntimeSchema: z.ZodType<z.output<typeof ManifestSchema>['runtime']> = z.strictObject(Object.fromEntries(RUNTIME_PLATFORMS.map(platform => [platform, runtimeArtifacts.exactOptional()])))
  .refine(runtime => Object.keys(runtime).length > 0, 'a release publishes the runtime of at least one platform')

/**
 * The signed content of a release manifest. `security` and `summary` are optional, so a manifest signed before they
 * existed still reads; `desktop`, `images` and `install` are optional so a release without them still reads. Signing
 * requires all five (`ManifestDraftSchema` in `release.ts`). `runtime` ignores platform keys this reader does not know.
 */
export const ManifestSchema = z.strictObject({
  schema: z.literal(RELEASE_SCHEMAS.manifest),
  version,
  dsh: version,
  channel: z.enum(['stable', 'beta']),
  source: z.strictObject({ repository: z.string().min(1), tag: z.string().min(1), commit: z.string().regex(/^[0-9a-f]{40}$/u) }),
  published: timestamp,
  runtime: onlyKeys(RUNTIME_PLATFORMS, z.partialRecord(z.enum(RUNTIME_PLATFORMS), runtimeArtifacts))
    .refine(runtime => Object.keys(runtime).length > 0, 'a release publishes the runtime of at least one platform'),
  desktop: DesktopSchema.exactOptional(),
  images: ImagesSchema.exactOptional(),
  sbom: fileRef.extend({ format: z.literal('SPDX-2.3+json') }),
  npm: z.array(z.strictObject({ name: z.string().min(1), version, integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/u).transform(value => brandString<NpmIntegrity>(value)) })),
  install: InstallSchema.exactOptional(),
  rebuild: z.strictObject({ record: fileRef, builders: z.array(z.strictObject({ name: z.string().min(1), ci: z.literal(false) })).min(1) }),
  advisories: z.strictObject({ report: fileRef, accepted: z.array(z.string().regex(/^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/u).transform(value => brandString<AdvisoryId>(value))) }),
  security: z.boolean().exactOptional(),
  summary: ReleaseSummarySchema.exactOptional(),
  notes: ReleaseNotesRefSchema.exactOptional(),
})

/** The signed content of a runtime file list. */
export const FileListSchema = z.strictObject({
  schema: z.literal(RELEASE_SCHEMAS.files),
  version,
  platform: z.enum(RUNTIME_PLATFORMS),
  files: z.array(z.strictObject({ path: z.string().min(1), length: z.number().int().min(0), sha256, mode: z.enum(['0644', '0755']) })),
})

const sha512 = z.string().regex(/^[A-Za-z0-9+/]{86}==$/u).transform(value => brandString<Sha512Base64>(value))
const npmName = z.string().max(214).regex(new RegExp(NPM_PACKAGE_NAME_PATTERN, 'u'))
const packArchiveRef = fileRef.extend({ length: z.number().int().min(0).max(PACK_DOWNLOAD_MAX_BYTES), sha512 })
const packFile = z.strictObject({ path: z.string().min(1), length: z.number().int().min(0), sha256, mode: z.enum(['0644', '0755']) })
const packVariant = z.strictObject({
  archive: packArchiveRef,
  files: z.array(packFile),
  peers: z.array(npmName),
  external: z.array(z.strictObject({
    name: npmName,
    version,
    url: z.string().regex(/^https:\/\/registry\.npmjs\.org\/[^?#\s]+\.tgz$/u),
    sha512,
    length: z.number().int().min(1).max(PACK_DOWNLOAD_MAX_BYTES),
  })),
})

/** The signed content of the packs document: every pack of a release, bound to its manifest by digest. */
export const PacksSchema = z.strictObject({
  schema: z.literal(RELEASE_SCHEMAS.packs),
  version,
  manifest: sha256,
  packs: z.array(z.strictObject({
    name: npmName,
    version,
    experimental: z.boolean(),
    variants: z.strictObject({ any: packVariant.exactOptional(), ...Object.fromEntries(RUNTIME_PLATFORMS.map(platform => [platform, packVariant.exactOptional()])) }),
  })),
})

/** The content of a rebuild record, a plain JSON file that the manifest covers by its `rebuild.record` digest. */
export const RebuildSchema = z.strictObject({
  schema: z.literal(RELEASE_SCHEMAS.rebuild),
  version,
  commit: z.string().regex(/^[0-9a-f]{40}$/u),
  recipe: sha256,
  builder: z.strictObject({ name: z.string().min(1), ci: z.boolean() }),
  toolchain: z.strictObject({ node: z.string().min(1), pnpm: z.string().min(1), compiler: z.string().min(1), linker: z.string().min(1) }),
  outputs: z.array(fileRef),
  comparedWith: z.string().min(1),
  comparison: z.enum(['match', 'difference']),
})

const signatures = z.array(z.strictObject({ keyid: keyId, sig: z.string() }))

/** The file kinds this module reads, with their schema and size limit. */
const KINDS = {
  root: { schema: RootSchema, limit: RELEASE_FILE_SIZE_LIMITS.root },
  timestamp: { schema: TimestampSchema, limit: RELEASE_FILE_SIZE_LIMITS.timestamp },
  manifest: { schema: ManifestSchema, limit: RELEASE_FILE_SIZE_LIMITS.manifest },
  files: { schema: FileListSchema, limit: RELEASE_FILE_SIZE_LIMITS.files },
  packs: { schema: PacksSchema, limit: RELEASE_FILE_SIZE_LIMITS.packs },
} as const

/** The content type of each envelope kind. */
export interface EnvelopeKinds {
  root: RootMetadata
  timestamp: TimestampMetadata
  manifest: ReleaseManifest
  files: RuntimeFileList
  packs: z.output<typeof PacksSchema>
}

function problem(error: z.ZodError): string {
  return z.prettifyError(error).replaceAll('\n', '; ')
}

/** A signed file as read: the typed envelope, and its `signed` value exactly as parsed, which signatures cover. */
export interface ReadEnvelope<T> extends SignedEnvelope<T> {
  /** The `signed` value as the file holds it. */
  readonly signedJson: JsonValue
}

/**
 * Read a signed release file of a known kind without verifying its signatures.
 * @param kind - the expected file kind.
 * @param bytes - the file's bytes.
 * @returns the typed envelope with its parsed `signed` value.
 * @throws Error when the file exceeds its size limit, is not strict JSON, names another schema or has unknown or
 * malformed fields.
 */
export function readEnvelope<K extends keyof EnvelopeKinds>(kind: K, bytes: Uint8Array): ReadEnvelope<EnvelopeKinds[K]> {
  const { schema, limit } = KINDS[kind]
  const json = parseStrictJson(bytes, limit)
  const parsed = z.strictObject({ signed: z.unknown(), signatures }).safeParse(json)
  if (!parsed.success) throw new Error(`${kind} file: ${problem(parsed.error)}`)
  const signed = schema.safeParse(parsed.data.signed)
  if (!signed.success) throw new Error(`${kind} file: ${problem(signed.error)}`)
  const signedJson = (json as { readonly signed: JsonValue }).signed
  return { signed: signed.data as EnvelopeKinds[K], signatures: parsed.data.signatures, signedJson }
}

/**
 * Read a rebuild record.
 * @param bytes - the file's bytes.
 * @returns the record.
 * @throws Error when the file exceeds its size limit, is not strict JSON or does not match the schema.
 */
export function readRebuildRecord(bytes: Uint8Array): RebuildRecord {
  const parsed = RebuildSchema.safeParse(parseStrictJson(bytes, RELEASE_FILE_SIZE_LIMITS.rebuild))
  if (!parsed.success) throw new Error(`rebuild record: ${problem(parsed.error)}`)
  return parsed.data
}
