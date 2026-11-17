/**
 * The providers step's data and rules: which model providers the step offers, where each provider's API-key page is, how a
 * typed key is judged, and the credential reference a key is saved under.
 * @module @delorun/plugin-onboarding/client/providers
 */
import { DEEPSEEK_ROUTE, type KeyResult, type KeySource, type KeyTestAnswer } from '../wire.ts'

/** One configurable provider route, as the harness's directory describes it. */
export interface DirectoryEntry {
  /** The route's id. */
  readonly provider: string
  /** The route's name. */
  readonly displayName: string
  /** The settings namespace that holds the route's profile. */
  readonly settingsNs: string
  /** The profile's path inside that namespace. */
  readonly settingsPath: readonly string[]
  /** True for a route a person declared in settings, such as a gateway or a self-hosted server. */
  readonly declared?: boolean
  /** The endpoint the route uses when the profile names none. */
  readonly defaultBaseURL?: string
  /** Environment variables the route's own authentication reads. */
  readonly authEnv: readonly string[]
  /** Environment variables the route builds its endpoint from. */
  readonly baseURLEnv: readonly string[]
}

/** One provider card on the landing and in the walk. */
export interface ProviderCard {
  /** The route's id. */
  readonly provider: string
  /** The route's name. */
  readonly name: string
  /** The directory entry that says where its key is saved. */
  readonly entry: DirectoryEntry
  /** True while a key is stored or found in the environment. */
  readonly found: boolean
  /** What the key test answered for the route. */
  readonly result: KeyResult
  /** Where the found key came from, when the host said; never the key. */
  readonly source?: KeySource
  /** The provider's official API-key page, when {@link KEY_PAGES} has one. */
  readonly keyPage: string | undefined
  /** True when the route needs a base URL because a person declared it. */
  readonly needsBaseURL: boolean
  /** True for the offer to declare an OpenAI-compatible endpoint: it asks for a name and a base URL as well as a key. */
  readonly custom?: true
}

/**
 * What the free model-list request answered for a typed key: `works` only when a request carrying the key was answered
 * with a model list; `failed` when it was refused or did not answer; `unchecked` when no request here can tell, so the key
 * may be saved but nothing is claimed about it.
 */
export type KeyProbe =
  | { readonly kind: 'works'; readonly models: number; readonly defaultModel: string | undefined }
  | { readonly kind: 'failed' }
  | { readonly kind: 'unchecked' }

/** The model listing a catalogue provider answers over HTTP: the wire protocol and the base URL its `/models` path hangs from. */
export interface ProviderListing {
  /** The wire protocol, which decides how the key is sent. */
  readonly api: string
  /** The base URL the listing path is appended to. */
  readonly baseURL: string
}

/**
 * The providers whose own model listing refuses a wrong key (each answered 401 or 400 to a made-up key), so that a listing
 * the key passed shows the key authenticated. The catalogue's own answer is never used for a typed key: it lists installed
 * models without any request. A provider missing here, or whose listing is public (OpenRouter, Hugging Face, NVIDIA), is
 * `unchecked`.
 */
const LISTINGS: Readonly<Record<string, ProviderListing>> = {
  'openai': { api: 'openai-completions', baseURL: 'https://api.openai.com/v1' },
  'anthropic': { api: 'anthropic-messages', baseURL: 'https://api.anthropic.com' },
  'google': { api: 'google-generative-ai', baseURL: 'https://generativelanguage.googleapis.com/v1beta' },
  'groq': { api: 'openai-completions', baseURL: 'https://api.groq.com/openai/v1' },
  'mistral': { api: 'openai-completions', baseURL: 'https://api.mistral.ai/v1' },
  'xai': { api: 'openai-completions', baseURL: 'https://api.x.ai/v1' },
  'moonshotai': { api: 'openai-completions', baseURL: 'https://api.moonshot.ai/v1' },
  'together': { api: 'openai-completions', baseURL: 'https://api.together.ai/v1' },
  'fireworks': { api: 'openai-completions', baseURL: 'https://api.fireworks.ai/inference/v1' },
  'cerebras': { api: 'openai-completions', baseURL: 'https://api.cerebras.ai/v1' },
}

/**
 * @param provider - a catalogue route's id.
 * @returns the listing that checks a key for it, or undefined when none does.
 */
export function listingOf(provider: string): ProviderListing | undefined {
  return LISTINGS[provider]
}

/**
 * Official API-key pages by route id. Only a provider's own page belongs here; a provider without an entry shows no link.
 */
export const KEY_PAGES: Readonly<Record<string, string>> = {
  'deepseek-official': 'https://platform.deepseek.com/api_keys',
  'openai': 'https://platform.openai.com/api-keys',
  'anthropic': 'https://console.anthropic.com/settings/keys',
  'google': 'https://aistudio.google.com/apikey',
  'openrouter': 'https://openrouter.ai/keys',
  'groq': 'https://console.groq.com/keys',
  'mistral': 'https://console.mistral.ai/api-keys',
  'xai': 'https://console.x.ai',
  'moonshotai': 'https://platform.moonshot.ai/console/api-keys',
  'together': 'https://api.together.ai/settings/api-keys',
  'fireworks': 'https://fireworks.ai/account/api-keys',
  'cerebras': 'https://cloud.cerebras.ai/platform',
  'huggingface': 'https://huggingface.co/settings/tokens',
  'nvidia': 'https://build.nvidia.com/settings/api-keys',
}

/**
 * Display names for the providers above whose catalogue entry carries only the route id, so that a card reads "Google
 * Gemini" rather than "google". A route whose entry names itself is shown under that name.
 */
const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  'openai': 'OpenAI',
  'anthropic': 'Anthropic',
  'google': 'Google Gemini',
  'openrouter': 'OpenRouter',
  'groq': 'Groq',
  'mistral': 'Mistral',
  'xai': 'xAI',
  'moonshotai': 'Moonshot AI',
  'together': 'Together AI',
  'fireworks': 'Fireworks AI',
  'cerebras': 'Cerebras',
  'huggingface': 'Hugging Face',
  'nvidia': 'NVIDIA',
}

/**
 * @param provider - the route's id.
 * @param given - the name the harness gave it.
 * @returns the harness's name, or the display name above when the harness gave only the id.
 */
function nameOf(provider: string, given: string): string {
  return given === provider ? PROVIDER_NAMES[provider] ?? given : given
}

/** The providers the landing lists first, in order; the rest follow by name. */
const FIRST = ['deepseek-official', 'openai', 'anthropic', 'google', 'openrouter'] as const

/** How long a pasted key waits for more typing before it is tested, in milliseconds. */
export const TEST_DELAY_MS = 600

/**
 * Twin of upstream's credential-reference rule: the reference a typed key is saved under when the profile names none.
 * @param provider - the route's id.
 * @returns the reference, such as `MINIMAX_CN_API_KEY`.
 */
export function deriveKeyRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

/**
 * Whether a route is one a key alone connects: the official DeepSeek route, a route a person declared, or a route whose
 * own authentication reads an API-key variable and needs no account, project or region.
 * @param entry - the route's directory entry.
 * @returns true when the step offers it.
 */
function connectsWithKey(entry: DirectoryEntry): boolean {
  if (entry.provider === DEEPSEEK_ROUTE || entry.declared === true) return true
  return entry.baseURLEnv.length === 0 && entry.authEnv.some(name => name.endsWith('_API_KEY'))
}

/** The id of the offer that declares an OpenAI-compatible endpoint; it is not a route until the person saves it. */
export const CUSTOM_PROVIDER = 'custom-endpoint'

/** The settings namespace that holds hand-declared routes, and the wire protocol an endpoint is declared with. */
export const DECLARED_NAMESPACE = 'llm-pi-ai'

/**
 * The letter on a provider's tile: the first letter or digit of its name, or a plus for the endpoint offer.
 * @param card - the provider card.
 * @returns the letter, upper-cased.
 */
export function monogramOf(card: Pick<ProviderCard, 'name' | 'custom'>): string {
  if (card.custom === true) return '+'
  return card.name.match(/[\p{L}\p{N}]/u)?.[0]?.toUpperCase() ?? '·'
}

/** Results that mean a key is stored or found in the environment. */
const HELD: ReadonlySet<KeyResult> = new Set(['works', 'rejected', 'unreachable', 'failed', 'untested'])

/**
 * The cards the step offers: the usable routes the key test lists (which leaves out hidden ones), then every other route in
 * the directory that a key connects and the profile has not configured yet, which Settings → Models adds the same way,
 * then the offer to declare an OpenAI-compatible endpoint where the directory has a namespace for declared routes. Each
 * is joined to the directory entry that says where a key is saved.
 * @param answer - the key test.
 * @param directory - the configurable routes.
 * @returns the cards, the common providers first and the endpoint offer last.
 */
export function cardsOf(answer: KeyTestAnswer, directory: readonly DirectoryEntry[]): readonly ProviderCard[] {
  const cards: ProviderCard[] = []
  const listed = new Set(answer.providers.map(each => each.provider))
  for (const each of answer.providers) {
    const entry = directory.find(candidate => candidate.provider === each.provider)
    if (entry === undefined || !connectsWithKey(entry)) continue
    cards.push({ provider: each.provider, name: nameOf(each.provider, each.name), entry, found: HELD.has(each.result), result: each.result, ...(each.source === undefined ? {} : { source: each.source }), keyPage: KEY_PAGES[each.provider], needsBaseURL: entry.declared === true })
  }
  for (const entry of directory) {
    if (listed.has(entry.provider) || (answer.hidden ?? []).includes(entry.provider) || !connectsWithKey(entry)) continue
    cards.push({ provider: entry.provider, name: nameOf(entry.provider, entry.displayName), entry, found: false, result: 'no-key', keyPage: KEY_PAGES[entry.provider], needsBaseURL: entry.declared === true })
  }
  const rank = (card: ProviderCard): number => {
    const place = (FIRST as readonly string[]).indexOf(card.provider)
    // After the first five, the providers that have a key page, then the rest.
    return place !== -1 ? place : card.keyPage === undefined ? FIRST.length + 1 : FIRST.length
  }
  const sorted = cards.toSorted((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
  const declared = directory.find(entry => entry.settingsNs === DECLARED_NAMESPACE)
  if (declared === undefined) return sorted
  const entry: DirectoryEntry = { provider: CUSTOM_PROVIDER, displayName: 'OpenAI-compatible endpoint', settingsNs: DECLARED_NAMESPACE, settingsPath: [], declared: true, authEnv: [], baseURLEnv: [] }
  return [...sorted, { provider: CUSTOM_PROVIDER, name: entry.displayName, entry, found: false, result: 'no-key', keyPage: undefined, needsBaseURL: true, custom: true }]
}

/**
 * The route id for a typed endpoint name: lower-case letters, digits and single hyphens, starting with a letter, as the
 * Models page requires of a declared route, made unique with a numeric suffix.
 * @param name - the typed name.
 * @param taken - whether a route id already exists.
 * @returns the id, or undefined when the name has no letter or digit to make one from.
 */
export function routeIdOf(name: string, taken: (id: string) => boolean): string | undefined {
  const stem = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[0-9-]+/, '')
  if (stem === '') return undefined
  for (let n = 1; n < 100; n++) {
    const id = n === 1 ? stem : `${stem}-${String(n)}`
    if (!taken(id) && id !== CUSTOM_PROVIDER) return id
  }
  return undefined
}

/**
 * Judge a typed key: non-empty printable ASCII, as the harness reads it.
 * @param key - the field's value.
 * @returns the trimmed key, or undefined when there is nothing to save or it cannot be a key.
 */
export function usableKey(key: string): string | undefined {
  const value = key.trim()
  return /^[\x21-\x7E]+$/.test(value) && !/^[A-Z][A-Z0-9_]*=[^=]/.test(value) ? value : undefined
}
