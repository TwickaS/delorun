/**
 * The supervisor API's closed request schema (contract C9, "The supervisor API"). A request line is authenticated
 * first, by its `token` alone, so a caller without the current start's token learns nothing about the schema; only
 * then is the whole request checked against the closed schema, where an unknown `op`, an unknown field at any depth
 * or a value outside its type or bound is refused with `SCHEMA_VIOLATION`. No field names an image, a Docker flag, a
 * mount, an environment variable, a command, a device, a capability or a network.
 *
 * @module @delo/supervisor/schema
 */
import { isIP } from 'node:net'
import { isAbsolute } from 'node:path'
import {
  MAX_ALLOWLIST_ADDITIONS,
  MAX_HOST_LENGTH,
  ROOT_MAX_BYTES,
  SUPERVISOR_PROTOCOL_VERSION,
  WORKSPACE_ID_MAX_LENGTH,
  type SupervisorRequest,
} from '@delo/contract-runtime-supervisor'
import { z } from 'zod'
import { SupervisorError } from './errors.ts'
import { authenticateLine, type StartTokenCheck } from '@delo/home'

const HOST_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/

/**
 * Whether a value is an allowlist addition C9 accepts: an exact host name or a `*.`-prefixed suffix, at most 253
 * characters, never an IP address.
 * @param value - the candidate.
 * @returns true when it is accepted.
 */
export function isAllowlistHost(value: string): boolean {
  if (value.length === 0 || value.length > MAX_HOST_LENGTH) return false
  const name = value.startsWith('*.') ? value.slice(2) : value
  if (isIP(name) !== 0) return false
  const labels = name.split('.')
  // A single label is a name on the machine's own search domains, never a public host.
  if (labels.length < 2) return false
  // A last label of digits only would make a dotted IPv4 form in some resolvers.
  if (/^\d+$/.test(labels.at(-1) ?? '')) return false
  return labels.every(label => HOST_LABEL.test(label))
}

const workspaceId = z.string().min(1).max(WORKSPACE_ID_MAX_LENGTH)
const root = z.string().refine(value => isAbsolute(value) && !value.includes('\0') && Buffer.byteLength(value, 'utf8') <= ROOT_MAX_BYTES, {
  message: `an absolute path of at most ${String(ROOT_MAX_BYTES)} bytes`,
})
const egress = z.enum(['allowlist', 'open', 'none'])
const allowlistAdditions = z.array(z.string().refine(isAllowlistHost, { message: 'a host name or a *.-prefixed suffix, not an IP address' })).max(MAX_ALLOWLIST_ADDITIONS)
const stopMode = z.enum(['graceful', 'kill'])
const limits = z.strictObject({
  cpus: z.number().positive().finite(),
  memoryBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  diskBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  pids: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  tmpBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
})
const base = { v: z.literal(SUPERVISOR_PROTOCOL_VERSION), token: z.string() }
const one = z.strictObject({ workspaceId })

const request = z.discriminatedUnion('op', [
  z.strictObject({ ...base, op: z.literal('capabilities'), args: z.strictObject({ refresh: z.boolean() }) }),
  z.strictObject({
    ...base,
    op: z.literal('workspace.create'),
    args: z.strictObject({
      workspaceId,
      root,
      preset: z.enum(['small', 'balanced', 'large', 'advanced']),
      limits: limits.optional(),
      egress,
      allowlistAdditions,
      credentials: z.enum(['deploy-key', 'agent-confirm', 'token', 'none']),
    }).refine(args => (args.preset === 'advanced') === (args.limits !== undefined), {
      message: 'limits are given exactly when the preset is advanced',
      path: ['limits'],
    }),
  }),
  z.strictObject({ ...base, op: z.literal('workspace.start'), args: one }),
  z.strictObject({ ...base, op: z.literal('workspace.stop'), args: z.strictObject({ workspaceId, mode: stopMode }) }),
  z.strictObject({ ...base, op: z.literal('workspace.remove'), args: one }),
  z.strictObject({ ...base, op: z.literal('workspace.inspect'), args: one }),
  z.strictObject({ ...base, op: z.literal('workspace.list') }),
  z.strictObject({ ...base, op: z.literal('workspace.egress'), args: z.strictObject({ workspaceId, egress, allowlistAdditions }) }),
  z.strictObject({ ...base, op: z.literal('helper.start'), args: one }),
  z.strictObject({ ...base, op: z.literal('s3.create') }),
  z.strictObject({ ...base, op: z.literal('s3.start') }),
  z.strictObject({ ...base, op: z.literal('s3.stop'), args: z.strictObject({ mode: stopMode }) }),
  z.strictObject({ ...base, op: z.literal('s3.inspect') }),
])

/**
 * The refusal's detail: where the first problem is, never the value found there, which may be a secret a caller
 * put in the wrong field.
 * @param issues - zod's issues.
 * @returns the detail.
 */
function detailOf(issues: readonly z.core.$ZodIssue[]): string {
  const [first] = issues
  if (first === undefined) return 'the request does not match the schema'
  const at = first.path.map(String).join('.')
  if (first.code === 'unrecognized_keys') return `unknown field ${[at, ...first.keys].filter(part => part !== '').join('.')}`
  if (first.code === 'invalid_union' && (at === '' || at === 'op')) return 'unknown op'
  return `${at === '' ? 'the request' : at}: ${first.message}`
}

/**
 * Check an authenticated request against the closed schema.
 * @param value - the parsed request line, already authenticated by its token.
 * @returns the request.
 * @throws {SupervisorError} `SCHEMA_VIOLATION` when the request breaks the schema.
 */
export function checkRequest(value: object): SupervisorRequest {
  const parsed = request.safeParse(value)
  if (!parsed.success) throw new SupervisorError('SCHEMA_VIOLATION', detailOf(parsed.error.issues))
  // The schema checked every field the contract's type names; the brands are the contract's own types.
  return parsed.data as SupervisorRequest
}

/**
 * Authenticate one request line and check it against the closed schema.
 * @param line - the request line, without its newline.
 * @param check - the current start's token check.
 * @returns the request.
 * @throws {SupervisorError} `UNAUTHENTICATED` when the line is not a JSON object carrying the current start's
 *   token, and `SCHEMA_VIOLATION` when an authenticated request breaks the schema.
 */
export function decodeRequest(line: string, check: StartTokenCheck): SupervisorRequest {
  const value = authenticateLine(line, check)
  if (value === undefined) throw new SupervisorError('UNAUTHENTICATED')
  return checkRequest(value)
}
