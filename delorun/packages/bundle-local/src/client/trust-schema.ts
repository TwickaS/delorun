/**
 * The trust bill's wire validation: {@link TrustBillSchema} reads a bill that crossed a process boundary, the Host's
 * answer in the studio and `delorun verify --json`'s output in the Host. Unknown fields are dropped. Browser-safe, and
 * it imports nothing but `zod` and the bill's types, so the CLI loads it without the studio's packages.
 * @module @delorun/bundle-local/client/trust-schema
 */
import { z } from 'zod'
import {
  TRUST_BILL_SCHEMA,
  type TrustBill, type TrustChanges, type TrustChecks, type TrustFullCheck, type TrustRowFreshness, type TrustMcp, type TrustPatches, type TrustPlugin, type TrustPlugins, type TrustRelease, type TrustReleaseLog,
} from './trust-bill.ts'

const result = z.enum(['pass', 'fail', 'unknown'])
const nullableString = z.string().nullable()
const count = z.number().int().nonnegative()

const ReleaseSchema: z.ZodType<TrustRelease> = z.object({
  version: nullableString,
  commit: nullableString,
  manifestSha256: nullableString,
  fileListSha256: nullableString,
  root: z.object({ version: count, keyIds: z.array(z.string()), anchored: z.enum(['shipped', 'stored']) }).nullable(),
  launcher: z.object({ version: nullableString, path: nullableString }),
  lastFullHashAt: nullableString,
  startCheck: z.object({ at: z.string(), full: z.boolean(), hashed: count, files: count, checkedBy: z.literal('runtime').exactOptional() }).nullable(),
  signature: result,
  files: result,
  detail: z.string().exactOptional(),
})

const ReleaseLogSchema: z.ZodType<TrustReleaseLog> = z.object({
  state: z.enum(['verified', 'unchecked', 'failed', 'unknown']),
  lastAttempt: nullableString,
  uncheckedSince: nullableString,
  detail: z.string().exactOptional(),
})

const PluginSchema: z.ZodType<TrustPlugin> = z.object({
  name: z.string(),
  source: z.enum(['registry', 'git', 'link', 'file', 'tarball', 'unknown']),
  version: nullableString,
  integrity: nullableString,
  commit: nullableString,
  match: z.enum(['match', 'mismatch', 'unrecorded', 'unknown']),
  warnings: z.array(z.string()),
  criticalAdvisories: z.array(z.string()),
})

const status = z.enum(['known', 'unknown'])

const PluginsSchema: z.ZodType<TrustPlugins> = z.object({
  status,
  reason: z.string().exactOptional(),
  entries: z.array(PluginSchema),
})

const ChangesSchema: z.ZodType<TrustChanges> = z.object({
  status,
  reason: z.string().exactOptional(),
  harnessEdits: z.array(z.object({ file: z.string() })),
  approvedPlugins: z.array(z.object({ plugin: z.string(), version: nullableString, source: z.string() })),
  notReviewed: count,
})

const PatchesSchema: z.ZodType<TrustPatches> = z.object({
  status,
  reason: z.string().exactOptional(),
  rows: z.array(z.object({ layer: z.string(), id: nullableString, name: nullableString })),
  jsValues: count,
})

const McpSchema: z.ZodType<TrustMcp> = z.object({
  status,
  reason: z.string().exactOptional(),
  servers: z.array(z.object({ name: z.string(), transport: nullableString })),
})

/** A bill as the wire carries it, validated and typed as {@link TrustBill}. Unknown fields are dropped. */
export const TrustBillSchema: z.ZodType<TrustBill> = z.object({
  schema: z.literal(TRUST_BILL_SCHEMA),
  stage: z.enum(['start', 'verify']),
  generatedAt: z.string(),
  release: ReleaseSchema,
  releaseLog: ReleaseLogSchema,
  plugins: PluginsSchema,
  changes: ChangesSchema,
  patches: PatchesSchema,
  skills: z.object({ roots: z.array(z.object({ path: z.string(), source: z.string() })) }),
  mcp: McpSchema,
  checkedBy: z.discriminatedUnion('via', [
    z.object({ via: z.literal('launcher'), seconds: z.number().nonnegative() }),
    z.object({ via: z.literal('host'), reason: z.enum(['no-launcher', 'launcher-unresolvable']), seconds: z.number().nonnegative() }),
  ]).exactOptional(),
  checkNow: z.discriminatedUnion('via', [
    z.object({ via: z.literal('launcher') }),
    z.object({ via: z.literal('host'), reason: z.enum(['no-launcher', 'launcher-unresolvable']) }),
  ]).exactOptional(),
})

const FreshnessShape = { at: nullableString, running: z.boolean() }

const FreshnessSchema: z.ZodType<TrustRowFreshness> = z.object(FreshnessShape)

const FullCheckSchema: z.ZodType<TrustFullCheck> = z.discriminatedUnion('state', [
  z.object({ state: z.literal('waiting') }),
  z.object({ state: z.literal('running') }),
  z.object({ state: z.literal('done') }),
  z.object({
    state: z.literal('unavailable'),
    reason: z.enum(['no-launcher', 'launcher-unresolvable', 'failed', 'off']),
  }),
])

/** How fresh each row is, as the Host serves it beside the bill. Unknown fields are dropped. */
export const TrustChecksSchema: z.ZodType<TrustChecks> = z.object({
  release: z.object({ ...FreshnessShape, full: FullCheckSchema }),
  releaseLog: FreshnessSchema,
  plugins: FreshnessSchema,
  changes: FreshnessSchema,
})
