/**
 * The sign-in and pairing pages under the person's own branding. The pages are served before anyone signs in, so
 * everything drawn here comes from {@link resolveBranding}'s validated values: the name is escaped text, the icon is the
 * uploaded image served by the fixed icon route with its sniffed type, and a record that does not validate shows the
 * Delorun defaults.
 * @module @delorun/home-auth/branding
 */
import { resolveBranding, writeIcon } from '@delorun/brand/branding'

/** The fixed path of the icon route. */
export const BRANDING_ICON_PATH = '/auth/branding/icon'

/** The studio's theme settings namespace and the field of it that holds the branding record. */
export const BRANDING_SETTINGS = { ns: 'delorun-theme', field: 'branding' } as const

/** Reads the stored branding record, of any type; undefined when none is stored. */
export type BrandingSource = () => unknown

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
 * @returns the page: the template itself for the defaults; otherwise with the own icon and name, or neither when the mark is hidden.
 */
export function brandedSignInPage(template: string, stored: unknown): string {
  const branding = resolveBranding(stored)
  if (!branding.showMark) return template.replace(BRAND_SEGMENT, '').replace('<body>', `<body data-brand-name="${escapeHtml(branding.name)}">`).replace('<title>Delorun</title>', `<title>${escapeHtml(branding.name)}</title>`)
  if (!branding.custom) return template
  // A picked workspace icon is drawn by the studio only; these pages keep the Delorun mark for it.
  const mark = branding.icon === 'upload' && branding.image !== undefined
    ? `<img class="mark" src="${BRANDING_ICON_PATH}?v=${branding.image.version}" alt="" width="20" height="20">`
    : /<!--brand-->([\s\S]*?)<span class="wordmark">/.exec(template)?.[1] ?? ''
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
 */
export function answerIcon(stored: unknown, method: string | undefined, response: Parameters<typeof writeIcon>[2]): void {
  writeIcon(resolveBranding(stored), method, response)
}
