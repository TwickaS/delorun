/**
 * Check registry, results, modes, stages and report types of Delo's verification
 * checks, as specified by `delo/docs/contracts/c15-verification-checks.md`. This
 * module holds readonly constants and types only.
 *
 * @module @delo/contract-verification-checks
 */

/** Report schema version. Readers refuse any other value. */
export const VERIFICATION_REPORT_SCHEMA_VERSION = 1 as const

/** The notice that every report carries. */
export const VERIFICATION_NOTICE = "checks run with the person's access" as const

/** Maximum length, in characters, of one check detail. */
export const VERIFICATION_DETAIL_MAX_LENGTH = 512 as const

/** Settings key that holds the mode. */
export const VERIFICATION_MODE_SETTING = 'integrity.mode' as const

/** Length, in bytes, of the home's challenge in a machine report, before base64url encoding. */
export const VERIFICATION_CHALLENGE_BYTES = 32 as const

/** Verification modes. `warn` is the default. */
export const VERIFICATION_MODES = ['warn', 'enforce', 'off'] as const

/** One mode of {@link VERIFICATION_MODES}. */
export type VerificationMode = (typeof VERIFICATION_MODES)[number]

/** Stages at which a run occurs. */
export const VERIFICATION_STAGES = ['start', 'update', 'change', 'verify'] as const

/** One stage of {@link VERIFICATION_STAGES}. */
export type VerificationStage = (typeof VERIFICATION_STAGES)[number]

/** Results a check yields. Only `pass` is a pass. */
export const VERIFICATION_RESULTS = ['pass', 'fail', 'not-enforced', 'unknown'] as const

/** One result of {@link VERIFICATION_RESULTS}. */
export type VerificationResult = (typeof VERIFICATION_RESULTS)[number]

/**
 * Effects a check may have. `start` and `reach` apply in `enforce` mode. `start-always` applies in
 * every mode and is used only by a verified release-signature failure.
 */
export const VERIFICATION_BLOCKS = ['none', 'start', 'reach', 'start-always'] as const

/** One effect of {@link VERIFICATION_BLOCKS}. */
export type VerificationBlocks = (typeof VERIFICATION_BLOCKS)[number]

/** Identifiers of the registered checks. */
export const VERIFICATION_CHECK_IDS = [
  'release-signature',
  'runtime-files',
  'workspace-isolation',
  'confinement-rule',
  'reach-binding',
  'own-domain-caa',
  'certificates',
  'owner-and-devices',
  'plugin-pins',
  'data-sharing',
  'home-modes',
] as const

/** One check identifier of {@link VERIFICATION_CHECK_IDS}. */
export type VerificationCheckId = (typeof VERIFICATION_CHECK_IDS)[number]

/** One registry entry: the check, its effect (see {@link VERIFICATION_BLOCKS}), and what it inspects. */
export interface VerificationCheckEntry {
  readonly id: VerificationCheckId
  readonly blocks: VerificationBlocks
  readonly subject: string
}

/** The check registry. Every entry runs in every run. */
export const VERIFICATION_CHECKS = [
  { id: 'release-signature', blocks: 'start-always', subject: 'The installed release signature and its release-log entry; a verified failure stops the start in every mode.' },
  { id: 'runtime-files', blocks: 'start', subject: 'The runtime files against the signed manifest.' },
  { id: 'workspace-isolation', blocks: 'none', subject: 'The isolation in effect for each workspace and the Docker limits.' },
  { id: 'confinement-rule', blocks: 'none', subject: 'Whether the sandbox dialect denies confined commands the paths under the home and the Docker socket.' },
  { id: 'reach-binding', blocks: 'reach', subject: 'The reach listener binding and the active reach option.' },
  { id: 'own-domain-caa', blocks: 'reach', subject: 'The CAA record of an own domain, for the parameters the certificate authority enforces.' },
  { id: 'certificates', blocks: 'reach', subject: 'The certificate state for the home names and the certificate alerts.' },
  { id: 'owner-and-devices', blocks: 'none', subject: 'The owner, the trusted devices and the identity factor of each reach address.' },
  { id: 'plugin-pins', blocks: 'none', subject: 'The plugin pins, the compatibility badges and the revocation list.' },
  { id: 'data-sharing', blocks: 'none', subject: 'The two upstream opt-ins.' },
  { id: 'home-modes', blocks: 'none', subject: 'The modes of the home directory and its secret files.' },
] as const satisfies readonly VerificationCheckEntry[]

/** The result of one check in one run. */
export interface VerificationCheckResult {
  readonly id: VerificationCheckId
  readonly result: VerificationResult
  /** At most {@link VERIFICATION_DETAIL_MAX_LENGTH} characters; never a secret or file content. */
  readonly detail: string
}

/** The badge rule's outcome: `green` only in `enforce` with every check at `pass`. */
export type VerificationBadge = 'green' | 'not-green'

/** The report of one run. */
export interface VerificationReport {
  readonly schemaVersion: typeof VERIFICATION_REPORT_SCHEMA_VERSION
  readonly mode: VerificationMode
  readonly stage: VerificationStage
  /** RFC 3339 time in UTC at which the run finished. */
  readonly generatedAt: string
  readonly notice: typeof VERIFICATION_NOTICE
  readonly badge: VerificationBadge
  readonly checks: readonly VerificationCheckResult[]
}

/** A machine report. Signed over the canonical JSON of the report without `signature`. */
export interface MachineVerificationReport extends VerificationReport {
  /** Base64url Ed25519 signature made with the machine's key. */
  readonly signature: string
  /** Base64url encoding of the single-use challenge that the home issued. */
  readonly challenge: string
}
