/**
 * The layout keys: commands in the studio's keyboard settings for the next and previous layout, moving focus between panes, swapping
 * the focused pane with the main place and growing or shrinking the main place. They ship unbound: every conventional chord for
 * these moves either types a character with AltGr on many keyboards or switches desktops in common window systems.
 * @module @delorun/plugin-multiview/panel/keys
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ShortcutCommand, ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MultiviewService } from '../client/contract.ts'
import { neighbourPane, type FocusDirection, type LayoutArea, type LayoutModel, type LayoutsLocaleKey, type PaneId } from '../layout/index.ts'

/** What an open Multiview layer offers the layout keys. */
export interface OpenLayer {
  /** The chat the Multiview belongs to. */
  readonly main: SessionId
  /** The focused pane, or the main place's pane when none is focused. */
  focused(): PaneId
  /** The layout as drawn. */
  display(): LayoutModel
  /** The area the layout fills, if measured. */
  area(): LayoutArea | undefined
  /**
   * Bring a pane forward and give it keyboard focus.
   * @param pane - the pane.
   */
  focusPane(pane: PaneId): void
}

/** The open layers; the most recent one answers the keys. */
export interface LayerRegistry {
  /**
   * Offer a layer while it is open.
   * @param layer - the layer.
   * @returns the disposer, called when it closes.
   */
  offer(layer: OpenLayer): () => void
  /** @returns the layer that answers the keys, if one is open. */
  current(): OpenLayer | undefined
}

/**
 * A registry of open layers.
 * @returns the registry.
 */
export function createLayerRegistry(): LayerRegistry {
  const open: OpenLayer[] = []
  return {
    offer(layer) {
      open.push(layer)
      return () => {
        const at = open.lastIndexOf(layer)
        if (at >= 0) open.splice(at, 1)
      }
    },
    current: () => open[open.length - 1],
  }
}

/** One layout key: its id, its label's key and what it does to the open layer. */
interface LayoutKey {
  readonly id: string
  readonly label: LayoutsLocaleKey
  readonly run: (layer: OpenLayer, multiview: MultiviewService) => void
}

const FALLBACK_AREA: LayoutArea = { width: 1440, height: 900 }

const focusIn = (direction: FocusDirection) => (layer: OpenLayer): void => {
  const next = neighbourPane(layer.display(), layer.area() ?? FALLBACK_AREA, layer.focused(), direction)
  if (next !== undefined) layer.focusPane(next)
}

/** Every layout key, in the order the keyboard settings list them. */
export const LAYOUT_KEYS: readonly LayoutKey[] = [
  { id: 'multiview.layout.next', label: 'command.next', run: (layer, multiview) => { multiview.cycleLayout(layer.main, 1) } },
  { id: 'multiview.layout.previous', label: 'command.previous', run: (layer, multiview) => { multiview.cycleLayout(layer.main, -1) } },
  { id: 'multiview.focus.left', label: 'command.focus.left', run: focusIn('left') },
  { id: 'multiview.focus.right', label: 'command.focus.right', run: focusIn('right') },
  { id: 'multiview.focus.up', label: 'command.focus.up', run: focusIn('up') },
  { id: 'multiview.focus.down', label: 'command.focus.down', run: focusIn('down') },
  {
    id: 'multiview.pane.swapMain',
    label: 'command.swapMain',
    run: (layer, multiview) => {
      const pane = layer.focused()
      multiview.swapWithMain(layer.main, pane)
      layer.focusPane(pane)
    },
  },
  { id: 'multiview.main.grow', label: 'command.grow', run: (layer, multiview) => { multiview.resizeMain(layer.main, 1) } },
  { id: 'multiview.main.shrink', label: 'command.shrink', run: (layer, multiview) => { multiview.resizeMain(layer.main, -1) } },
]

/**
 * Register the layout keys, unbound, while the studio's keyboard registry is present.
 * @param ctx - the browser context; needs `shortcuts`.
 * @param multiview - the service.
 * @param layers - the open layers.
 * @param t - the layout copy, for the labels.
 */
export function registerLayoutKeys(ctx: Context, multiview: MultiviewService, layers: LayerRegistry, t: Translate<LayoutsLocaleKey>): void {
  for (const key of LAYOUT_KEYS) {
    ctx.effect(() => ctx.shortcuts.register({
      id: key.id as ShortcutCommandId,
      label: () => t(key.label),
      aliases: ['multiview', 'layout'],
      defaults: {},
      regions: ['page', 'editable'],
      modals: [],
      resolve: (): ReturnType<ShortcutCommand['resolve']> => {
        const layer = layers.current()
        if (layer === undefined) return { status: 'pass' }
        return { status: 'handled', run: () => { key.run(layer, multiview) } }
      },
    }), `delorun-multiview: ${key.id}`)
  }
}
