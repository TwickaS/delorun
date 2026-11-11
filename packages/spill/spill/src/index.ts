/**
 * Service Definition for the spill storage capability seam (`ctx.spillStore`): an abstract service defining WHAT a
 * spill backend does — persist oversized text and return a model-facing
 * locator plus retrieval guidance — without saying HOW. Implementations
 * subclass {@link SpillStore} and register as the `spillStore` service;
 * `@deepseek-ai/dsh-spill-local` (host filesystem) is the first.
 *
 * The Service Definition is deliberately minimal: `saveText`, plus the optional `sessionDirectory` that tells read
 * tools which local directory one session's artifacts live in. It owns NO
 * retention policy (that is `@deepseek-ai/dsh-output-retention`), NO tool-result
 * replacement (that is `@deepseek-ai/dsh-spill-policy`), and NO retrieval or
 * search API. The backend supplies the locator and retrieval hint appropriate
 * for its storage substrate.
 *
 * @module @deepseek-ai/dsh-spill
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { SaveTextSpill, SpillRef } from './types.ts'

export { SpillLocator } from './types.ts'
export type { SaveTextSpill, SpillOwner, SpillRef, SpillSource } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    spillStore: SpillStore
  }
}

/**
 * Abstract spill storage service. Subclass, implement {@link saveText}, and load
 * the subclass as a plugin — it registers as `ctx.spillStore` (one
 * implementation per context; loading a second throws, cordis' standard
 * duplicate-service behavior).
 *
 * Semantics every implementation must honor:
 * - {@link saveText} persists the FULL `content` verbatim and returns an opaque
 *   locator, exact byte length, and model-facing retrieval guidance.
 * - Storage is scoped by the request's {@link SaveTextSpill.owner} session; the
 *   backend chooses a private (not world-readable) location and a collision-free
 *   name derived from — never equal to — the caller's `suggestedName`.
 * - `saveText` REJECTS on a real storage failure (permissions, ENOSPC, backend
 *   unavailable); the caller decides how to degrade (the spill policy treats a
 *   rejection as best-effort and keeps the inline result).
 */
export abstract class SpillStore extends Service {
  constructor(ctx: Context) {
    super(ctx, 'spillStore')
  }

  /**
   * Persist `input.content` to a session-scoped spill artifact.
   * @param input - the owner, caller-supplied source fields, suggested name, and full text to save.
   * @returns the saved artifact's {@link SpillRef}; rejects on a storage failure.
   */
  abstract saveText(input: SaveTextSpill): Promise<SpillRef>

  /**
   * The local directory that holds every artifact this store saves for one session, which that session's read tools
   * may read where a sandbox provider otherwise protects it. A store without such a directory, the default, returns
   * `undefined`, and no read is granted.
   * @param sessionId - the owning session's header id.
   * @returns the canonical directory, or `undefined`.
   */
  sessionDirectory(sessionId: string): string | undefined {
    void sessionId
    return undefined
  }
}

/**
 * The directories a read tool running for one session may read inside a sandbox provider's tool-readable entries: the
 * mounted spill store's directories for that session and for the session its header names as `parentSession`, such as
 * a subagent's delegating session. A fork records no parent session, so a forked session is not granted the spill files
 * its inherited log names, and earlier ancestors are not included. An agentless call gets none.
 * @param ctx - context whose optional `spillStore` service is read.
 * @param header - the calling session's header, or `undefined` for an agentless call.
 * @returns the grants for `protectedReadGuard` from `@deepseek-ai/dsh-sandbox`.
 */
export function spillReadGrants(ctx: Context, header: { readonly id: string; readonly parentSession?: string } | undefined): string[] {
  const store = ctx.get('spillStore')
  if (header === undefined || store === undefined) return []
  const owners = header.parentSession === undefined ? [header.id] : [header.id, header.parentSession]
  return owners.flatMap(owner => store.sessionDirectory(owner) ?? [])
}

export default SpillStore
