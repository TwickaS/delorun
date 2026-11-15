/**
 * The providers step's data and rules: which model providers the step offers, where each provider's API-key page is, how a
 * typed key is judged, and the credential reference a key is saved under.
 * @module @delorun/plugin-onboarding/client/providers
 */
import { DEEPSEEK_ROUTE, type KeyResult, type KeyTestAnswer } from '../wire.ts'

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
  /** The provider's official API-key page, when {@link KEY_PAGES} has one. */
  readonly keyPage: string | undefined
  /** True when the route needs a base URL because a person declared it. */
  readonly needsBaseURL: boolean
}

/** What the free model-list request answered for a typed key. */
export type KeyProbe =
  | { readonly kind: 'works'; readonly models: number; readonly defaultModel: string | undefined }
  | { readonly kind: 'failed' }

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

/** Results that mean a key is stored or found in the environment. */
const HELD: ReadonlySet<KeyResult> = new Set(['works', 'rejected', 'unreachable', 'failed', 'untested'])

/**
 * The cards the step offers: the usable routes the key test lists (which leaves out hidden ones), joined to the directory
 * entry that says where a key is saved, kept to the routes a key connects.
 * @param answer - the key test.
 * @param directory - the configurable routes.
 * @returns the cards, the common providers first.
 */
export function cardsOf(answer: KeyTestAnswer, directory: readonly DirectoryEntry[]): readonly ProviderCard[] {
  const cards: ProviderCard[] = []
  for (const each of answer.providers) {
    const entry = directory.find(candidate => candidate.provider === each.provider)
    if (entry === undefined || !connectsWithKey(entry)) continue
    cards.push({ provider: each.provider, name: each.name, entry, found: HELD.has(each.result), result: each.result, keyPage: KEY_PAGES[each.provider], needsBaseURL: entry.declared === true })
  }
  const rank = (card: ProviderCard): number => {
    const place = (FIRST as readonly string[]).indexOf(card.provider)
    return place === -1 ? FIRST.length : place
  }
  return cards.toSorted((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
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
