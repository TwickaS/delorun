/**
 * The model providers `delorun setup` sets up (contract C11, "Model providers"), and the profile rows each writes.
 * DeepSeek runs on upstream's DeepSeek adapter, the profile's `llm-deepseek` row; every other provider is a route of
 * upstream's pi-ai adapter, the `llm-pi-ai` row: a route of pi-ai's installed catalogue, or `openai-compatible`, a route
 * setup declares with the endpoint and model the person gives. The rows are written in the form the studio's Settings
 * → Models saves them, so the studio shows and edits what setup wrote. A typed key is stored under the provider's
 * credential reference, the environment variable its adapter reads, and the route names that reference.
 *
 * @module @delorun/cli/setup/providers
 */
import { fileURLToPath } from 'node:url'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { SETUP_DEFAULT_CREDENTIAL_VARIABLE, SETUP_PROVIDER_IDS, type ModelProviderAnswer, type SetupProviderId } from '@delorun/contract-setup-answers'
import { readPatchRow, updateRowConfig, type InheritedRow } from '@delorun/setup-apply'

/**
 * The request that checks a key: `deepseek` is DeepSeek's model listing through upstream's listing client; `anthropic`
 * sends the key in `x-api-key` with `anthropic-version`; `bearer` in `Authorization: Bearer`; `google` in
 * `x-goog-api-key`. Each is a `GET` of a metadata endpoint that answers only an accepted key, never a completion.
 */
export type KeyCheckKind = 'deepseek' | 'anthropic' | 'bearer' | 'google'

/** How setup checks a provider's key. */
export interface KeyCheckSpec {
  /** The request's authentication. */
  readonly kind: KeyCheckKind
  /** The path the request appends to the provider's base URL, with its query. */
  readonly path: string
}

/** How the profile reaches a provider. */
export type ProviderAdapter =
  /** Upstream's DeepSeek adapter, the `llm-deepseek` row. */
  | 'deepseek'
  /** A route of pi-ai's installed catalogue on the `llm-pi-ai` row; the catalog supplies the endpoint and models. */
  | 'catalog'
  /** A route setup declares on the `llm-pi-ai` row, with the endpoint and the model the person gives. */
  | 'custom'

/** One provider setup offers. */
export interface SetupProvider {
  /** The provider's id in the answers, which is also its route. */
  readonly id: SetupProviderId
  /** The name setup shows. */
  readonly label: string
  /** How the profile reaches it. */
  readonly adapter: ProviderAdapter
  /** The credential reference a typed key is stored under, and the variable setup reads the key from by default. */
  readonly keyVariable: string
  /** How setup checks a key. */
  readonly check: KeyCheckSpec
  /** The provider's page for creating a key; `undefined` when none is named. DeepSeek, OpenAI and xAI refuse automated requests, so their addresses are the ones their documentation gives. */
  readonly keyPage: string | undefined
  /**
   * The model the model question starts on: a current general chat model of the provider's installed catalogue, or for
   * DeepSeek the profile's default; `undefined` for the custom endpoint, whose models setup does not know.
   */
  readonly defaultModel: string | undefined
}

/** The providers setup offers, by id. Each catalog provider's endpoint is read from pi-ai's installed catalogue. */
export const SETUP_PROVIDERS: Readonly<Record<SetupProviderId, SetupProvider>> = {
  'anthropic': { id: 'anthropic', label: 'Anthropic', adapter: 'catalog', keyVariable: 'ANTHROPIC_API_KEY', check: { kind: 'anthropic', path: '/v1/models?limit=1' }, keyPage: 'https://platform.claude.com/settings/keys', defaultModel: 'claude-sonnet-5-5' },
  'deepseek-official': { id: 'deepseek-official', label: 'DeepSeek', adapter: 'deepseek', keyVariable: SETUP_DEFAULT_CREDENTIAL_VARIABLE, check: { kind: 'deepseek', path: '/models' }, keyPage: 'https://platform.deepseek.com/api_keys', defaultModel: 'deepseek-flash' },
  'google': { id: 'google', label: 'Google Gemini', adapter: 'catalog', keyVariable: 'GEMINI_API_KEY', check: { kind: 'google', path: '/models?pageSize=1' }, keyPage: 'https://aistudio.google.com/apikey', defaultModel: 'gemini-3.8-flash' },
  'groq': { id: 'groq', label: 'Groq', adapter: 'catalog', keyVariable: 'GROQ_API_KEY', check: { kind: 'bearer', path: '/models' }, keyPage: 'https://console.groq.com/keys', defaultModel: 'openai/gpt-oss-120b' },
  'mistral': { id: 'mistral', label: 'Mistral', adapter: 'catalog', keyVariable: 'MISTRAL_API_KEY', check: { kind: 'bearer', path: '/v1/models' }, keyPage: 'https://console.mistral.ai/api-keys', defaultModel: 'mistral-large-latest' },
  'moonshotai': { id: 'moonshotai', label: 'Moonshot AI', adapter: 'catalog', keyVariable: 'MOONSHOT_API_KEY', check: { kind: 'bearer', path: '/models' }, keyPage: 'https://platform.kimi.ai/console/api-keys', defaultModel: 'kimi-k3' },
  'openai': { id: 'openai', label: 'OpenAI', adapter: 'catalog', keyVariable: 'OPENAI_API_KEY', check: { kind: 'bearer', path: '/models' }, keyPage: 'https://platform.openai.com/api-keys', defaultModel: 'gpt-6.1-sol' },
  'openai-compatible': { id: 'openai-compatible', label: 'OpenAI-compatible endpoint', adapter: 'custom', keyVariable: 'OPENAI_COMPATIBLE_API_KEY', check: { kind: 'bearer', path: '/models' }, keyPage: undefined, defaultModel: undefined },
  'openrouter': { id: 'openrouter', label: 'OpenRouter', adapter: 'catalog', keyVariable: 'OPENROUTER_API_KEY', check: { kind: 'bearer', path: '/key' }, keyPage: 'https://openrouter.ai/keys', defaultModel: 'anthropic/claude-sonnet-5.5' },
  'together': { id: 'together', label: 'Together AI', adapter: 'catalog', keyVariable: 'TOGETHER_API_KEY', check: { kind: 'bearer', path: '/models' }, keyPage: 'https://api.together.ai/settings/api-keys', defaultModel: 'Qwen/Qwen3.7-Max' },
  'xai': { id: 'xai', label: 'xAI', adapter: 'catalog', keyVariable: 'XAI_API_KEY', check: { kind: 'bearer', path: '/models' }, keyPage: 'https://console.x.ai', defaultModel: 'grok-4.7' },
}

/** The providers in the order setup lists them: by label, so none is placed ahead of another. */
export const PROVIDERS_BY_LABEL: readonly SetupProvider[] = SETUP_PROVIDER_IDS.map(id => SETUP_PROVIDERS[id]).sort((left, right) => left.label.localeCompare(right.label, 'en'))

/**
 * Whether an id from the command line or a document names a provider setup offers.
 * @param id - the id.
 * @returns whether setup offers it.
 */
export function isSetupProviderId(id: string): id is SetupProviderId {
  return (SETUP_PROVIDER_IDS as readonly string[]).includes(id)
}

/**
 * The credential reference a provider answer's route reads its key from.
 * @param answer - the provider answer.
 * @returns the variable a key read from the environment names, or the provider's own for a typed key.
 */
export function credentialReference(answer: ModelProviderAnswer): string {
  return answer.credential.source === 'environment' ? answer.credential.name : SETUP_PROVIDERS[answer.id].keyVariable
}

/** One model a provider serves, as setup lists it. */
export interface ProviderModel {
  /** The model id the profile selects. */
  readonly id: string
  /** Its display name. */
  readonly name: string
}

/** What setup reads from the adapters' installed catalogues. */
export interface ProviderCatalog {
  /**
   * @param id - a DeepSeek or catalog provider.
   * @returns the models its adapter serves, in the catalog's order; DeepSeek's first entry is the profile's default.
   */
  models(id: SetupProviderId): readonly ProviderModel[]
  /**
   * @param id - a catalog provider.
   * @returns the endpoint pi-ai's catalog ships for it.
   * @throws {Error} when the catalog does not list the provider, or lists it without a fixed endpoint.
   */
  baseURL(id: SetupProviderId): string
}

/**
 * Read the installed catalogues: pi-ai's for the catalog providers, the DeepSeek adapter's built-in model list for
 * DeepSeek. Loaded on first use, so a run that never asks about models never loads either package.
 * @returns the catalog.
 */
export async function installedCatalog(): Promise<ProviderCatalog> {
  const [{ builtinProviders, getBuiltinModels, getBuiltinProviders }, { Config }] = await Promise.all([import('@earendil-works/pi-ai/providers/all'), import('@deepseek-ai/dsh-llm-deepseek')])
  const deepSeekModels: readonly ProviderModel[] = Config({}).models.get().map(model => ({ id: model.id, name: model.name ?? model.id }))
  return {
    models(id) {
      if (id === 'deepseek-official') return deepSeekModels
      const builtin = getBuiltinProviders().find(candidate => candidate === id)
      return builtin === undefined ? [] : getBuiltinModels(builtin).map(model => ({ id: model.id, name: model.name }))
    },
    baseURL(id) {
      const baseUrl = builtinProviders().find(candidate => candidate.id === id)?.baseUrl ?? ''
      if (baseUrl === '' || baseUrl.includes('{')) throw new Error(`delorun setup: pi-ai's installed catalogue has no fixed endpoint for ${id}`)
      return baseUrl
    },
  }
}

/** The upstream rows the provider answer writes: their ids in upstream's base bundle. */
export const PROVIDER_ROW_IDS = { defaultModel: 'agent-default-model', deepseek: 'llm-deepseek', piAi: 'llm-pi-ai' } as const

/** The rows {@link writeProviderRows} writes, as upstream's base bundle inserts them. */
export interface ProviderRows {
  /** The default model of new chats. */
  readonly defaultModel: InheritedRow
  /** DeepSeek's adapter. */
  readonly deepseek: InheritedRow
  /** The pi-ai adapter. */
  readonly piAi: InheritedRow
}

/**
 * The provider rows as upstream's base bundle inserts them, which the CLI profile's first bundle is.
 * @param bundlePatch - the bundle's `cordis.patch.yml`; the installed base bundle's by default.
 * @returns the three rows, each with its plugin name and inherited config.
 * @throws {Error} when the bundle's patch does not insert one of them.
 */
export function baseProviderRows(bundlePatch = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-base/cordis.patch.yml'))): ProviderRows {
  const inserted = loadOverlayPatches('delorun setup', bundlePatch).flatMap(patch => patch.insert ?? [])
  const row = (id: string): InheritedRow => {
    const entry = inserted.find(candidate => candidate.id === id)
    const config: unknown = entry?.config ?? {}
    if (entry === undefined || typeof config !== 'object' || config === null || Array.isArray(config)) {
      throw new Error(`delorun setup: ${bundlePatch} inserts no ${id} row, so the model provider answer cannot be written`)
    }
    return { id, name: entry.name, config: { ...config } }
  }
  return { defaultModel: row(PROVIDER_ROW_IDS.defaultModel), deepseek: row(PROVIDER_ROW_IDS.deepseek), piAi: row(PROVIDER_ROW_IDS.piAi) }
}

/**
 * @param value - a parsed YAML value.
 * @returns the value when it is a mapping, otherwise an empty one.
 */
function recordOf(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : {}
}

/**
 * @param config - a row's config.
 * @param key - a key to leave out.
 * @returns the config without the key.
 */
function without(config: Readonly<Record<string, unknown>>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config).filter(([name]) => name !== key))
}

/**
 * The pi-ai route profile of a provider answer, over the profile the route has already: a catalog route names its
 * credential reference; the `openai-compatible` route also declares its protocol, endpoint and the model, which joins
 * the models the route lists already.
 * @param answer - a catalog or custom provider answer.
 * @param current - the route's profile in the profile patch, or an empty one.
 * @returns the route's profile.
 */
function routeProfile(answer: ModelProviderAnswer, current: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const apiKeyEnv = credentialReference(answer)
  if (SETUP_PROVIDERS[answer.id].adapter !== 'custom') return { ...current, apiKeyEnv }
  const listed = Array.isArray(current['models']) ? current['models'] as readonly unknown[] : []
  const model = answer.model as string
  const models = listed.some(entry => recordOf(entry)['id'] === model) ? listed : [...listed, { id: model }]
  return { ...current, displayName: SETUP_PROVIDERS[answer.id].label, apiKeyEnv, api: 'openai-completions', baseURL: answer.baseURL, models }
}

/**
 * Write a provider answer's rows into a profile's patch, in the form Settings → Agent → Models and the model picker save them.
 * DeepSeek with its default variable and model leaves its rows as the bundle inserts them, so the profile matches
 * stock DeepSeek Harness's; another variable sets `apiKeyEnv` on `llm-deepseek`. A pi-ai provider sets its route on
 * `llm-pi-ai`, keeping the routes already there. Every answer sets the default model of new chats, without a reasoning
 * effort, which belongs to the previous model's adapter.
 * @param patchPath - the profile's `cordis.patch.yml`.
 * @param answer - the provider answer.
 * @param rows - the rows as the bundle inserts them; the installed base bundle's by default.
 * @throws {CliError} `EXIT.failed` when the patch is not a YAML patch list; it is left unchanged.
 */
export function writeProviderRows(patchPath: string, answer: ModelProviderAnswer, rows: ProviderRows = baseProviderRows()): void {
  if (SETUP_PROVIDERS[answer.id].adapter === 'deepseek') {
    const apiKeyEnv = credentialReference(answer)
    updateRowConfig(patchPath, rows.deepseek, current => (apiKeyEnv === SETUP_DEFAULT_CREDENTIAL_VARIABLE ? without(current, 'apiKeyEnv') : { ...current, apiKeyEnv }))
  } else {
    updateRowConfig(patchPath, rows.piAi, (current) => {
      const providers = recordOf(current['providers'])
      return { ...current, providers: { ...providers, [answer.id]: routeProfile(answer, recordOf(providers[answer.id])) } }
    })
  }
  updateRowConfig(patchPath, rows.defaultModel, current => (answer.model === null
    ? rows.defaultModel.config
    : { ...without(current, 'reasoningEffort'), provider: answer.id, model: answer.model }))
}

/** The model new chats start on in a profile: its route and model id. */
export interface ModelSelection {
  /** The provider route. */
  readonly provider: string
  /** The model id. */
  readonly model: string
}

/**
 * The model new chats start on in a profile, as its patch selects it: the `agent-default-model` row setup, Settings
 * → Models and the model picker write, or the base bundle's when the patch sets none.
 * @param patchPath - the profile's `cordis.patch.yml`.
 * @param command - the command that starts a refusal's message.
 * @param rows - the rows as the bundle inserts them; the installed base bundle's by default.
 * @returns the selection.
 * @throws {CliError} `EXIT.failed` when the patch is not a YAML patch list.
 */
export function profileModelSelection(patchPath: string, command: string, rows: ProviderRows = baseProviderRows()): ModelSelection {
  const config = { ...rows.defaultModel.config, ...readPatchRow(patchPath, PROVIDER_ROW_IDS.defaultModel, command) }
  return { provider: String(config['provider']), model: String(config['model']) }
}

/**
 * The credential reference a provider route reads its key from in a profile: the `apiKeyEnv` its row names, or the
 * variable setup stores a provider's key under when the row names none.
 * @param patchPath - the profile's `cordis.patch.yml`.
 * @param route - the provider route.
 * @param command - the command that starts a refusal's message.
 * @returns the reference, or `undefined` for a route setup does not offer whose row names none.
 * @throws {CliError} `EXIT.failed` when the patch is not a YAML patch list.
 */
export function routeKeyReference(patchPath: string, route: string, command: string): string | undefined {
  const named = route === 'deepseek-official'
    ? readPatchRow(patchPath, PROVIDER_ROW_IDS.deepseek, command)?.['apiKeyEnv']
    : recordOf(recordOf(readPatchRow(patchPath, PROVIDER_ROW_IDS.piAi, command)?.['providers'])[route])['apiKeyEnv']
  if (typeof named === 'string' && named !== '') return named
  return isSetupProviderId(route) ? SETUP_PROVIDERS[route].keyVariable : undefined
}

/**
 * The provider answer a profile's patch holds, as {@link writeProviderRows} writes it: the provider and model of the
 * `agent-default-model` row, the key reference of the provider's row, and a custom endpoint's base URL. The patch
 * cannot tell a typed key from a variable of the same name, so that choice and a patch without a model row come from
 * the recorded answer.
 * @param patchPath - the profile's `cordis.patch.yml`.
 * @param recorded - the answer in the answers record, or `null` for none.
 * @param rows - the rows as the bundle inserts them; the installed base bundle's by default.
 * @returns the answer, or `recorded` when the patch selects no model or a provider setup does not offer.
 * @throws {CliError} `EXIT.failed` when the patch is not a YAML patch list.
 */
export function readProviderAnswer(patchPath: string, recorded: ModelProviderAnswer | null, rows: ProviderRows = baseProviderRows()): ModelProviderAnswer | null {
  if (readPatchRow(patchPath, PROVIDER_ROW_IDS.defaultModel, 'delorun setup') === undefined) return recorded
  const selection = profileModelSelection(patchPath, 'delorun setup', rows)
  if (!isSetupProviderId(selection.provider)) return recorded
  const provider = SETUP_PROVIDERS[selection.provider]
  const reference = routeKeyReference(patchPath, provider.id, 'delorun setup') ?? provider.keyVariable
  const sameKey = recorded?.id === provider.id && credentialReference(recorded) === reference
  const credential = sameKey ? recorded.credential : reference === provider.keyVariable ? { source: 'prompt' as const } : { source: 'environment' as const, name: reference }
  const baseURL = provider.adapter === 'custom' ? recordOf(recordOf(readPatchRow(patchPath, PROVIDER_ROW_IDS.piAi, 'delorun setup')?.['providers'])[provider.id])['baseURL'] : undefined
  const inherited = rows.defaultModel.config
  const isDefault = provider.adapter === 'deepseek' && selection.provider === inherited['provider'] && selection.model === inherited['model']
  return { id: provider.id, credential, baseURL: typeof baseURL === 'string' ? baseURL : null, model: isDefault ? null : selection.model }
}
