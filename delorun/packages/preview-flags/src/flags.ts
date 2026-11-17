/**
 * What a preview flag is: its id, its kind and the words that name it. The module imports no runtime of the Host or
 * the studio, so a Host plugin, a studio bundle and `delorun` all read it.
 * @module @delorun/preview-flags/flags
 */
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'

/** A preview flag's id, such as `onboarding.previewSteps`: the declaring feature area, a dot, and the flag's own name. */
export type PreviewFlagId = Branded<'PreviewFlagId'>

/** The form of a flag id: two or more dot-separated camel-case words, each starting with a lower-case letter. */
export const PREVIEW_FLAG_ID = /^[a-z][A-Za-z0-9]{0,31}(?:\.[a-z][A-Za-z0-9]{0,31}){1,3}$/

/**
 * Whether a string has the form of a flag id.
 * @param value - the string.
 * @returns true when it matches {@link PREVIEW_FLAG_ID}.
 */
export function isPreviewFlagId(value: string): value is PreviewFlagId {
  return PREVIEW_FLAG_ID.test(value)
}

/**
 * Name a flag.
 * @param value - the id, such as `onboarding.previewSteps`.
 * @returns the branded id.
 * @throws {Error} when the string does not have the form of a flag id.
 */
export function previewFlagId(value: string): PreviewFlagId {
  if (!isPreviewFlagId(value)) throw new Error(`"${value}" is not a preview flag id: use dot-separated camel-case words, such as onboarding.previewSteps`)
  return brandString<PreviewFlagId>(value)
}

/** A sentence in the studio's two languages. */
export interface PreviewFlagCopy {
  readonly en: string
  readonly zh: string
}

/** The fields every kind of flag has. */
interface PreviewFlagBase {
  /** The flag's id. */
  readonly id: PreviewFlagId
  /** The package name of the plugin that declares it. */
  readonly owner: string
  /** What the flag shows, in a few words. */
  readonly title: PreviewFlagCopy
  /** What turning it on changes, in a sentence. */
  readonly description: PreviewFlagCopy
}

/** A flag that is on or off; it is off unless the profile row turns it on. */
export interface BooleanPreviewFlag extends PreviewFlagBase {
  readonly kind: 'boolean'
}

/** A flag as a plugin declares it. The union is closed over `kind`; a new kind adds a member here and its value to the row's `flags` schema. */
export type PreviewFlagDeclaration = BooleanPreviewFlag

/** The kinds a flag can have. */
export type PreviewFlagKind = PreviewFlagDeclaration['kind']

/**
 * The known flag ids as an error message lists them.
 * @param ids - the ids.
 * @returns the ids sorted and comma-separated, or `none` for an empty list.
 */
export function knownList(ids: Iterable<string>): string {
  const sorted = [...ids].sort()
  return sorted.length === 0 ? 'none' : sorted.join(', ')
}
