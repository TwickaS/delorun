/**
 * Whether Browser is on for the home, and what the Settings page and the setup guide say about it. Browser is on
 * until the person turns it off: a home that never chose is on, and a home that chose off stays off. The choice is
 * recorded by the studio (`browser` of the onboarding row); this module holds the rule and the states, and imports
 * nothing.
 * @module @delorun/browser-setup/switch
 */
import type { BrowserReadiness, RequirementFix } from './index.ts'

/** What the person chose for the home: Browser on, or off. */
export type BrowserSwitch = 'on' | 'off'

/**
 * Resolve the recorded choice.
 * @param recorded - the stored choice, or an empty or absent value when the person never chose.
 * @returns `off` only when the person chose off; every other value, including no choice, is `on`.
 */
export function resolveBrowserSwitch(recorded: string | undefined): BrowserSwitch {
  return recorded === 'off' ? 'off' : 'on'
}

/**
 * Where adding the Browser plugin pack stands, as the plugin installer reports it: `available` before an add starts,
 * `installing` and `slow` while it runs, `restart` when it needs a restart to finish, `installed` once the profile
 * holds the pack, and the three ways it cannot be added.
 */
export type PackProgress = 'checking' | 'available' | 'installing' | 'slow' | 'restart' | 'installed' | 'offline' | 'unavailable' | 'failed'

/** Why Browser could not be set up, for the plain words the page shows. */
export type BrowserFailure =
  /** The first download needs a connection and the computer is offline. */
  | { readonly cause: 'offline' }
  /** This release or computer offers no download of the pack; `reason` is the Host's own words, when it gave any. */
  | { readonly cause: 'unavailable'; readonly reason?: string | undefined }
  /** The add failed; `reason` is the plugin manager's own words, when it gave any. */
  | { readonly cause: 'failed'; readonly reason?: string | undefined }
  /** The pack is on, but what it needs could not be read. */
  | { readonly cause: 'unread' }
  /** The pack's own declaration could not be read. */
  | { readonly cause: 'problem'; readonly message: string }

/**
 * What the Settings page shows for Browser: `off` when the person chose off, `checking` before the first answer,
 * `installing` while the pack is added or about to be, `needs-setup` when a download or program is missing, `ready`,
 * or `failed` with the cause in a form the page turns into words.
 */
export type BrowserPageState =
  | { readonly kind: 'off' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'installing'; readonly slow: boolean }
  | { readonly kind: 'restart' }
  | { readonly kind: 'ready' }
  | { readonly kind: 'needs-setup'; readonly reason: string; readonly fix: RequirementFix }
  | { readonly kind: 'failed'; readonly failure: BrowserFailure }

/** The inputs of {@link browserPageState}. */
export interface BrowserPageInput {
  /** The home's choice, after {@link resolveBrowserSwitch}. */
  readonly choice: BrowserSwitch
  /** Where adding the pack stands. */
  readonly pack: PackProgress
  /** The pack's own failure words, when the installer gave any. */
  readonly packReason?: string | undefined
  /** What the Host's requirement check says about the pack's rows. */
  readonly readiness: BrowserReadiness
}

/**
 * Combine the choice, the pack's progress and the requirement check into one state.
 * @param input - the three sources.
 * @returns the state the page draws.
 */
export function browserPageState(input: BrowserPageInput): BrowserPageState {
  if (input.choice === 'off') return { kind: 'off' }
  const { readiness, pack } = input
  // A pack the Host lists answers for itself, whatever the installer last said.
  if (readiness.kind === 'needs-setup') return { kind: 'needs-setup', reason: readiness.reason, fix: readiness.fix }
  if (readiness.kind === 'problem') return { kind: 'failed', failure: { cause: 'problem', message: readiness.message } }
  if (readiness.kind === 'ready') return { kind: 'ready' }
  switch (pack) {
    case 'checking': return readiness.kind === 'failed' ? { kind: 'failed', failure: { cause: 'unread' } } : { kind: 'checking' }
    case 'available': return { kind: 'installing', slow: false }
    case 'installing': return { kind: 'installing', slow: false }
    case 'slow': return { kind: 'installing', slow: true }
    case 'restart': return { kind: 'restart' }
    case 'offline': return { kind: 'failed', failure: { cause: 'offline' } }
    case 'unavailable': return { kind: 'failed', failure: { cause: 'unavailable', reason: input.packReason } }
    case 'failed': return { kind: 'failed', failure: { cause: 'failed', reason: input.packReason } }
    case 'installed': return readiness.kind === 'failed' ? { kind: 'failed', failure: { cause: 'unread' } } : { kind: 'checking' }
    /* v8 ignore next 2 -- closed-union default only defends a future widening of PackProgress */
    default: return assertNever(pack)
  }
}

/**
 * Close a union the compiler has narrowed to nothing.
 * @param value - the value that cannot occur.
 * @returns never.
 * @throws always.
 */
/* v8 ignore next 3 -- reached only when PackProgress widens without its switch */
function assertNever(value: never): never {
  throw new Error(`unhandled pack progress ${JSON.stringify(value)}`)
}
