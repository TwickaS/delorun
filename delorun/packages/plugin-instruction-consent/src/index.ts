/**
 * @delorun/plugin-instruction-consent: the provider of Delorun's instruction-layer
 * consent. An instruction-layer file — a skill, a preset or an `AGENTS.md` —
 * is text that loads as instructions in every future chat of its scope, so
 * Delorun's contract requires a model-authored write to one to ask the person
 * first, with its diff. The mutating tools (`write`, `edit`, `apply_patch`)
 * consult the optional `writeConsent` service of the
 * `@deepseek-ai/dsh-tool-fs` consent seam before a mutation commits; this
 * plugin's review classifies the target ([`./classify.ts`](./classify.ts)) and
 * asks, with the effect text and the diff verbatim, exactly when the target is
 * an instruction-layer file. A declined ask leaves the file unchanged, and a
 * target that is no instruction-layer file never asks.
 *
 * The `@deepseek-ai/dsh-sandbox-policy` session-mode seam's one provider is
 * the full-access consent of `@delorun/plugin-permission-defaults`: this
 * plugin takes no part of that slot, because a guard that refuses no switch
 * would prove nothing the seam's own spec does not already prove.
 *
 * Every registration sits behind the C16 switch `instruction_layer_consent`
 * ([`Config.enabled`]), off by default: off, or without a mounted provider, a
 * write commits exactly as upstream does.
 *
 * The plugin's second consent, behind the C16 switch
 * `approved_plugin_write_consent` ([`Config.approvedPluginWrites`]), off by
 * default, asks with Changes' protection on before the agent's first write
 * in a chat to the folder of a plugin the person approved under Changes, and
 * refuses a write into the profile's active directories in either protection
 * setting ([`./plugin-folders.ts`](./plugin-folders.ts)).
 * @module @delorun/plugin-instruction-consent
 */
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { loadProfileDirectory, PROFILE_PATCH_FILENAME, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { resolveAgentsHome, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { WriteConsentRequest, WriteConsentReview, WriteConsentService } from '@deepseek-ai/dsh-tool-fs'
import z from '@deepseek-ai/schemastery'
import { type CaseProbe, classifyTarget, type CompositionFile, createCaseProbe, type Homes, reviewNote } from './classify.ts'
import { askBeforePluginWrites } from './plugin-folders.ts'

export {
  classifyTarget, createCaseProbe, INSTRUCTION_FILE_NAMES, probeCaseInsensitive, PROJECT_SKILLS_DIRS, reviewNote,
} from './classify.ts'
export type { CaseProbe, ClassifyOptions, CompositionFile, CompositionLayer, Homes, InstructionLayerTarget } from './classify.ts'
export { activeRoot, approvedPluginFolders, callDiff, lands, pluginOfTarget, pluginWriteAsk } from './plugin-folders.ts'
export type { ConsentProfile, PluginFolders } from './plugin-folders.ts'

/** The plugin's name in the loader's diagnostics. */
export const name = 'instruction-consent'

/** The plugin's configuration. */
export interface Config {
  /**
   * C16 switch `instruction_layer_consent`: whether the plugin provides the
   * `writeConsent` service, whose review asks before a model-authored write to
   * an instruction-layer file commits. Off, the parity value and the default,
   * the plugin provides nothing and every write commits exactly as upstream
   * does. Delorun's composition turns it on.
   */
  readonly enabled: boolean
  /**
   * C16 switch `approved_plugin_write_consent`: whether, with Changes'
   * protection on, the agent's first write in a chat to the folder of a plugin
   * the person approved under Changes asks first, naming the plugin and
   * carrying the diff, and whether a write into the profile's active
   * directories is refused in either protection setting. Off, the parity value
   * and the default, the plugin registers nothing for it and such a write
   * commits exactly as upstream does. Delorun's composition turns it on.
   */
  readonly approvedPluginWrites: boolean
}

/** Validated configuration. The defaults are the parity values. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  approvedPluginWrites: z.boolean().default(false),
})

/**
 * The composition files the profile launcher reads for one profile, in the order `readProfilePatches` of
 * `@deepseek-ai/dsh-app-boot` applies them: each selected bundle's declared patch files, the profile's own
 * `cordis.patch.yml`, and the home's `cordis.patch.yml`. The bundle files come from the launcher's own
 * `loadProfileDirectory`, read again on every call, so a bundle the plugin manager adds is a bundle this list names.
 * @param context - the launcher's profile facts (`ctx.profileContext`).
 * @returns the composition files with the layer each supplies.
 * @throws the launcher's error when the profile manifest cannot be read; the consent seam then refuses the write.
 */
export function compositionFiles(context: ProfileContext): CompositionFile[] {
  const bundles = loadProfileDirectory(name, context.dir, context.installAnchor, { userLayer: false })
  return [
    ...bundles.layers.flatMap(layer => layer.patchPaths.map((path): CompositionFile => ({ path, layer: 'bundle' }))),
    { path: context.patchPath, layer: 'profile' },
    { path: join(context.home, PROFILE_PATCH_FILENAME), layer: 'home' },
  ]
}

/**
 * The `writeConsent` provider: the review that asks before a model-authored
 * write to an instruction-layer file commits. A target that is no
 * instruction-layer file needs no consent, and the tools run it exactly as
 * upstream runs it.
 *
 * The roots come from the code that reads them on every review: the skill
 * roots from the mounted skill providers (`ctx.skills.configuredRoots()`), so
 * a directory a deployment configured for its skills — a `customSkillDirs`
 * entry, say — is a directory this review asks about, and the composition
 * files from the profile launcher (`ctx.profileContext`, see
 * {@link compositionFiles}). The review resolves links and probes each
 * directory's case sensitivity once per instance.
 */
export class InstructionConsent extends Service implements WriteConsentService {
  /** No services: the review reads the skill registry and the profile facts opportunistically. */
  static inject = []

  /** The case-sensitivity probe this instance remembers its answers in. */
  private readonly caseProbe: CaseProbe = createCaseProbe()

  /**
   * The homes as the workspace instruction loader resolves them: once, when it mounts, from the environment its row
   * cannot override. The review counts them beside the homes the environment names when it runs.
   */
  private readonly mountHomes: Homes = { dshHome: resolveDshHome(), agentsHome: resolveAgentsHome() }

  /**
   * @param ctx - the plugin context.
   */
  constructor(ctx: Context) {
    super(ctx, 'writeConsent')
  }

  /**
   * Classify one pending mutation.
   * @param request - the tool, the resolved target path and the tool's diff.
   * @returns `{ required: true, note, grants }` when the target is an
   *   instruction-layer file — the note names the effect of that scope and
   *   carries the diff verbatim, and `grants` is `workspace-management`, so a
   *   Host may keep the granting answer for the home's own computer — or
   *   undefined when the write proceeds without asking.
   * @throws the filesystem or launcher error when the target or a root cannot be resolved; the seam then refuses the
   *   write.
   */
  review(request: WriteConsentRequest): WriteConsentReview | undefined {
    const profile = this.ctx.get('profileContext')
    const target = classifyTarget(request.path, {
      skillRoots: this.ctx.get('skills')?.configuredRoots() ?? [],
      ...profile === undefined ? {} : { compositionFiles: compositionFiles(profile) },
      homes: [this.mountHomes],
      caseInsensitive: this.caseProbe,
    })
    if (target === undefined) return undefined
    return { required: true, note: reviewNote(target, request.diff), grants: 'workspace-management' }
  }
}

/**
 * Mount the plugin. With `enabled` on, it provides the `writeConsent` service
 * the mutating tools consult before a mutation commits; off — the parity
 * value — it provides nothing, so `ctx.get('writeConsent')` answers
 * `undefined`. With `approvedPluginWrites` on, it asks with protection on
 * before the first write in a chat to an approved plugin's folder and refuses
 * one into the profile's active directories; off, it registers nothing for
 * them. With both off every write commits exactly as upstream does. The
 * session-mode guard is not this plugin's to provide: its one slot belongs to
 * the full-access consent of `@delorun/plugin-permission-defaults`.
 * @param ctx - the plugin context.
 * @param config - the switches, defaulted by the schema above.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.enabled) new InstructionConsent(ctx)
  if (config.approvedPluginWrites) askBeforePluginWrites(ctx)
}
