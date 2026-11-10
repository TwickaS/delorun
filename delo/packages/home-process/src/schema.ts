/**
 * The update channel's closed request schema (contract C19, "Requests and responses"). The listener has already
 * authenticated the line by its `token`; this module checks the rest. An unknown `op`, an unknown field at any depth,
 * a `v` other than 1 or a value outside its type or bound is refused with `SCHEMA_VIOLATION`, so a request can name
 * only a version, never a path, an archive, a URL or a command.
 *
 * @module @delo/home-process/schema
 */
import { RUNTIME_VERSION_MAX_LENGTH, RUNTIME_VERSION_PATTERN } from '@delo/contract-home-layout'
import { DRAIN_TIMEOUT_MAX_S, DRAIN_TIMEOUT_MIN_S, UPDATE_PROTOCOL_VERSION, type UpdateChannelRequest } from '@delo/contract-home-process'
import { z } from 'zod'
import { HomeProcessError } from './errors.ts'

/** The form of a report id `update.prepare` returns: 32 lowercase hexadecimal digits. */
export const REPORT_ID_PATTERN = /^[0-9a-f]{32}$/

const version = z.string().max(RUNTIME_VERSION_MAX_LENGTH).regex(new RegExp(RUNTIME_VERSION_PATTERN))
const base = { v: z.literal(UPDATE_PROTOCOL_VERSION), token: z.string() }
const drain = { wait: z.enum(['drain', 'abort-if-busy', 'cancel']), drainTimeoutS: z.number().int().min(DRAIN_TIMEOUT_MIN_S).max(DRAIN_TIMEOUT_MAX_S).optional() }

const request = z.discriminatedUnion('op', [
  z.strictObject({ ...base, op: z.literal('status') }),
  z.strictObject({ ...base, op: z.literal('update.prepare'), args: z.strictObject({ target: version.optional() }) }),
  z.strictObject({ ...base, op: z.literal('update.apply'), args: z.strictObject({ ...drain, reportId: z.string().regex(REPORT_ID_PATTERN), dataCopy: z.boolean() }) }),
  z.strictObject({ ...base, op: z.literal('update.cancel') }),
  z.strictObject({ ...base, op: z.literal('rollback'), args: z.strictObject({ ...drain, profileOnly: z.boolean() }) }),
  z.strictObject({ ...base, op: z.literal('stop'), args: z.strictObject({ mode: z.enum(['drain', 'cancel']) }) }),
  z.strictObject({ ...base, op: z.literal('studio.open-token'), args: z.strictObject({ port: z.number().int().min(1).max(65_535).optional() }).optional() }),
  z.strictObject({
    ...base,
    op: z.literal('devices.approve'),
    args: z.strictObject({ requestId: z.string().regex(/^[A-Za-z0-9_-]{22}$/).optional(), typedCode: z.string().regex(/^[0-9 -]{8,12}$/).optional() }),
  }),
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
 * @throws {HomeProcessError} `SCHEMA_VIOLATION` when the request breaks the schema.
 */
export function checkUpdateRequest(value: object): UpdateChannelRequest {
  const parsed = request.safeParse(value)
  if (!parsed.success) throw new HomeProcessError('SCHEMA_VIOLATION', detailOf(parsed.error.issues))
  // The schema checked every field the contract's type names; the brands are the contract's own types.
  return parsed.data as UpdateChannelRequest
}
