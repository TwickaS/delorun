/**
 * The optional external-delegation consent seam (`ctx.delegationConsent`). An
 * external provider — one without `prepareContinuable` — runs its child as a
 * separate program that the harness's sandbox and approval prompts do not
 * govern. When a plugin provides this service, the runtime reviews every
 * external start before the provider's `start` runs, and the delegation tools
 * take the model-facing description of an external provider from it. Without
 * the service, starts and descriptions are exactly as before, unless a Loader
 * row whose plugin declares a provider is not running: then no external
 * provider starts.
 *
 * @module @deepseek-ai/dsh-subagent/consent
 */

import { FiberState, type Context } from '@deepseek-ai/cordis'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SubagentError } from './error.ts'
import type { SubagentSafetyLevel } from './safety-level.ts'
import type { SubagentResult, SubagentRun } from './types.ts'

/** The longest delay a Node.js timer accepts, in milliseconds. */
const MAX_TIMER_DELAY_MS = 2_147_483_647

/** The facts of one external start, reviewed before the provider runs. */
export interface ExternalDelegationReview {
  /** The registered provider name the start selects. */
  readonly provider: string
  /** The exact live parent agent that delegates. */
  readonly parent: Agent
  /** The absolute directory the external child would start in. */
  readonly cwd: string
  /** The display label of the delegated task, when the caller gave one. */
  readonly label?: string | undefined
  /** Cancellation of the start; an ask waiting for a person ends with it. */
  readonly signal: AbortSignal
}

/**
 * The review's answer. Only `allow` starts the provider; `timeoutMs`, when
 * given, ends the run that long after it starts. Any other value refuses.
 */
export type ExternalDelegationVerdict =
  | { readonly kind: 'allow'; readonly timeoutMs?: number | undefined }
  | { readonly kind: 'refuse'; readonly reason: string }

/**
 * Optional consent over external delegation, read with
 * `ctx.get('delegationConsent')`. A deployment that composes none starts every
 * external provider unreviewed and keeps the delegation tools' own wording. A
 * provider's plugin module exports {@link DELEGATION_CONSENT_PROVIDER_EXPORT}
 * as `true`, so a start refuses while that row is not running.
 */
export interface DelegationConsentService {
  /**
   * The model-facing description of a delegation tool whose provider is
   * external, replacing the tool's generic opening sentences.
   * @param provider - the registered provider name.
   * @returns the description, or undefined to keep the tool's own.
   */
  describe?(provider: string): string | undefined
  /**
   * Review one external start. The runtime starts the provider only on
   * `allow`; a refusal, any other answer and a throw start nothing.
   * @param review - the facts of the start.
   * @returns the verdict.
   */
  review(review: ExternalDelegationReview): Promise<ExternalDelegationVerdict>
  /**
   * The safety level for the next run of one external provider, read at every start so a changed level applies to
   * the next run. A provider with no answer uses its own configured permission mode.
   * @param provider - the registered provider name.
   * @returns the level, or undefined to keep the provider's configured mode.
   */
  permissionLevel?(provider: string): SubagentSafetyLevel | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * Optional external-delegation consent; absent unless a plugin provides
     * it. Consumers read it with `ctx.get('delegationConsent')`.
     */
    delegationConsent: DelegationConsentService
  }
}

/**
 * The name of the module export by which a plugin declares that its row may provide `delegationConsent`. A provider
 * module exports it as `true`; {@link findDelegationConsent} waits for the rows that declare it and refuses a start
 * while one of them is not running.
 */
export const DELEGATION_CONSENT_PROVIDER_EXPORT = 'providesDelegationConsent'

/**
 * Whether a Loader row starts and its imported plugin declares a `delegationConsent` provider. A `disabled` expression
 * that throws counts as disabled, because such a row does not start.
 * @param entry - the row, after its module import settled.
 * @param unwrap - the Loader's export normalization.
 * @returns true when the row is enabled and its plugin exports {@link DELEGATION_CONSENT_PROVIDER_EXPORT} as `true`.
 */
function declaresConsent(entry: Entry, unwrap: (exports: unknown) => unknown): boolean {
  try {
    if (entry.disabled || entry.moduleNamespace === undefined) return false
  } catch (_failedExpression) {
    // The Loader reports the expression's failure for the row, which then provides nothing.
    return false
  }
  const plugin = unwrap(entry.moduleNamespace)
  return typeof plugin === 'object' && plugin !== null && Reflect.get(plugin, DELEGATION_CONSENT_PROVIDER_EXPORT) === true
}

/**
 * Find the `delegationConsent` service for one external start, independent of the order in which a Loader starts its
 * rows. A registered service is returned at once. Under a Loader, the lookup first waits for every row's module import,
 * then for every enabled row whose plugin declares a provider to settle.
 * @param ctx - the runtime's context.
 * @param provider - the registered provider name the start selects, named in a refusal.
 * @returns the service, or undefined when no row declares a provider or every declaring row runs without providing
 *   one, as a provider whose own switch is off does.
 * @throws {SubagentError} `DELEGATION_CONSENT_UNAVAILABLE` when a declaring row is not running, so nothing starts
 *   unreviewed.
 */
export async function findDelegationConsent(ctx: Context, provider: string): Promise<DelegationConsentService | undefined> {
  const loader = ctx.get('loader')
  if (ctx.get('delegationConsent') !== undefined || loader === undefined) return ctx.get('delegationConsent')
  let imports = [...loader.entries()].flatMap(entry => entry._initTask ?? [])
  while (imports.length > 0) {
    await Promise.allSettled(imports)
    imports = [...loader.entries()].flatMap(entry => entry._initTask ?? [])
  }
  const declaring = [...loader.entries()].filter(entry => declaresConsent(entry, exports => loader.unwrapExports(exports)))
  await Promise.allSettled(declaring.map(entry => entry.fiber?.await()))
  const consent = ctx.get('delegationConsent')
  const stopped = declaring.filter(entry => entry.fiber?.state !== FiberState.ACTIVE).map(entry => entry.id)
  if (consent !== undefined || stopped.length === 0) return consent
  throw new SubagentError(
    `the row ${stopped.join(', ')} declares the external-agent consent but is not running, so "${provider}" was not started. `
      + 'Fix the consent row\'s failure and start again.',
    'DELEGATION_CONSENT_UNAVAILABLE',
  )
}

/**
 * Ask the consent about one external start and throw unless it allows it.
 * @param consent - the composed consent service.
 * @param review - the facts of the start.
 * @returns the run time limit in milliseconds the consent set, or undefined.
 * @throws {SubagentError} `DELEGATION_CONSENT_REFUSED` with the refusal's reason, or
 *   `DELEGATION_CONSENT_FAILED` when the review threw or answered with anything but a verdict.
 */
export async function assertExternalDelegationConsent(
  consent: DelegationConsentService,
  review: ExternalDelegationReview,
): Promise<number | undefined> {
  let verdict: ExternalDelegationVerdict
  try {
    verdict = await consent.review(review)
  } catch (error: unknown) {
    throw new SubagentError(
      `the consent for starting "${review.provider}" could not be decided, so nothing was started`,
      'DELEGATION_CONSENT_FAILED',
      { cause: error },
    )
  }
  if (verdict.kind === 'refuse' && typeof verdict.reason === 'string' && verdict.reason !== '') {
    throw new SubagentError(verdict.reason, 'DELEGATION_CONSENT_REFUSED')
  }
  if (verdict.kind !== 'allow') {
    throw new SubagentError(
      `the consent for starting "${review.provider}" refused without a reason, so nothing was started`,
      'DELEGATION_CONSENT_REFUSED',
    )
  }
  const { timeoutMs } = verdict
  if (timeoutMs !== undefined && !(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= MAX_TIMER_DELAY_MS)) {
    throw new SubagentError(
      `the consent for starting "${review.provider}" set an invalid run time limit, so nothing was started`,
      'DELEGATION_CONSENT_FAILED',
    )
  }
  return timeoutMs
}

/**
 * Bound one external run's wall-clock time. When the limit passes first, the
 * run is disposed — the provider tears its process down — and the result is
 * the provider's own final output with `stopReason: 'error'` and a diagnostic
 * that names the limit, so the parent learns why the run ended; a capture
 * failure after that stop leaves the diagnostic with no output. Disposal and
 * a result that settles first, a capture failure included, clear the timer.
 * @param run - the provider's published run.
 * @param timeoutMs - the limit in milliseconds, a positive safe integer within the timer range.
 * @param provider - the provider name the diagnostic names.
 * @returns the bounded run.
 */
export function limitExternalRunTime(run: SubagentRun, timeoutMs: number, provider: string): SubagentRun {
  let timer: ReturnType<typeof setTimeout> | undefined
  const clear = (): void => {
    clearTimeout(timer)
    timer = undefined
  }
  const result = new Promise<SubagentResult>((resolve, reject) => {
    let expired = false
    timer = setTimeout(() => {
      expired = true
      timer = undefined
      const minutes = Math.round(timeoutMs / 60_000)
      const limit = minutes >= 1 ? `${minutes} minute${minutes === 1 ? '' : 's'}` : `${timeoutMs} ms`
      const diagnostic = `The "${provider}" run was stopped after ${limit}, the time limit for an external agent run. `
        + 'Its work so far may be incomplete; check the files it changed before relying on them.'
      // The runtime disposes the run again after this result and reports a teardown failure from that call.
      void run.dispose().catch(() => undefined).then(() => run.result).then(
        (stopped) => { resolve({ output: stopped.output, stopReason: 'error', diagnostic }) },
        // A capture failure after the stop leaves no output to keep; the limit's diagnostic is the result.
        () => { resolve({ output: [], stopReason: 'error', diagnostic }) },
      )
    }, timeoutMs)
    run.result.then((settled) => {
      if (expired) return
      clear()
      resolve(settled)
    }, (error: unknown) => {
      if (expired) return
      clear()
      reject(error)
    })
  })
  return {
    id: run.id,
    result,
    dispose(): Promise<void> {
      clear()
      return run.dispose()
    },
  }
}
