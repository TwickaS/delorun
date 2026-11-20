/**
 * Host entry of Delorun's theme: stores the theme settings the studio's
 * Appearance section edits, including the `studioAdditions` switch, and while
 * the switch is on prints the palette and accent into each page so the first
 * paint is already Delorun's look, the wordmark of the boot page, and the
 * settings, so the studio half applies the look while the studio boots. The
 * look itself is applied by the studio half.
 * @module @delorun/plugin-theme
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-settings'
import { resolveBranding, STUDIO_ICON_PATH, STUDIO_ICON_UPLOAD_PATH, writeIcon } from '@delorun/brand/branding'
import { admitApprovedDevice, ICON_FILE_SEGMENTS, readIcon } from '@delorun/home-auth'
import { BOOT_SETTINGS_GLOBAL } from './boot-settings.ts'
import type { Config as ThemeConfig, ThemeSettings } from './config.ts'
import { receiveIcon } from './icon-upload.ts'
import { bootStyle } from './palette/layers.ts'

export { BOOT_SETTINGS_GLOBAL } from './boot-settings.ts'
export { Config, THEME_ROW_ID, type ThemeSettings } from './config.ts'

/** The `globalThis` property whose string value upstream's boot page shows as its wordmark in place of its own; set to {@link BOOT_WORDMARK} only while Delorun's look is on. */
export const BOOT_WORDMARK_GLOBAL = 'dshBootWordmark'

/** The wordmark Delorun's look shows on the boot page. */
export const BOOT_WORDMARK = 'Delorun'

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
    toastPosition: config.toastPosition.get(),
    branding: config.branding.get(),
  }
}

/**
 * Serve the settings to the studio's own page and, while Delorun's look is on, print the first-paint style, the boot
 * page's wordmark and the settings themselves, from which the studio half applies the look while the studio boots.
 * @param ctx - the host plugin's context.
 * @param config - the validated live configuration.
 */
export function apply(ctx: Context, config: ThemeConfig): void {
  // The Appearance section is this plugin's own page, so the settings service builds no form for it.
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  const iconPath = (): string | undefined => ctx.get('dshHomePath')?.(...ICON_FILE_SEGMENTS)
  // The icon is read from the live settings on every request, so a changed hash shows at once; a hash no file matches, or an invalid record, is a 404.
  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: STUDIO_ICON_PATH,
      handler: (request, response) => {
        writeIcon(resolveBranding(config.branding.get(), { readImage: hash => readIcon(iconPath(), hash) }), request.method, response)
        return Promise.resolve()
      },
    }), 'theme: branding icon route')
  })
  // The write check: the bytes are checked here by their first bytes and size, never trusting the page, and stored as the
  // home's one icon file. An approved device writes it as it writes any everyday setting, with no unlock.
  ctx.inject(['connection'], (scope) => {
    scope.effect(() => scope.connection.fetch.register({
      path: STUDIO_ICON_UPLOAD_PATH,
      requestMediaType: 'application/octet-stream',
      methods: ['POST'],
      requestBody: 'buffered',
      admitPeer: admitApprovedDevice(),
      fetch: request => receiveIcon(request, iconPath()),
    }), 'theme: branding icon upload route')
  })
  ctx.on('webserver/index-inject', (table) => {
    const settings = currentSettings(config)
    const text = bootStyle(settings)
    if (text !== '') table.push({ kind: 'style', text })
    if (!settings.studioAdditions) return
    // The upload stays out of the page: the studio fetches it from the icon route.
    const printed = { ...settings, branding: { ...settings.branding, upload: '' } }
    table.push({ kind: 'global', name: BOOT_WORDMARK_GLOBAL, value: BOOT_WORDMARK }, { kind: 'global', name: BOOT_SETTINGS_GLOBAL, value: printed })
  })
}
