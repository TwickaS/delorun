/**
 * The instruction-layer consent seam shared by the mutating tools: before a
 * `write`, `edit` or `apply_patch` mutation executes, the dispatch point in
 * {@link module:@deepseek-ai/dsh-tool-fs/sandbox} consults an optional
 * `writeConsent` service. A review that requires consent asks through
 * `ctx.approval` with the review's note as the request text; a refusal leaves
 * the file unchanged. Without the service, or with a review that does not
 * require consent, the tools behave exactly as before.
 * @module @deepseek-ai/dsh-tool-fs/consent
 */

import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-user-approval'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional {@link WriteConsentService} a consent layer may provide; `ctx.get` returns undefined while none is mounted. */
    writeConsent: WriteConsentService
  }
}

/**
 * The mutating tool whose dispatch asked, as the shared controller names it:
 * `write`, `edit` or `apply_patch` today.
 */
export type WriteConsentTool = string

/**
 * The diff the calling tool carries for the reviewed mutation: the tool's own
 * diff representation when it has one. `apply_patch` sends its patch text;
 * `edit` sends the literal old→new pair; `write` sends `old: null` (it does
 * not carry the previous text) with the full new content.
 */
export type WriteConsentDiff = string | { old: string | null; new: string }

/** One mutation a consent service reviews before it executes. */
export interface WriteConsentRequest {
  /** The mutating tool whose dispatch asked. */
  tool: WriteConsentTool
  /**
   * The target path, resolved to absolute against the calling session's
   * current directory (for `apply_patch`, the patch's first target).
   */
  path: string
  /** The tool's diff representation, omitted when the target is new. */
  diff?: WriteConsentDiff
}

/** One review verdict. */
export type WriteConsentReview =
  | { required: false }
  | { required: true; note: string }

/** The optional consent service the mutating tools consult before a mutation. */
export interface WriteConsentService {
  /**
   * Classify one pending mutation.
   * @param request - the tool, the target path and the tool's diff.
   * @returns `{ required: true, note }` when the mutation needs consent (the
   *   note names the instruction-layer effect and carries the diff), or
   *   `{ required: false }`/undefined to let it proceed without asking.
   */
  review(request: WriteConsentRequest): WriteConsentReview | undefined
}

/** The raw tool arguments the review reads: the file target, the content fields, or the patch text. */
export interface WriteConsentArgs {
  /** `write`/`edit`: the target path as the tool received it. */
  file_path?: unknown
  /** `write`: the full new content. */
  content?: unknown
  /** `edit`: the literal text to replace. */
  old_string?: unknown
  /** `edit`: the literal replacement text. */
  new_string?: unknown
  /** `apply_patch`: the Codex patch text. */
  input?: unknown
}

/** Stable failure code for a consent refusal (or an unanswerable consent ask). */
export const FS_CONSENT_DENIED = 'FS_CONSENT_DENIED'

/**
 * A mutation the consent layer refused: nothing was written. Typed so callers
 * route on the code instead of parsing message text, and so the tool result
 * keeps machine-readable error facts.
 */
export class WriteConsentRefusedError extends HarnessError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, FS_CONSENT_DENIED, options)
    this.name = 'WriteConsentRefusedError'
  }
}

/** The patch-target markers whose first match names an `apply_patch` review path. */
const PATCH_TARGET = /\*\*\* (?:Add|Update|Delete) File: (.+)/u

/**
 * The path the consent review names for one dispatch: the tool's `file_path`
 * argument, or the patch's first target, resolved to absolute against the
 * calling session's current directory (the same directory the tools resolve
 * the mutation through).
 * @param tool - the mutating tool.
 * @param args - the schema-validated raw tool arguments.
 * @param exec - the tool-execution context (agent, callId, signal).
 * @returns the absolute target path, or the raw path when no session cwd applies.
 */
async function reviewPath(tool: WriteConsentTool, args: WriteConsentArgs, exec: ToolExecution): Promise<string> {
  const raw = tool === 'apply_patch'
    ? PATCH_TARGET.exec(typeof args.input === 'string' ? args.input : '')?.[1]?.trim() ?? ''
    : typeof args.file_path === 'string' ? args.file_path : ''
  if (raw === '') return raw
  if (isAbsolute(raw)) return raw
  const cwd = exec.agent === undefined ? undefined : exec.agent.session?.header.cwd
  return cwd === undefined ? raw : resolve(cwd, raw)
}

/**
 * The diff representation one dispatch carries, from the tool's own arguments.
 * @param tool - the mutating tool.
 * @param args - the schema-validated raw tool arguments.
 * @returns the diff, or undefined when the tool carries none (a `write` still
 *   carries its new content with `old: null`).
 */
function reviewDiff(tool: WriteConsentTool, args: WriteConsentArgs): WriteConsentDiff | undefined {
  switch (tool) {
    case 'write':
      return { old: null, new: typeof args.content === 'string' ? args.content : '' }
    case 'edit':
      return { old: typeof args.old_string === 'string' ? args.old_string : '', new: typeof args.new_string === 'string' ? args.new_string : '' }
    case 'apply_patch':
      return typeof args.input === 'string' ? args.input : undefined
    default:
      return undefined
  }
}

/**
 * The consent gate the mutating tools dispatch through before a mutation
 * executes: consult the optional `writeConsent` service, ask for consent when
 * the review requires it, and throw the typed refusal otherwise. Without the
 * service, or on a verdict that does not require consent, nothing happens.
 * @param ctx - the plugin context whose optional `writeConsent` and
 *   `approval` services are consulted.
 * @param tool - the mutating tool whose dispatch asked.
 * @param args - the schema-validated raw tool arguments, read only for the
 *   fields {@link WriteConsentArgs} names.
 * @param exec - the tool-execution context (agent, callId, signal).
 * @throws WriteConsentRefusedError when the ask is refused, cancelled,
 *   unanswerable, or no approval service or agent can carry it.
 */
export async function reviewWriteConsent(
  ctx: Context, tool: WriteConsentTool, args: Record<string, unknown>, exec: ToolExecution,
): Promise<void> {
  const consent = ctx.get('writeConsent')
  if (consent === undefined) return
  const path = await reviewPath(tool, args, exec)
  const diff = reviewDiff(tool, args)
  const verdict = consent.review({
    tool,
    path,
    ...diff !== undefined ? { diff } : {},
  })
  if (verdict === undefined || verdict.required === false) return
  const approver = ctx.get('approval')
  if (approver === undefined) {
    throw new WriteConsentRefusedError(`the ${tool} to "${path}" requires approval, but no approval service is composed`)
  }
  if (exec.agent === undefined) {
    throw new WriteConsentRefusedError(`the ${tool} to "${path}" requires approval, but the call has no agent to route it through`)
  }
  // The approval shape mirrors approveEscalation's: the note rides as the
  // request's reason, the ask is audited on the session log, and the outcome
  // alone decides whether the mutation proceeds.
  const outcome = await approver.request({
    agent: exec.agent,
    toolName: tool,
    ...exec.callId !== undefined ? { callId: exec.callId } : {},
    reason: verdict.note,
    ...exec.signal ? { signal: exec.signal } : {},
  })
  switch (outcome) {
    case 'allowed-once': return
    case 'rejected': throw new WriteConsentRefusedError(`the user refused the ${tool} to "${path}"; it stays unchanged, so stop and explain instead of working around it`)
    case 'cancelled': throw new WriteConsentRefusedError(`approval for the ${tool} to "${path}" was cancelled`)
    case 'unavailable': throw new WriteConsentRefusedError(`the ${tool} to "${path}" requires approval, but no approval channel is available`)
  }
}
