/** The sign-in pages draw the person's name as escaped text and their icon from the fixed route, and nothing else. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { answerIcon, brandedSignInPage, BRANDING_ICON_PATH } from '../src/branding.ts'
import { fillBrand } from '../src/sign-in-template.ts'

const TEMPLATE = fillBrand(readFileSync(fileURLToPath(new URL('../assets/sign-in.html', import.meta.url)), 'utf8'))
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

/** A response that records what the icon route writes. */
function recorder() {
  const headers: Record<string, string> = {}
  const state: { statusCode: number; body: Uint8Array | undefined } = { statusCode: 0, body: undefined }
  return {
    headers,
    state,
    response: {
      get statusCode() { return state.statusCode },
      set statusCode(value: number) { state.statusCode = value },
      setHeader: (name: string, value: string) => { headers[name] = value },
      end: (body?: Uint8Array) => { state.body = body },
    },
  }
}

describe('the sign-in page', () => {
  it('is the template itself under the defaults', () => {
    expect(brandedSignInPage(TEMPLATE, undefined)).toBe(TEMPLATE)
  })

  it('renders markup in the name as text', () => {
    const page = brandedSignInPage(TEMPLATE, { name: '<img src=x onerror=alert(1)>"&' })
    expect(page).not.toContain('<img src=x')
    expect(page).toContain('<span class="wordmark">&lt;img src=x onerror=alert(1)&gt;&quot;&amp;</span>')
    expect(page).toContain('<title>&lt;img')
    expect(page).toContain('data-brand-name="&lt;img')
  })

  it('shows the name and the uploaded icon from the icon route', () => {
    const page = brandedSignInPage(TEMPLATE, { name: 'Orbit', icon: 'upload', upload: PNG.toString('base64') })
    expect(page).toContain('<span class="wordmark">Orbit</span>')
    expect(page).toMatch(new RegExp(`<img class="mark" src="${BRANDING_ICON_PATH}\\?v=[0-9a-f]{8}" alt=""`))
    expect(page).not.toContain('<svg class="mark"')
  })

  it('shows neither the mark nor the name while the mark is hidden', () => {
    const page = brandedSignInPage(TEMPLATE, { showMark: false })
    expect(page).not.toContain('class="wordmark"')
    expect(page).not.toContain('class="mark"')
    expect(page).toContain('<main data-sign-in>')
  })

  it('keeps a page with a name and the Delorun mark when the stored icon is an SVG', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')
    const page = brandedSignInPage(TEMPLATE, { name: 'Orbit', icon: 'upload', upload: svg })
    expect(page).not.toContain(BRANDING_ICON_PATH)
    expect(page).toContain('<svg class="mark"')
  })

  it('shows the Delorun defaults for a record that does not validate, never a blank page', () => {
    expect(brandedSignInPage(TEMPLATE, 'garbage')).toBe(TEMPLATE)
    expect(brandedSignInPage(TEMPLATE, { name: 'x'.repeat(500) })).toBe(TEMPLATE)
  })
})

describe('the icon route', () => {
  it('serves a valid upload with its sniffed type, nosniff and a no-script policy', () => {
    const { response, headers, state } = recorder()
    answerIcon({ icon: 'upload', upload: PNG.toString('base64') }, 'GET', response)
    expect(state.statusCode).toBe(200)
    expect(headers['content-type']).toBe('image/png')
    expect(headers['x-content-type-options']).toBe('nosniff')
    expect(headers['content-security-policy']).toContain('default-src \'none\'')
    expect(state.body).toEqual(new Uint8Array(PNG))
  })

  it('answers 404 for an SVG, an oversize file and no upload', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>').toString('base64')
    const big = Buffer.concat([PNG, Buffer.alloc(300 * 1024)]).toString('base64')
    for (const stored of [{ icon: 'upload', upload: svg }, { icon: 'upload', upload: big }, undefined]) {
      const { response, state } = recorder()
      answerIcon(stored, 'GET', response)
      expect(state.statusCode).toBe(404)
    }
  })

  it('refuses other methods', () => {
    const { response, state } = recorder()
    answerIcon({ icon: 'upload', upload: PNG.toString('base64') }, 'POST', response)
    expect(state.statusCode).toBe(405)
  })
})

describe('a picked icon on the sign-in page', () => {
  it('draws the glyph from the shipped set and the Delorun mark for an invalid icon', () => {
    const template = '<html><head><title>Delorun</title></head><body><!--brand--><svg class="mark"></svg><span class="wordmark">Delorun</span><!--/brand--></body></html>'
    const picked = JSON.stringify({ kind: 'glyph', glyph: 'folder', color: 'blue', shape: 'rounded', style: 'soft' })
    const page = brandedSignInPage(template, { name: 'Acme', icon: 'picked', pickedIcon: picked })
    expect(page).toContain('viewBox="0 0 16 16"')
    expect(page).not.toContain('class="mark"')
    const unknown = brandedSignInPage(template, { name: 'Acme', icon: 'picked', pickedIcon: JSON.stringify({ kind: 'glyph', glyph: '"><script>' }) })
    expect(unknown).toContain('class="mark"')
    expect(unknown).not.toContain('<script>')
  })

  it('shows the default for an uploaded icon whose hash matches no file', () => {
    const template = '<html><head><title>Delorun</title></head><body><!--brand--><svg class="mark"></svg><span class="wordmark">Delorun</span><!--/brand--></body></html>'
    const page = brandedSignInPage(template, { name: 'Acme', icon: 'upload', uploadHash: 'd'.repeat(64) }, () => undefined)
    expect(page).toContain('class="mark"')
    expect(page).not.toContain('/auth/branding/icon')
  })
})
