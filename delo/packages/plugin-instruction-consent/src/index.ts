/**
 * @delo/plugin-instruction-consent: the provider of Delo's instruction-layer
 * consent. An instruction-layer file — a skill, a preset or an `AGENTS.md` —
 * is text that loads as instructions in every future chat of its scope, so
 * Delo's contract requires a model-authored write to one to ask the person
 * first, with its diff. The mutating tools (`write`, `edit`, `apply_patch`)
 * consult the optional `writeConsent` service of the
 * `@deepseek-ai/dsh-tool-fs` consent seam before a mutation commits; this
 * plugin's review classifies the target ([`./classify.ts`](./classify.ts)) and
 * asks, with the effect text and the diff verbatim, exactly when the target is
 * an instruction-layer file. A declined ask leaves the file unchanged, and a
 * target that is no instruction-layer file never asks.
 *
 * The `@deepseek-ai/dsh-sandbox-policy` session-mode seam's one provider is
 * the full-access consent of `@delo/plugin-permission-defaults` (A135): this
 * plugin takes no part of that slot, because a guard that refuses no switch
 * would prove nothing the seam's own spec does not already prove.
 *
 * Every registration sits behind the C16 switch `instruction_layer_consent`
 * ([`Config.enabled`]), off by default: off, or without a mounted provider, a
 * write commits exactly as upstream does.
 * @module @delo/plugin-instruction-consent
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type { WriteConsentRequest, WriteConsentReview, WriteConsentService } from '@deepseek-ai/dsh-tool-fs/src/consent.ts'
import z from '@deepseek-ai/schemastery'
import { classifyTarget, reviewNote } from './classify.ts'

export { classifyTarget, INSTRUCTIONS_FILE, PRESETS_DIR, PROJECT_SKILLS_DIRS, reviewNote } from './classify.ts'
export type { ClassifyOptions, InstructionLayerTarget } from './classify.ts'

/** The plugin's name in the loader's diagnostics. */
export const name = 'instruction-consent'

/** The plugin's configuration. */
export interface Config {
  /**
   * C16 switch `instruction_layer_consent`: whether the plugin provides the
   * `writeConsent` service, whose review asks before a model-authored write to
   * an instruction-layer file commits. Off, the parity value and the default,
   * the plugin provides nothing and every write commits exactly as upstream
   * does. Delo's composition turns it on.
   */
  readonly enabled: boolean
}

/** Validated configuration. The default is the parity value. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
})

/**
 * The `writeConsent` provider: the review that asks before a model-authored
 * write to an instruction-layer file commits. The review classifies the
 * target's path and never touches the filesystem, so it answers at once; a
 * target that is no instruction-layer file needs no consent, and the tools run
 * it exactly as upstream runs it.
 */
export class InstructionConsent extends Service implements WriteConsentService {
  /** No services: the review classifies the target path only. */
  static inject = []

  /**
   * @param ctx - the plugin context.
   */
  constructor(ctx: Context) {
    super(ctx, 'writeConsent')
  }

  /**
   * Classify one pending mutation.
   * @param request - the tool, the resolved target path and the tool's diff.
   * @returns `{ required: true, note }` when the target is an instruction-layer
   *   file — the note names the effect of that scope and carries the diff
   *   verbatim — or undefined when the write proceeds without asking.
   */
  review(request: WriteConsentRequest): WriteConsentReview | undefined {
    const target = classifyTarget(request.path)
    if (target === undefined) return undefined
    return { required: true, note: reviewNote(target, request.diff) }
  }
}

/**
 * Mount the plugin. On, it provides the `writeConsent` service the mutating
 * tools consult before a mutation commits. Off — the parity value — it
 * provides nothing, so `ctx.get('writeConsent')` answers `undefined` and every
 * write commits exactly as upstream does. The session-mode guard is not this
 * plugin's to provide: its one slot belongs to the full-access consent of
 * `@delo/plugin-permission-defaults` (A135).
 * @param ctx - the plugin context.
 * @param config - the switch, defaulted by the schema above.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  new InstructionConsent(ctx)
}