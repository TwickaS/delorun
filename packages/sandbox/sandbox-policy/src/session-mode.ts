/**
 * Per-session sandbox-mode override: the session log as the store. A runtime
 * switch (a UI policy control or test scenario) is recorded as one
 * `sandbox/mode` event on the session it applies to;
 * `effective = projection state ?? the deployment default`, so an override
 * survives restart by replay, two sessions can never see each other's state,
 * and there is no external config store. The event is log-only (the
 * `approval/*` precedent): the policy owner projects the fold into each model
 * request, while enforcing tools report operation-specific boundary markers.
 * EXECUTION honors the same fold through `ctx.sandboxPolicy.resolve()` — it
 * stamps the mode together with the calling session's workspace root onto each
 * capability call, weakest-precedence beneath an escalation grant.
 *
 * The override is policy state shared by every enforcing family (bash and
 * filesystem alike), so it lives here in the policy package rather than in any
 * one capability's seam.
 *
 * @module dsh-sandbox-policy/session-mode
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional {@link SandboxModeGuard} a consent layer may provide; `ctx.get` returns undefined while none is mounted. */
    sandboxModeGuard: SandboxModeGuard
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * The session's sandbox mode was switched — log-only (like `approval/*`;
     * NOT a surface event, carries no `surfaceOp`): durable and replayable,
     * never in the model transcript. The LAST such event is the session's
     * override (folded by the sandboxMode projection unit). `source: 'delegation'` marks
     * an override seeded into a child; an absent source is a runtime switch.
     */
    'sandbox/mode': {
      mode: SandboxMode
      /** Marks an override seeded into a child at delegation. */
      source?: 'delegation'
    }
  }
}

/** Every {@link SandboxMode}, for option advertisement and runtime validation of untrusted mode strings. */
export const SANDBOX_MODES: readonly SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access']

/**
 * The optional mode-switch guard a consent layer mounts on the context: it
 * runs before a `sandbox/mode` event is appended and returns the refusal
 * reason when the switch must not happen, or undefined to allow it.
 */
export interface SandboxModeGuard {
  /**
   * The guard's verdict on one pending switch. The guard reads the switch
   * itself, because a consent depends on both the session it applies to and
   * the mode it would set.
   * @param session - the session the switch applies to.
   * @param mode - the mode the switch would set.
   * @returns the refusal reason when the switch must not happen, or undefined to allow it.
   */
  (session: Session, mode: SandboxMode): string | undefined
}

/**
 * A mode switch a mounted {@link SandboxModeGuard} refused. The message is
 * the guard's reason; the refusal is typed so the caller that surfaces it to
 * the model can branch on the class rather than on message text.
 */
export class SandboxModeRefusedError extends Error {
  /** The guard's refusal reason, worded for the caller that attempted the switch. */
  readonly reason: string

  constructor(reason: string) {
    super(`sandbox-mode switch refused: ${reason}`)
    this.name = 'SandboxModeRefusedError'
    this.reason = reason
  }
}

/**
 * THE write path for a session's sandbox-mode override: appends exactly one
 * `sandbox/mode` event — the switch IS its event; nothing mutates mode state
 * out of band. Takes effect on the session's next confined call (bash or fs)
 * — consumers read the shared projection state.
 * @param session - the session the override belongs to.
 * @param mode - the mode every subsequent confined call in this session runs
 *   under (until the next switch).
 * @param hook - the optional mode-switch guard: returns the refusal reason to
 *   refuse the switch, or undefined to allow it. It reads the session and the
 *   mode being set, so a consent can depend on both. A refusal throws
 *   {@link SandboxModeRefusedError} carrying that reason and appends NO
 *   `sandbox/mode` event.
 */
export function setSandboxMode(session: Session, mode: SandboxMode, hook?: SandboxModeGuard): void {
  if (hook !== undefined) {
    const reason = hook(session, mode)
    if (reason !== undefined) throw new SandboxModeRefusedError(reason)
  }
  session.append('sandbox/mode', { mode })
}
