/**
 * The person's own branding: whether the studio shows its mark, the name and icon that replace "Delorun", and the
 * greeting of the empty chat screen. The studio's theme row stores one record; the studio, its icon route and the
 * sign-in pages of home-auth all read it through {@link resolveBranding}, which validates every field on read, so a
 * stored record that does not validate shows the defaults and a notice instead of failing a page.
 * Pure TypeScript with no dependency, so the pre-sign-in server and the browser share it.
 * @module @delorun/brand/branding
 */

/** The product name shown while the person sets no name. */
export const DEFAULT_BRAND_NAME = 'Delorun'

/** The longest name, in characters. */
export const NAME_MAX = 40

/** The longest greeting, in characters. */
export const GREETING_MAX = 80

/** The largest uploaded icon, in bytes. */
export const ICON_MAX_BYTES = 256 * 1024

/** The greeting presets; the first is the default. */
export const GREETING_PRESETS = ['What are we working on?', 'What shall we build today?', 'Where did we leave off?', 'What\'s on your mind?'] as const

/** The greeting shown while the person sets none. */
export const DEFAULT_GREETING: string = GREETING_PRESETS[0]

/** The kinds of icon: the Delorun mark, an icon picked from the workspace icon set, or an uploaded image. */
export const ICON_SOURCES = ['mark', 'picked', 'upload'] as const

/** One kind of icon. */
export type IconSource = typeof ICON_SOURCES[number]

/** The image types an upload may have, identified by their first bytes and never by a name or a declared type. */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const

/** One accepted image type. */
export type ImageType = typeof IMAGE_TYPES[number]

/** The fixed path of the studio's icon route. */
export const STUDIO_ICON_PATH = '/delorun/branding/icon'

/** The branding as stored in the theme row. An empty `name` or `greeting` means the default. */
export interface StoredBranding {
  /** Whether the icon and name show on the empty chat screen and in the sidebar header. */
  showMark: boolean
  /** The own name, or an empty string. */
  name: string
  /** The own greeting, or an empty string. */
  greeting: string
  /** Which icon replaces the mark. */
  icon: IconSource
  /** The picked workspace icon as JSON, used when {@link icon} is `picked`; the studio validates it with the workspace icon schema. */
  pickedIcon: string
  /** The uploaded image as base64, used when {@link icon} is `upload`. */
  upload: string
}

/** The stored branding of a studio whose person changed nothing. */
export const DEFAULT_STORED_BRANDING: StoredBranding = { showMark: true, name: '', greeting: '', icon: 'mark', pickedIcon: '', upload: '' }

/** The branding every page shows, after validation. */
export interface Branding {
  /** Whether the icon and name show. */
  showMark: boolean
  /** The name to show: the person's, or {@link DEFAULT_BRAND_NAME}. */
  name: string
  /** The greeting to show: the person's, or {@link DEFAULT_GREETING}. */
  greeting: string
  /** Which icon replaces the mark; `upload` only when the stored image validated. */
  icon: IconSource
  /** The picked workspace icon as JSON; empty unless {@link icon} is `picked`. */
  pickedIcon: string
  /** The validated upload, when {@link icon} is `upload`. */
  image: { readonly type: ImageType; readonly bytes: Uint8Array; readonly version: string } | undefined
  /** Whether the person changed the name or the icon, so a page draws the own branding instead of its built-in mark. */
  custom: boolean
  /** Why part of the stored record was ignored, in plain words, or undefined when all of it validated. */
  notice: string | undefined
}

/**
 * Whether a character is a control character, which a name or greeting never holds.
 * @param character - one UTF-16 code unit.
 * @returns whether it is in the C0 or C1 control ranges.
 */
function isControl(character: string): boolean {
  const code = character.charCodeAt(0)
  return code < 0x20 || (code >= 0x7f && code <= 0x9f)
}

/**
 * Check a name as the person typed it.
 * @param value - the text.
 * @returns the trimmed name, or a problem in plain words.
 */
export function checkName(value: string): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly problem: string } {
  const trimmed = value.trim()
  if (trimmed.length < 1 || trimmed.length > NAME_MAX) return { ok: false, problem: `The name is 1 to ${String(NAME_MAX)} characters.` }
  if ([...trimmed].some(isControl)) return { ok: false, problem: 'The name is plain text without control characters.' }
  return { ok: true, value: trimmed }
}

/**
 * Check a greeting as the person typed it.
 * @param value - the text.
 * @returns the trimmed greeting, or a problem in plain words.
 */
export function checkGreeting(value: string): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly problem: string } {
  const trimmed = value.trim()
  if (trimmed.length < 1 || trimmed.length > GREETING_MAX) return { ok: false, problem: `The greeting is 1 to ${String(GREETING_MAX)} characters.` }
  if ([...trimmed].some(isControl)) return { ok: false, problem: 'The greeting is plain text without control characters.' }
  return { ok: true, value: trimmed }
}

/**
 * Identify an image by its first bytes.
 * @param bytes - the file.
 * @returns PNG, JPEG or WebP when the signature says so; otherwise undefined, which includes SVG and every other type.
 */
export function sniffImage(bytes: Uint8Array): ImageType | undefined {
  const at = (offset: number, values: readonly number[]): boolean => values.every((value, index) => bytes[offset + index] === value)
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (at(0, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return 'image/webp'
  return undefined
}

/**
 * Decode and check an uploaded image.
 * @param base64 - the image as base64.
 * @param declaredType - the type the browser declared, if any; it must agree with the signature.
 * @returns the image, or a problem in plain words.
 */
export function checkUpload(base64: string, declaredType?: string): { readonly ok: true; readonly type: ImageType; readonly bytes: Uint8Array } | { readonly ok: false; readonly problem: string } {
  if (base64.length > Math.ceil((ICON_MAX_BYTES * 4) / 3) + 4) return { ok: false, problem: `The icon is larger than ${String(ICON_MAX_BYTES / 1024)} KB.` }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length === 0) return { ok: false, problem: 'The icon is not a readable image.' }
  const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0))
  if (bytes.length > ICON_MAX_BYTES) return { ok: false, problem: `The icon is larger than ${String(ICON_MAX_BYTES / 1024)} KB.` }
  const type = sniffImage(bytes)
  if (type === undefined) return { ok: false, problem: 'The icon is a PNG, JPEG or WebP image; SVG is not accepted.' }
  if (declaredType !== undefined && declaredType !== type) return { ok: false, problem: 'The icon\'s contents do not match its type.' }
  return { ok: true, type, bytes }
}

/**
 * A short version tag of an image, which makes the icon address change when the image does.
 * @param bytes - the image.
 * @returns eight hex digits of an FNV-1a hash.
 */
function versionOf(bytes: Uint8Array): string {
  let hash = 0x811c9dc5
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0
  return hash.toString(16).padStart(8, '0')
}

/**
 * Read a stored record into the branding pages show. Every field is checked; a field that fails keeps its default and
 * adds to the notice, and a record that is not an object shows all defaults.
 * @param raw - the stored value, of any type.
 * @param options - `uploadElided`: the upload was left out of the record on purpose, as in the studio's page, so an
 *   `upload` icon is kept without its bytes and the page loads the image from the icon route.
 * @returns the branding to show.
 */
export function resolveBranding(raw: unknown, options: { readonly uploadElided?: boolean } = {}): Branding {
  const problems: string[] = []
  const record: Record<string, unknown> = typeof raw === 'object' && raw !== null ? { ...raw } : {}
  if (raw !== undefined && (typeof raw !== 'object' || raw === null)) problems.push('The saved branding could not be read.')
  const showMark = typeof record.showMark === 'boolean' ? record.showMark : true
  if (record.showMark !== undefined && typeof record.showMark !== 'boolean') problems.push('The saved choice to show or hide the mark could not be read.')
  let name = DEFAULT_BRAND_NAME
  if (record.name !== undefined && record.name !== '') {
    const checked = typeof record.name === 'string' ? checkName(record.name) : { ok: false as const, problem: 'The saved name could not be read.' }
    if (checked.ok) name = checked.value
    else problems.push(`The saved name was ignored. ${checked.problem}`)
  }
  let greeting = DEFAULT_GREETING
  if (record.greeting !== undefined && record.greeting !== '') {
    const checked = typeof record.greeting === 'string' ? checkGreeting(record.greeting) : { ok: false as const, problem: 'The saved greeting could not be read.' }
    if (checked.ok) greeting = checked.value
    else problems.push(`The saved greeting was ignored. ${checked.problem}`)
  }
  let icon: IconSource = 'mark'
  let image: Branding['image']
  let pickedIcon = ''
  if (record.icon === 'upload' && options.uploadElided === true && record.upload === '') icon = 'upload'
  else if (record.icon === 'upload') {
    const checked = typeof record.upload === 'string' ? checkUpload(record.upload) : { ok: false as const, problem: 'The saved icon could not be read.' }
    if (checked.ok) {
      icon = 'upload'
      image = { type: checked.type, bytes: checked.bytes, version: versionOf(checked.bytes) }
    } else problems.push(`The saved icon was ignored. ${checked.problem}`)
  } else if (record.icon === 'picked') {
    if (typeof record.pickedIcon === 'string' && record.pickedIcon !== '') {
      icon = 'picked'
      pickedIcon = record.pickedIcon
    } else problems.push('The saved icon was ignored. It could not be read.')
  } else if (record.icon !== undefined && record.icon !== 'mark') problems.push('The saved icon was ignored. It could not be read.')
  const custom = name !== DEFAULT_BRAND_NAME || icon !== 'mark'
  return { showMark, name, greeting, icon, pickedIcon, image, custom, notice: problems.length === 0 ? undefined : problems.join(' ') }
}

/** The part of a Node HTTP response {@link writeIcon} uses. */
export interface IconResponse {
  statusCode: number
  setHeader(name: string, value: string): unknown
  end(body?: Uint8Array): unknown
}

/**
 * Answer a request for the icon route: the validated upload with the content type its first bytes gave, or 404 when the
 * branding has no upload. The response forbids sniffing and any script, so the bytes are drawn as an image or not at all.
 * @param branding - the resolved branding.
 * @param method - the request method; only GET and HEAD are answered.
 * @param response - the response.
 */
export function writeIcon(branding: Branding, method: string | undefined, response: IconResponse): void {
  if (method !== 'GET' && method !== 'HEAD') {
    response.statusCode = 405
    response.setHeader('allow', 'GET, HEAD')
    response.end()
    return
  }
  const image = branding.image
  if (image === undefined) {
    response.statusCode = 404
    response.end()
    return
  }
  response.statusCode = 200
  response.setHeader('content-type', image.type)
  response.setHeader('x-content-type-options', 'nosniff')
  response.setHeader('content-security-policy', 'default-src \'none\'; sandbox')
  response.setHeader('cache-control', 'no-cache')
  response.setHeader('etag', `"${image.version}"`)
  response.setHeader('content-length', String(image.bytes.length))
  response.end(method === 'HEAD' ? undefined : image.bytes)
}
