/**
 * Host entry of Delo's theme: stores the theme settings the studio's
 * Appearance section edits, including the `studioAdditions` switch, and while
 * the switch is on prints the palette and accent into each page so the first
 * paint is already Delo's look, and the wordmark of the boot page. The look
 * itself is applied by the studio half.
 * @module @delo/plugin-theme
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-settings'
import type { Config as ThemeConfig, ThemeSettings } from './config.ts'
import { bootStyle } from './palette/layers.ts'

export { Config, THEME_ROW_ID, type ThemeSettings } from './config.ts'

/** The `globalThis` property whose string value upstream's boot page shows as its wordmark in place of its own; set to {@link BOOT_WORDMARK} only while Delo's look is on. */
export const BOOT_WORDMARK_GLOBAL = 'dshBootWordmark'

/** The wordmark Delo's look shows on the boot page. */
export const BOOT_WORDMARK = 'Delo'

/**
 * Read the live configuration as plain settings.
 * @param config - the host's live configuration.
 * @returns the current settings.
 */
export function currentSettings(config: ThemeConfig): ThemeSettings {
  return {
    accent: config.accent.get(),
    customAccent: config.customAccent.get(),
    typeface: config.typeface.get(),
    density: config.density.get(),
    studioAdditions: config.studioAdditions.get(),
    palette: config.palette.get(),
    contrast: config.contrast.get(),
    effort: config.effort.get(),
  }
}

/**
 * Serve the settings to the studio's own page and print the first-paint style while Delo's look is on.
 * @param ctx - the host plugin's context.
 * @param config - the validated live configuration.
 */
export function apply(ctx: Context, config: ThemeConfig): void {
  // The Appearance section is this plugin's own page, so the settings service builds no form for it.
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  ctx.on('webserver/index-inject', (table) => {
    const settings = currentSettings(config)
    const text = bootStyle(settings)
    if (text !== '') table.push({ kind: 'style', text })
    if (settings.studioAdditions) table.push({ kind: 'global', name: BOOT_WORDMARK_GLOBAL, value: BOOT_WORDMARK })
  })
}
