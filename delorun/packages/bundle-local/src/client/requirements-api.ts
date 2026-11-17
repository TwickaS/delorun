/**
 * The request for what each optional bundle's rows need from this computer, and the validation of its JSON answer. The
 * Host serves the answer to any signed-in studio ([`../requirements.ts`](../requirements.ts)); requests go through
 * [`./host-api.ts`](./host-api.ts).
 * @module @delorun/bundle-local/client/requirements-api
 */
import { call, fields, isString, listOf, optional, type Check, type HostFetch } from './host-api.ts'

/** The routes under `/api`. */
export const REQUIREMENT_ROUTES = {
  /** `GET ?language=en|zh`: every declared row's state, as {@link RequirementsAnswer}. */
  check: '/api/delorunRequirements.check',
} as const

/** The action that meets a need. `label` is the bundle's own words for it, when it supplies any. */
export type RequirementFix =
  | { readonly kind: 'command', readonly command: string, readonly label?: string }
  | { readonly kind: 'settings', readonly section: string, readonly label?: string }
  | { readonly kind: 'docs', readonly url: string, readonly label?: string }

/** One row's state: ready, or what it needs and how to meet that. */
export type RequirementRow =
  | { readonly packageName: string, readonly rowId: string, readonly state: 'ready' }
  | { readonly packageName: string, readonly rowId: string, readonly state: 'needs-setup', readonly reason: string, readonly fix: RequirementFix }

/** A bundle whose declaration could not be read. */
export interface RequirementProblem {
  readonly packageName: string
  readonly message: string
}

/** What the check answers. */
export interface RequirementsAnswer {
  readonly rows: readonly RequirementRow[]
  readonly problems: readonly RequirementProblem[]
}

const isFix: Check = value => fields({ kind: isString, label: optional(isString) })(value)
  && ((value as { kind: string }).kind === 'command' ? fields({ command: isString })(value)
    : (value as { kind: string }).kind === 'settings' ? fields({ section: isString })(value)
      : (value as { kind: string }).kind === 'docs' && fields({ url: isString })(value))
const isRow: Check = value => fields({ packageName: isString, rowId: isString, state: isString })(value)
  && ((value as { state: string }).state === 'ready'
    || ((value as { state: string }).state === 'needs-setup' && fields({ reason: isString, fix: isFix })(value)))
const isAnswer: Check = fields({ rows: listOf(isRow), problems: listOf(fields({ packageName: isString, message: isString })) })

/**
 * Read every declared row's state.
 * @param fetch - the request function.
 * @param language - `zh` for Chinese texts; anything else reads English.
 * @returns the rows and the bundles whose declaration is broken.
 * @throws {HostRequestError} for a refusal, an unreachable Host or an unreadable answer.
 */
export function readRequirements(fetch: HostFetch, language: string): Promise<RequirementsAnswer> {
  return call<RequirementsAnswer>(fetch, `${REQUIREMENT_ROUTES.check}?language=${encodeURIComponent(language)}`, isAnswer)
}
