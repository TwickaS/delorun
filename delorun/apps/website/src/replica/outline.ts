/**
 * What a person can read and press in a chat transcript, as plain data: user and assistant messages, the tool call's
 * command and the buttons of the approval card and the composer. The product's real chat and the website's replica both
 * build one from their own markup, passing their own selectors, and the replica's is compared with the product's.
 * Pure DOM code: it imports no renderer and no replica module, so the product's React 18 and the site's React 19 specs
 * can both load it.
 * @module @delorun/website/replica/outline
 */
import { stateAt, type ChapterFile, type ReplicaEvent } from './model.ts'

/** What an item is: a message, a tool row's title, the tool call's command, its status word, a step group, or a button. */
export type OutlineKind = 'user' | 'assistant' | 'title' | 'command' | 'status' | 'group' | 'button'

/** One readable or pressable thing. */
export interface OutlineItem {
  readonly kind: OutlineKind
  /** The text with runs of white space collapsed; a button's accessible name. */
  readonly text: string
}

/** The items of one scene, in document order. */
export interface SceneOutline {
  /** The chapter whose end the scene shows. */
  readonly scene: string
  readonly items: readonly OutlineItem[]
}

/** The outline of every scene. */
export type Outline = readonly SceneOutline[]

/** How one side's markup maps to items. */
export interface OutlineSelectors {
  /**
   * Matches the elements whose visible text is a message, a tool row's title, the command, a status word or a step
   * group's label. Visually hidden text is left out.
   */
  readonly readable: string
  /** Matches the approval card's buttons and the composer's send button, and no others. */
  readonly buttons: string
  /**
   * Says which item a `readable` element is.
   * @param element - an element `readable` matched.
   * @returns its kind.
   */
  readonly kindOf: (element: Element) => Exclude<OutlineKind, 'button'>
}

/** A scene of a session: the chapter whose end it shows and the events shown there. */
export interface SceneEvents {
  readonly id: string
  readonly events: readonly ReplicaEvent[]
  /** The approval request left waiting for an answer at the end of the scene, if any. */
  readonly pending: PendingRequest | undefined
}

/** An approval request as the product's approval plugin is handed it. */
export type PendingRequest = Extract<ReplicaEvent, { type: 'approval/asked' }>['data']

/**
 * The approval request that has no decision among the shown events.
 * @param shown - the shown events.
 * @returns the request, or undefined when none waits.
 */
export function pendingRequest(shown: readonly ReplicaEvent[]): PendingRequest | undefined {
  for (const [index, event] of shown.entries()) {
    if (event.type !== 'approval/asked') continue
    if (!shown.slice(index + 1).some(later => later.type === 'approval/decided' && later.data.id === event.data.id)) return event.data
  }
  return undefined
}

/**
 * One scene per chapter end.
 * @param file - the session's chapters.
 * @param events - the session's events.
 * @returns the scenes in chapter order.
 */
export function scenesOf(file: ChapterFile, events: readonly ReplicaEvent[]): SceneEvents[] {
  return file.chapters.map((chapter, index): SceneEvents => {
    const shown = events.slice(0, stateAt(file, index, Number.POSITIVE_INFINITY).state.shown)
    return { id: chapter.id, events: shown, pending: pendingRequest(shown) }
  })
}

/**
 * Text as a person reads it.
 * @param text - the raw text.
 * @returns the text trimmed, with runs of white space as one space.
 */
export const collapse = (text: string | null | undefined): string => (text ?? '').replace(/\s+/g, ' ').trim()

/**
 * Read one scene's outline from rendered markup.
 * @param container - the rendered chat.
 * @param scene - which scene the markup shows.
 * @param selectors - how this side's markup maps to items.
 * @returns the items in document order; a button is named by its `aria-label`, else its text.
 */
export function outlineOf(container: ParentNode, scene: string, selectors: OutlineSelectors): SceneOutline {
  const items = [...container.querySelectorAll(`${selectors.readable}, ${selectors.buttons}`)].map((element): OutlineItem => element.matches(selectors.buttons)
    ? { kind: 'button', text: collapse(element.getAttribute('aria-label') ?? element.textContent) }
    : { kind: selectors.kindOf(element), text: collapse(element.textContent) })
  return { scene, items }
}

/**
 * Whether a value is an item kind.
 * @param value - the value.
 * @returns whether it is one.
 */
function isKind(value: unknown): value is OutlineKind {
  return value === 'user' || value === 'assistant' || value === 'title' || value === 'command' || value === 'status' || value === 'group' || value === 'button'
}

/**
 * Parse an outline file.
 * @param json - the file's text.
 * @returns the outline.
 * @throws Error when the text is not an outline.
 */
export function parseOutline(json: string): Outline {
  const parsed: unknown = JSON.parse(json)
  if (!Array.isArray(parsed)) throw new Error('an outline is a list of scenes')
  return parsed.map((scene: unknown): SceneOutline => {
    if (typeof scene !== 'object' || scene === null || !('scene' in scene) || !('items' in scene) || !Array.isArray(scene.items)) throw new Error('a scene has a name and items')
    if (typeof scene.scene !== 'string') throw new Error('a scene has a name')
    const items = scene.items.map((item: unknown): OutlineItem => {
      if (typeof item !== 'object' || item === null || !('kind' in item) || !('text' in item)) throw new Error('an item has a kind and text')
      const { kind, text } = item
      if (!isKind(kind)) throw new Error('an item has a known kind')
      if (typeof text !== 'string') throw new Error('an item has a kind and text')
      return { kind, text }
    })
    return { scene: scene.scene, items }
  })
}

/** A difference the replica is allowed to have from the product, with the reason it has it. */
export interface AllowedDifference {
  readonly kind: OutlineKind
  /** The item's text; without it every item of the kind is allowed. */
  readonly text?: string | undefined
  readonly reason: string
}

/**
 * Say how a replica's outline differs from the product's.
 * @param product - the product's outline.
 * @param replica - the replica's outline.
 * @param allowed - the items either side may have that the other lacks; they are left out of both before comparing.
 * @returns a line per difference, or undefined when, scene by scene, the two list the same items in the same order.
 * An allowance that matches no item in either outline is reported too, so the list cannot go stale.
 */
export function differences(product: Outline, replica: Outline, allowed: readonly AllowedDifference[]): string | undefined {
  const lines: string[] = []
  const used = new Set<AllowedDifference>()
  const kept = (items: readonly OutlineItem[]): OutlineItem[] => items.filter((item) => {
    const entry = allowed.find(candidate => candidate.kind === item.kind && (candidate.text === undefined || candidate.text === item.text))
    if (entry !== undefined) used.add(entry)
    return entry === undefined
  })
  const words = (items: readonly OutlineItem[]): string => items.map(item => `${item.kind}: ${item.text}`).join('\n')
  for (const expected of product) {
    const actual = replica.find(scene => scene.scene === expected.scene)
    if (actual === undefined) {
      lines.push(`${expected.scene}: the replica has no such scene`)
      continue
    }
    const wanted = words(kept(expected.items))
    const drawn = words(kept(actual.items))
    if (wanted !== drawn) lines.push(`${expected.scene}: items differ\nproduct:\n${wanted}\nreplica:\n${drawn}`)
  }
  for (const entry of allowed) if (!used.has(entry)) lines.push(`allowed difference matches nothing: ${entry.kind} ${entry.text ?? ''} (${entry.reason})`)
  return lines.length === 0 ? undefined : lines.join('\n')
}
