/**
 * The instruction-layer consent seam shared by every filesystem write: the
 * intent waterfall a mutating tool emits before its mutation commits
 * (`fs/write-intent`, `fs/edit-intent`, `fs/delete-intent`) consults an
 * optional `writeConsent` service with the resolved target. A review that
 * requires consent asks through `ctx.approval` with the review's note as the
 * request text; a refusal leaves the file unchanged. Without the service, or
 * with a review that does not require consent, the tools behave exactly as
 * before.
 *
 * The seam sits at the intent, not at a tool: every fs writer of the tree —
 * `write`, `edit`, `apply_patch` and `str_replace_editor` — emits one intent
 * per target it mutates, so a patch's second file and a tool that never called
 * the seam before are reviewed like the first one.
 * @module @deepseek-ai/dsh-tool-fs/consent
 */

import type { Context } from '@deepseek-ai/cordis'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { ApprovalGrant } from '@deepseek-ai/dsh-user-approval'

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
  /** The mutating tool whose emit asked. */
  tool: WriteConsentTool
  /**
   * The resolved target's display path — the absolute path the mutation would write, so an `apply_patch`
   * that names several files presents each of them, one review per target.
   */
  path: string
  /** The tool's diff representation, omitted when the target is new or the tool carries none. */
  diff?: WriteConsentDiff
}

/**
 * One review verdict. A verdict that requires consent may name what allowing the write grants, which the approval
 * request carries as its `grants` marker.
 */
export type WriteConsentReview =
  | { required: false }
  | { required: true; note: string; grants?: ApprovalGrant }

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
  /** `str_replace_editor`: the full text a `create` writes. */
  file_text?: unknown
  /** `str_replace_editor`: the literal text `str_replace` replaces. */
  old_str?: unknown
  /** `str_replace_editor`: the replacement text of `str_replace` or `insert`. */
  new_str?: unknown
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

/**
 * The diff representation one dispatch carries, from the tool's own arguments.
 *
 * The target comes from the intent, so this only describes the change for the note: a tool whose arguments this
 * map does not know presents no diff rather than a wrong one, and the review still asks.
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
    case 'str_replace_editor':
      // `create` writes a whole file, `str_replace` and `insert` change text inside one; a `view` never reaches here.
      return typeof args.file_text === 'string'
        ? { old: null, new: args.file_text }
        : { old: typeof args.old_str === 'string' ? args.old_str : '', new: typeof args.new_str === 'string' ? args.new_str : '' }
    default:
      return undefined
  }
}

/**
 * The targets one call has already been approved for. A patch emits an intent twice per target — once while it
 * preflights the whole patch and once when it commits that target — and both name the same change, so the person is
 * asked once per file the call would change.
 */
const approvedTargets = new WeakMap<ToolExecution, Set<string>>()

/**
 * The consent gate one intent emission passes through before the mutation
 * executes: consult the optional `writeConsent` service, ask for consent when
 * the review requires it, and throw the typed refusal otherwise. Without the
 * service, or on a verdict that does not require consent, nothing happens.
 * @param ctx - the plugin context whose optional `writeConsent` and
 *   `approval` services are consulted.
 * @param target - the resolved target the mutation would write.
 * @param actor - the tool execution that emitted the intent, whose name and arguments the review presents; absent
 *   for an emission no tool made, which no consent service reviews.
 * @throws WriteConsentRefusedError when the ask is refused, cancelled,
 *   unanswerable, or no approval service or agent can carry it.
 */
export async function reviewWriteConsent(
  ctx: Context, target: FsTarget, actor: object | undefined,
): Promise<void> {
  const consent = ctx.get('writeConsent')
  if (consent === undefined) return
  if (actor === undefined) return
  const exec = actor as ToolExecution
  const tool = exec.name
  const args = (exec.arguments ?? {}) as WriteConsentArgs
  const path = target.displayPath
  const key = `${tool}:${String(target.targetKey)}`
  if (approvedTargets.get(exec)?.has(key) === true) return
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
    ...verdict.grants !== undefined ? { grants: verdict.grants } : {},
    ...exec.signal ? { signal: exec.signal } : {},
  })
  switch (outcome) {
    case 'allowed-once': {
      const granted = approvedTargets.get(exec) ?? new Set<string>()
      granted.add(key)
      approvedTargets.set(exec, granted)
      return
    }
    case 'rejected': throw new WriteConsentRefusedError(`the user refused the ${tool} to "${path}"; it stays unchanged, so stop and explain instead of working around it`)
    case 'cancelled': throw new WriteConsentRefusedError(`approval for the ${tool} to "${path}" was cancelled`)
    case 'unavailable': throw new WriteConsentRefusedError(`the ${tool} to "${path}" requires approval, but no approval channel is available`)
  }
}

/**
 * Put the consent gate in front of every filesystem intent, so a mutation is reviewed by what it writes rather than
 * by which tool wrote it: each intent of each target a call mutates passes the review before the mutation's own
 * policy runs. The listener is prepended because the intent waterfall has a single decision slot — a policy that
 * occupies it without calling `next()` must not be able to skip the consent.
 * @param ctx - the plugin context whose intents are gated.
 */
export function applyWriteConsent(ctx: Context): void {
  // One registration per event: each intent carries its own decision type, so the handler is typed per event rather
  // than through a union of names that would erase it.
  /**
   * Review one intent before the mutation it guards runs.
   * @param target - the resolved target the mutation would write.
   * @param actor - the tool execution that emitted the intent.
   * @param next - the waterfall's default decision.
   * @returns the decision the waterfall continues with.
   */
  const gate = async <T>(target: FsTarget, actor: object | undefined, next: () => T | Promise<T>): Promise<T> => {
    await reviewWriteConsent(ctx, target, actor)
    return await next()
  }
  ctx.on('fs/write-intent', gate, true)
  ctx.on('fs/edit-intent', gate, true)
  ctx.on('fs/delete-intent', gate, true)
}
