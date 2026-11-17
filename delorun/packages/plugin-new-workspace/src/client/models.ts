/**
 * The model choice of the model screen: the catalogue as the screen reads it, and the model and thinking level a pick
 * stands for. The catalogue comes from the studio's `remote.session` namespace, mapped by {@link viewOfCatalog}.
 * @module @delorun/plugin-new-workspace/client/models
 */
import type { WorkspaceModel } from '../wire.ts'
import type { ModelPick } from './flow.ts'

/** One thinking level a model supports. */
export interface EffortOption {
  /** The level's id, as the session records it. */
  readonly id: string
  /** The level's name. */
  readonly name: string
}

/** One model of one provider. */
export interface ModelOption {
  /** The provider route. */
  readonly provider: string
  /** The provider's name, which groups the model list when several providers are connected. */
  readonly providerName: string
  /** The model's id. */
  readonly id: string
  /** The model's name. */
  readonly name: string
  /** The thinking levels the model supports; empty for a model without any. */
  readonly efforts: readonly EffortOption[]
  /** The level the model uses unless told otherwise. */
  readonly defaultEffort: string | undefined
}

/** The catalogue as the model screen reads it. */
export interface ModelCatalogView {
  /** The home's default model and thinking level, which a new chat starts on. */
  readonly default: { readonly provider: string, readonly model: string, readonly reasoningEffort: string | undefined }
  /** Every model that can be chosen. */
  readonly options: readonly ModelOption[]
}

/** The catalogue as the studio's session remote answers it, in the fields this flow reads. */
export interface RemoteCatalog {
  /** The home's default selection. */
  readonly default: { readonly provider: string, readonly model: string, readonly reasoningEffort?: string }
  /** The models by provider. */
  readonly groups: readonly {
    readonly id: string
    readonly name: string
    readonly models: readonly {
      readonly id: string
      readonly name: string
      readonly reasoning?: { readonly efforts: readonly { readonly id: string, readonly name: string }[], readonly defaultEffort?: string }
    }[]
  }[]
}

/** Whether the catalogue is being read, was read or could not be. */
export type ModelsState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready', readonly catalog: ModelCatalogView }
  | { readonly status: 'unavailable' }

/**
 * Map the studio's catalogue to the view.
 * @param catalog - the catalogue the session remote answered.
 * @returns the view; the home's default model is listed even when no provider group holds it.
 */
export function viewOfCatalog(catalog: RemoteCatalog): ModelCatalogView {
  const options = catalog.groups.flatMap(group => group.models.map((model): ModelOption => ({
    provider: group.id,
    providerName: group.name,
    id: model.id,
    name: model.name,
    efforts: (model.reasoning?.efforts ?? []).map(effort => ({ id: effort.id, name: effort.name })),
    defaultEffort: model.reasoning?.defaultEffort,
  })))
  const { provider, model, reasoningEffort } = catalog.default
  const listed = options.some(option => option.provider === provider && option.id === model)
  return {
    default: { provider, model, reasoningEffort },
    options: listed ? options : [{ provider, providerName: provider, id: model, name: model, efforts: [], defaultEffort: reasoningEffort }, ...options],
  }
}

/** The model and level a pick, or the home's default when nothing was picked, stands for. */
export interface Selection {
  /** The model chosen. */
  readonly option: ModelOption
  /** The thinking level in force: the pick's, else the home's default for its own default model, else the model's default. */
  readonly effort: string | undefined
}

/**
 * Resolve a pick against the catalogue.
 * @param catalog - the catalogue.
 * @param pick - the model picked, or undefined while the workspace follows the home's default.
 * @returns the model and level, or undefined when the picked model is not in the catalogue.
 */
export function selectionOf(catalog: ModelCatalogView, pick: ModelPick | undefined): Selection | undefined {
  const { provider, model } = pick ?? catalog.default
  const option = catalog.options.find(candidate => candidate.provider === provider && candidate.id === model)
  if (option === undefined) return undefined
  if (pick !== undefined) return { option, effort: pick.effort ?? option.defaultEffort }
  return { option, effort: catalog.default.reasoningEffort ?? option.defaultEffort }
}

/**
 * The model a workspace keeps, which is stored whatever it is so the workspace keeps it if the home's default changes.
 * @param catalog - the catalogue, or undefined when it could not be read.
 * @param pick - the model picked, or undefined while the workspace follows the home's default.
 * @returns the model to store, or undefined when there is nothing to store because the catalogue is unknown.
 */
export function modelToStore(catalog: ModelCatalogView | undefined, pick: ModelPick | undefined): WorkspaceModel | undefined {
  if (catalog === undefined) return undefined
  const selection = selectionOf(catalog, pick)
  if (selection === undefined) return undefined
  const { option, effort } = selection
  return { provider: option.provider, model: option.id, ...effort === undefined ? {} : { reasoningEffort: effort } }
}
