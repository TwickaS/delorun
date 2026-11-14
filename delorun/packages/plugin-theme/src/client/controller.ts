/**
 * Applies the theme settings to the studio while the studio additions are on:
 * the palette, accent, type, density and contrast layers through
 * `ctx.theme.overrideTokens`, Delorun's font faces, and the effort-bars mark on
 * `<html>`.
 * @module @delorun/plugin-theme/client/controller
 */
import type { ThemeSettings } from '../config.ts'
import type { TokenLayer } from '../palette/generate.ts'
import { themeLayers } from '../palette/layers.ts'
import { EFFORT_ATTRIBUTE } from './effort.ts'
import type { ThemeLayers } from '../palette/layers.ts'

/** Package id: the source name of the override layers and the tag of the font style element. */
export const PLUGIN_ID = '@delorun/plugin-theme'

/** Override-layer sources, in stacking order: later layers win per token. */
export const LAYERS = {
  palette: `${PLUGIN_ID}/palette`,
  accent: `${PLUGIN_ID}/accent`,
  type: `${PLUGIN_ID}/type`,
  density: `${PLUGIN_ID}/density`,
  contrast: `${PLUGIN_ID}/contrast`,
} as const

/** The part of upstream's theme service the controller uses. */
export interface TokenLayers {
  /**
   * Stack or replace one source's override layer.
   * @param source - the layer's source name.
   * @param tokens - token names to their light and dark values.
   * @returns the layer's disposer.
   */
  overrideTokens(source: string, tokens: TokenLayer): () => void
}

/** Holds the applied layers and font faces, and replaces them when the settings change. */
export class ThemeController {
  private readonly removers = new Map<keyof ThemeLayers, () => void>()
  private faces: HTMLStyleElement | undefined
  private applied: string | undefined

  /** Upstream's theme service. */
  private readonly theme: TokenLayers
  /** The font faces' CSS text. */
  private readonly fonts: string
  /** The studio's document, which holds the faces and the effort mark. */
  private readonly doc: Document

  /**
   * @param theme - upstream's theme service.
   * @param fonts - the font faces' CSS text.
   * @param doc - the studio's document, which holds the faces and the effort mark.
   */
  constructor(theme: TokenLayers, fonts: string, doc: Document) {
    this.theme = theme
    this.fonts = fonts
    this.doc = doc
  }

  /**
   * Apply a set of settings; a set equal to the applied one changes nothing, and a set with the studio additions off removes everything.
   * @param settings - the theme settings.
   */
  update(settings: ThemeSettings): void {
    const key = JSON.stringify(settings)
    if (key === this.applied) return
    this.applied = key
    const layers = themeLayers(settings)
    for (const part of ['palette', 'accent', 'type', 'density', 'contrast'] as const) {
      const tokens = layers[part]
      this.removers.get(part)?.()
      this.removers.delete(part)
      if (tokens !== undefined) this.removers.set(part, this.theme.overrideTokens(LAYERS[part], tokens))
    }
    // The faces stay declared whichever typeface is chosen, so the Appearance typeface preview shows Delorun's face; a declared face downloads only when used.
    this.setFaces(settings.studioAdditions)
    if (settings.studioAdditions && settings.effort === 'bars') this.doc.documentElement.setAttribute(EFFORT_ATTRIBUTE, 'bars')
    else this.doc.documentElement.removeAttribute(EFFORT_ATTRIBUTE)
  }

  /** Remove every layer, the faces and the effort mark. */
  dispose(): void {
    for (const remove of this.removers.values()) remove()
    this.removers.clear()
    this.setFaces(false)
    this.doc.documentElement.removeAttribute(EFFORT_ATTRIBUTE)
    this.applied = undefined
  }

  private setFaces(on: boolean): void {
    if (!on) {
      this.faces?.remove()
      this.faces = undefined
      return
    }
    if (this.faces !== undefined) return
    const tag = this.doc.createElement('style')
    tag.dataset.plugin = PLUGIN_ID
    tag.dataset.pluginCss = `${PLUGIN_ID}/fonts.css`
    tag.textContent = this.fonts
    this.doc.head.appendChild(tag)
    this.faces = tag
  }
}
