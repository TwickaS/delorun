/**
 * The stack of full-screen surfaces that change the colours behind Safari's status bar and bottom toolbar.
 * A surface pushes an entry while it is open and releases it on close; the edge controller in the theme plugin
 * resolves the stack, bottom entry first, over the studio's own edge colours, so nested surfaces restore in order.
 * @module @deepseek-ai/dsh-client-ui-primitives/edge-surface
 */
import { useLayoutEffect } from 'react'
import type { RefObject } from 'react'

/** A surface that covers the page with its own solid background at the top and bottom of the screen. */
export interface SolidEdgeSurface {
  /** The colour at the top edge, as a CSS colour. */
  readonly top: string
  /** The colour at the bottom edge, as a CSS colour. */
  readonly bottom: string
}

/** A translucent overlay, such as a dialog mask, that tints whatever edge colours lie beneath it. */
export interface DimEdgeSurface {
  /** The overlay colour, as an `rgb()` or `rgba()` CSS colour; it is composited over the colours beneath. */
  readonly dim: string
}

/** One entry of the stack. */
export type EdgeSurface = SolidEdgeSurface | DimEdgeSurface

interface Registry {
  readonly entries: EdgeSurface[]
  readonly listeners: Set<() => void>
}

const registries = new WeakMap<Document, Registry>()

function registryOf(doc: Document): Registry {
  let registry = registries.get(doc)
  if (registry === undefined) {
    registry = { entries: [], listeners: new Set() }
    registries.set(doc, registry)
  }
  return registry
}

/**
 * Push a surface onto the document's edge stack.
 * @param doc - the studio's document.
 * @param surface - the colours or overlay the surface puts at the screen edges.
 * @returns a release function that removes exactly this entry, whatever order surfaces close in; calling it twice is harmless.
 */
export function pushEdgeSurface(doc: Document, surface: EdgeSurface): () => void {
  const registry = registryOf(doc)
  const entry: EdgeSurface = { ...surface }
  registry.entries.push(entry)
  for (const listener of [...registry.listeners]) listener()
  return () => {
    const index = registry.entries.indexOf(entry)
    if (index === -1) return
    registry.entries.splice(index, 1)
    for (const listener of [...registry.listeners]) listener()
  }
}

/**
 * Read the open surfaces.
 * @param doc - the studio's document.
 * @returns the entries, the earliest opened first.
 */
export function edgeSurfaces(doc: Document): readonly EdgeSurface[] {
  return [...registryOf(doc).entries]
}

/**
 * Call a function whenever a surface is pushed or released.
 * @param doc - the studio's document.
 * @param listener - the function to call.
 * @returns the function that stops the calls.
 */
export function subscribeEdgeSurfaces(doc: Document, listener: () => void): () => void {
  const registry = registryOf(doc)
  registry.listeners.add(listener)
  return () => { registry.listeners.delete(listener) }
}

const CHANNELS = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/

/**
 * Composite an overlay colour over a solid colour, so Safari sees one opaque edge colour.
 * @param overlay - an `rgb()` or `rgba()` colour, with comma or space syntax.
 * @param base - an `rgb()` or `rgba()` colour, taken as opaque.
 * @returns an `rgb()` colour; the base unchanged when either colour is not in a supported syntax.
 */
export function compositeOver(overlay: string, base: string): string {
  const over = CHANNELS.exec(overlay.trim())
  const under = CHANNELS.exec(base.trim())
  if (over === null || under === null) return base
  const rawAlpha = over[4]
  const alpha = rawAlpha === undefined ? 1 : rawAlpha.endsWith('%') ? Number.parseFloat(rawAlpha) / 100 : Number.parseFloat(rawAlpha)
  const mix = (index: 1 | 2 | 3): number => Math.round(Number(over[index]) * alpha + Number(under[index]) * (1 - alpha))
  return `rgb(${mix(1)}, ${mix(2)}, ${mix(3)})`
}

/** The token a dialog mask takes its colour from. */
const MASK_TOKEN = '--dsw-alias-bg-mask-1'

/**
 * Choose the edge entry for an open surface: a surface that fills the viewport with an opaque background puts that
 * background at both edges, and any other surface is a card on a mask, so the mask tints the edges.
 * @param element - the surface's own element.
 * @param win - its window.
 * @returns the entry, or undefined when the surface needs none because the mask token is empty.
 */
export function edgeSurfaceOf(element: HTMLElement, win: Window): EdgeSurface | undefined {
  const rect = element.getBoundingClientRect()
  const background = win.getComputedStyle(element).backgroundColor
  const opaque = /^rgb\(/.test(background) || /^rgba\(.*,\s*1\)$/.test(background)
  if (opaque && rect.width >= win.innerWidth - 1 && rect.height >= win.innerHeight - 1) return { top: background, bottom: background }
  const dim = win.getComputedStyle(element.ownerDocument.body).getPropertyValue(MASK_TOKEN).trim()
  return dim === '' ? undefined : { dim }
}

/**
 * Hold a full-screen surface or a dialog on the edge stack while it is open, so the browser's bars take its colour.
 * @param element - a ref to the surface's own element.
 * @param open - whether the surface is showing.
 */
export function useSurfaceEdges(element: RefObject<HTMLElement | null>, open: boolean): void {
  useLayoutEffect(() => {
    const target = element.current
    if (!open || target === null) return undefined
    const win = target.ownerDocument.defaultView
    if (win === null) return undefined
    let release: (() => void) | undefined
    const apply = (): void => {
      release?.()
      const surface = edgeSurfaceOf(target, win)
      release = surface === undefined ? undefined : pushEdgeSurface(target.ownerDocument, surface)
    }
    apply()
    win.addEventListener('resize', apply)
    return () => {
      win.removeEventListener('resize', apply)
      release?.()
    }
  }, [element, open])
}
