/**
 * The sign-in and pairing pages under the person's own branding. The pages are served before anyone signs in, so
 * everything drawn here comes from {@link resolveBranding}'s validated values: the name is escaped text, the icon is the
 * uploaded image served by the fixed icon route with its sniffed type, and a record that does not validate shows the
 * Delorun defaults.
 * @module @delorun/home-auth/branding
 */
import { resolveBranding, writeIcon } from '@delorun/brand/branding'
import { pickedIconSvg } from '@delorun/brand/picked-icon'

/** The fixed path of the icon route. */
export const BRANDING_ICON_PATH = '/auth/branding/icon'

/** The studio's theme settings namespace and the field of it that holds the branding record. */
export const BRANDING_SETTINGS = { ns: 'delorun-theme', field: 'branding' } as const

/** Reads the stored branding record, of any type; undefined when none is stored. */
export type BrandingSource = () => unknown

/** Reads the icon file for a hash; the bytes only when they hash to it. */
export type IconReader = (hash: string) => Uint8Array | undefined

/**
 * Escape text for an HTML text node or a double-quoted attribute.
 * @param text - the text.
 * @returns the text with markup characters as character references.
 */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

const BRAND_SEGMENT = /<!--brand-->[\s\S]*?<!--\/brand-->/

/**
 * The sign-in page under the person's branding.
 * @param template - the served page with its placeholders already filled.
 * @param stored - the stored branding record.
 * @param readImage - reads the icon file for a stored hash.
 * @returns the page: the template itself for the defaults; otherwise with the own icon and name, or neither when the mark is hidden.
 */
export function brandedSignInPage(template: string, stored: unknown, readImage?: IconReader): string {
  const branding = resolveBranding(stored, readImage === undefined ? {} : { readImage })
  if (!branding.showMark) return template.replace(BRAND_SEGMENT, '').replace('<body>', `<body data-brand-name="${escapeHtml(branding.name)}">`).replace('<title>Delorun</title>', `<title>${escapeHtml(branding.name)}</title>`)
  if (!branding.custom) return template
  // A picked icon is drawn from the shipped glyph set by id; one that does not validate keeps the Delorun mark.
  const picked = branding.icon === 'picked' ? pickedIconSvg(branding.pickedIcon, 20) : undefined
  const mark = branding.icon === 'upload' && branding.image !== undefined
    ? `<img class="mark" src="${BRANDING_ICON_PATH}?v=${branding.image.version}" alt="" width="20" height="20">`
    : picked ?? /<!--brand-->([\s\S]*?)<span class="wordmark">/.exec(template)?.[1] ?? ''
  return template
    .replace(BRAND_SEGMENT, () => `${mark}<span class="wordmark">${escapeHtml(branding.name)}</span>`)
    .replace('<body>', `<body data-brand-name="${escapeHtml(branding.name)}">`)
    .replace('<title>Delorun</title>', `<title>${escapeHtml(branding.name)}</title>`)
}

/**
 * Answer a request for the icon route from the stored branding.
 * @param stored - the stored branding record.
 * @param method - the request method.
 * @param response - the response.
 * @param readImage - reads the icon file for a stored hash.
 */
export function answerIcon(stored: unknown, method: string | undefined, response: Parameters<typeof writeIcon>[2], readImage?: IconReader): void {
  writeIcon(resolveBranding(stored, readImage === undefined ? {} : { readImage }), method, response)
}
