/**
 * Which layout defaults apply to a chat, and which settings a change writes, by the person's chosen scope: the whole studio,
 * one workspace, or one chat. The narrowest scope that has a value wins: a chat's own arrangement over its workspace's defaults
 * over the studio's. Pure functions, so every rule is checked without a store.
 * @module @delorun/plugin-multiview/store/scope
 */
import type { MultiviewSettings, RememberScope, WorkspaceLayoutDefaults } from '../config.ts'
import { shapeProblem, type LayoutChoiceId, type LayoutShape, type MainSide, type StackStyle } from '../layout/index.ts'

/** The defaults that apply where a chat lives. */
export interface ResolvedDefaults {
  /** The layout a new Multiview starts with. */
  readonly layout: LayoutChoiceId
  /** "Yours", if one is saved for the workspace or the studio. */
  readonly shape: LayoutShape | undefined
  /** Where "Yours" comes from, if it is saved. */
  readonly shapeScope: Exclude<RememberScope, 'chat'> | undefined
  readonly mainSide: MainSide
  readonly stackStyle: StackStyle
}

/** A shape read from the settings, or undefined when there is none or it is not well formed. */
function validShape(shape: LayoutShape | null | undefined): LayoutShape | undefined {
  if (shape === null || shape === undefined) return undefined
  return shapeProblem(shape) === undefined ? shape : undefined
}

/**
 * The defaults for a chat in a workspace: each field from the workspace's own defaults when it has one, else the studio's.
 * @param settings - the Multiview settings.
 * @param workspace - the chat's workspace id, if it has one.
 * @returns the defaults; `yours` without a saved shape reads as Auto.
 */
export function resolveDefaults(settings: MultiviewSettings, workspace: string | undefined): ResolvedDefaults {
  const own: WorkspaceLayoutDefaults | undefined = workspace === undefined ? undefined : settings.workspaceLayouts[workspace]
  const workspaceShape = validShape(own?.yours)
  const studioShape = validShape(settings.yours)
  const shape = workspaceShape ?? studioShape
  const layout = own?.defaultLayout ?? settings.defaultLayout
  return {
    layout: layout === 'yours' && shape === undefined ? 'auto' : layout,
    shape,
    shapeScope: workspaceShape !== undefined ? 'workspace' : studioShape !== undefined ? 'studio' : undefined,
    mainSide: own?.mainSide ?? settings.mainSide,
    stackStyle: own?.stackStyle ?? settings.stackStyle,
  }
}

/** The fields of the settings a layout default lives in. */
export type DefaultField = 'defaultLayout' | 'yours' | 'mainSide' | 'stackStyle'

/** The values of {@link DefaultField}, by field. */
export interface DefaultValues {
  readonly defaultLayout?: LayoutChoiceId
  readonly yours?: LayoutShape | null
  readonly mainSide?: MainSide
  readonly stackStyle?: StackStyle
}

/** The settings writes one change makes. */
export type SettingsPatch = Partial<Pick<MultiviewSettings, DefaultField | 'workspaceLayouts'>>

/**
 * Plan the writes that store defaults at a scope. The studio scope writes the studio's fields; the workspace scope writes the
 * workspace's entry of `workspaceLayouts` (the studio scope when the chat is in no workspace); the chat scope writes nothing,
 * because the chat's own state holds its arrangement.
 * @param settings - the settings now.
 * @param scope - where the change applies.
 * @param workspace - the chat's workspace id, if any.
 * @param values - the defaults to store.
 * @returns the settings to write, empty for the chat scope.
 */
export function planDefaults(settings: MultiviewSettings, scope: RememberScope, workspace: string | undefined, values: DefaultValues): SettingsPatch {
  const target = effectiveScope(scope, workspace)
  if (target === 'chat') return {}
  if (target === 'studio') return { ...values }
  const key = workspace!
  const entry: WorkspaceLayoutDefaults = { ...settings.workspaceLayouts[key], ...values }
  return { workspaceLayouts: { ...settings.workspaceLayouts, [key]: entry } }
}

/**
 * The scope a change applies at: the workspace scope falls back to the studio for a chat in no workspace.
 * @param scope - the person's setting.
 * @param workspace - the chat's workspace id, if any.
 * @returns the scope used.
 */
export function effectiveScope(scope: RememberScope, workspace: string | undefined): RememberScope {
  return scope === 'workspace' && workspace === undefined ? 'studio' : scope
}

/**
 * The writes that clear "Yours" at every scope the chat sees and make Auto the default there.
 * @param settings - the settings now.
 * @param workspace - the chat's workspace id, if any.
 * @returns the settings to write.
 */
export function planResetToAuto(settings: MultiviewSettings, workspace: string | undefined): SettingsPatch {
  const patch: { -readonly [K in keyof SettingsPatch]: SettingsPatch[K] } = { defaultLayout: 'auto', yours: null }
  const own = workspace === undefined ? undefined : settings.workspaceLayouts[workspace]
  if (workspace !== undefined && own !== undefined) {
    const { defaultLayout: _layout, yours: _yours, ...rest } = own
    const layouts = { ...settings.workspaceLayouts }
    if (Object.keys(rest).length === 0) delete layouts[workspace]
    else layouts[workspace] = rest
    patch.workspaceLayouts = layouts
  }
  return patch
}
