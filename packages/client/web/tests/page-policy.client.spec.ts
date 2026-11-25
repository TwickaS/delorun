// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { config } from 'zod'
import { blobWorkerScriptUrl, installStyleNonce, installTrustedTypes, pluginScriptUrl, registerPluginScriptBundles, sanitiseHtml } from '../src/page-policy.ts'

/** Mark the scripts of `doc` that carry a `nonce` attribute; jsdom does not reflect it into the property browsers expose. */
function exposeNonces(doc: Document): void {
  for (const script of doc.querySelectorAll('script')) {
    const value = script.getAttribute('nonce')
    if (value !== null) script.nonce = value
  }
}

function page(scripts: string): Document {
  const doc = document.implementation.createHTMLDocument()
  doc.head.innerHTML = scripts
  exposeNonces(doc)
  return doc
}

const create = document.createElement

/** A Trusted Types policy factory that records the policies it is asked to create. */
function policyFactory(): {
  created: Array<{ name: string; definition: Record<string, unknown> }>
  trustedTypes: Parameters<typeof installTrustedTypes>[0]['trustedTypes'] & object
} {
  const created: Array<{ name: string; definition: Record<string, unknown> }> = []
  return {
    created,
    trustedTypes: {
      createPolicy: (name: string, definition: Record<string, unknown>) => {
        created.push({ name, definition })
        return definition
      },
    } as Parameters<typeof installTrustedTypes>[0]['trustedTypes'] & object,
  }
}

const stashGlobal = globalThis as { __DSH_TRUSTED_TYPES__?: unknown }

afterEach(() => {
  document.createElement = create
  document.head.innerHTML = ''
  config({ jitless: false })
  delete stashGlobal.__DSH_TRUSTED_TYPES__
  registerPluginScriptBundles({ modules: [] })
})

it('stamps the nonce of the page\'s first nonced script on every created <style> element and on nothing else', () => {
  const doc = page('<script></script><script nonce="n0nce"></script><script nonce="other"></script>')
  expect(installStyleNonce(doc)).toBe('n0nce')
  const style = doc.createElement('style')
  const upper = doc.createElement('STYLE')
  const div = doc.createElement('div')
  expect([style.nonce, upper.nonce, div.nonce]).toEqual(['n0nce', 'n0nce', ''])
  expect(style.ownerDocument).toBe(doc)
})

it('leaves a page without a nonced script unchanged', () => {
  const doc = page('<script></script>')
  const original = doc.createElement
  expect(installStyleNonce(doc)).toBeUndefined()
  expect(doc.createElement).toBe(original)
  expect(doc.createElement('style').nonce).toBe('')
})

it('on evaluation, stamps style nonces and makes zod jitless only on a page with a nonced script', async () => {
  vi.resetModules()
  await import('../src/page-policy.ts')
  expect([document.createElement, config().jitless]).toEqual([create, false])

  document.head.innerHTML = '<script nonce="served"></script>'
  exposeNonces(document)
  vi.resetModules()
  await import('../src/page-policy.ts')
  expect(document.createElement('style').nonce).toBe('served')
  expect(config().jitless).toBe(true)
})

it('creates the default, delorun-plugin-loader and delorun-blob-worker policies and stashes the two URL policies', () => {
  const { created, trustedTypes } = policyFactory()
  const stash = installTrustedTypes({ trustedTypes })
  expect(created.map(policy => policy.name)).toEqual(['default', 'delorun-plugin-loader', 'delorun-blob-worker'])
  const [fallback, loader, blobWorker] = created
  expect(Object.keys(fallback?.definition ?? {}).sort()).toEqual(['createHTML', 'createScript', 'createScriptURL'])
  expect(Object.keys(loader?.definition ?? {})).toEqual(['createScriptURL'])
  expect(Object.keys(blobWorker?.definition ?? {})).toEqual(['createScriptURL'])
  expect(stash?.pluginLoader).toBe(loader?.definition)
  expect(stash?.blobWorker).toBe(blobWorker?.definition)
  expect(stashGlobal.__DSH_TRUSTED_TYPES__).toBe(stash)
})

it('leaves a page without Trusted Types support unchanged', () => {
  expect(installTrustedTypes({})).toBeUndefined()
  expect(stashGlobal.__DSH_TRUSTED_TYPES__).toBeUndefined()
})

it('the default policy sanitises HTML: scripts, event handlers, javascript: URLs and iframe srcdoc go, the rest stays', () => {
  const clean = sanitiseHtml(
    '<p title="kept">hi</p><script>bad()</script><SCRIPT>also()</SCRIPT>'
    + '<img src="/kept.png" onerror="x()"><a href=" javascript:evil() ">link</a>'
    + '<a href="/kept">kept</a><a href="java\tscript:evil()">tabbed</a>'
    + '<iframe srcdoc="<b>framed</b>" name="kept"></iframe>',
  )
  expect(clean).not.toContain('<script')
  expect(clean).not.toContain('onerror')
  expect(clean).not.toContain('javascript:')
  expect(clean).not.toContain('srcdoc')
  expect(clean).toContain('<p title="kept">hi</p>')
  expect(clean).toContain('<img src="/kept.png">')
  expect(clean).toContain('<a href="/kept">kept</a>')
  expect(clean).toContain('<iframe name="kept">')
})

it('createScript always refuses, and both policies apply the same script URL rule', () => {
  const { created, trustedTypes } = policyFactory()
  installTrustedTypes({ trustedTypes })
  const [fallback, loader] = created
  expect(fallback?.definition.createScript).toBeTypeOf('function')
  expect((fallback?.definition.createScript as (input: string) => string | null)('eval("x")')).toBeNull()
  expect(fallback?.definition.createScriptURL).toBe(loader?.definition.createScriptURL)
})

it('createScriptURL admits only same-origin plugin bundle URLs the registered boot manifest lists', () => {
  registerPluginScriptBundles({
    modules: [
      { id: 'a', url: 'plugins/??a/client.js&rev=1' },
      { id: '@scope/b', url: 'plugins/??@scope/b/client.js&rev=1' },
    ],
  })
  // The page's origin is jsdom's default; the row URLs are app-directory-relative, as the host composes them.
  expect(pluginScriptUrl('plugins/??a/client.js&rev=1')).toBe('plugins/??a/client.js&rev=1')
  expect(pluginScriptUrl('plugins/a/client.js?rev=1')).toBe('plugins/a/client.js?rev=1')
  expect(pluginScriptUrl('/plugins/a/client.hmr3.js?rev=2')).toBe('/plugins/a/client.hmr3.js?rev=2')
  expect(pluginScriptUrl('/plugins/@scope/b/client.js?rev=1')).toBe('/plugins/@scope/b/client.js?rev=1')
  expect(pluginScriptUrl('https://evil.test/plugins/a/client.js')).toBeNull()
  expect(pluginScriptUrl('/plugins/notlisted/client.js?rev=1')).toBeNull()
  expect(pluginScriptUrl('/plugins/a/assets/icon.svg')).toBeNull()
  expect(pluginScriptUrl('/plugins/a/other.js?rev=1')).toBeNull()
  expect(pluginScriptUrl('/app.js')).toBeNull()
  expect(pluginScriptUrl('not a url')).toBeNull()
})

it('createScriptURL refuses every plugin URL until a boot manifest is registered', () => {
  expect(pluginScriptUrl('/plugins/a/client.js?rev=1')).toBeNull()
})

it('the blob Worker rule admits a blob: URL of this page\'s own origin and nothing else', () => {
  const origin = location.origin
  expect(blobWorkerScriptUrl(`blob:${origin}/0b7c1f6e-0000-4000-8000-000000000000`))
    .toBe(`blob:${origin}/0b7c1f6e-0000-4000-8000-000000000000`)
  // Another origin's blob URL: a blob URL inherits the origin of the page that made it, so this one is not ours.
  expect(blobWorkerScriptUrl('blob:https://evil.test/0b7c1f6e-0000-4000-8000-000000000000')).toBeNull()
  // A different scheme, a same-origin path, and a string that is not a URL at all.
  expect(blobWorkerScriptUrl('data:text/javascript,self.postMessage(1)')).toBeNull()
  expect(blobWorkerScriptUrl('/plugins/a/client.js')).toBeNull()
  expect(blobWorkerScriptUrl('not a url')).toBeNull()
  // A blob URL with no origin part has an opaque origin, which is never the page's.
  expect(blobWorkerScriptUrl('blob:0b7c1f6e-0000-4000-8000-000000000000')).toBeNull()
})

it('the blob Worker rule refuses every URL on a page with an opaque origin', () => {
  // Every opaque origin has the same string form, so no blob URL can be shown to be this page's.
  expect(blobWorkerScriptUrl('blob:null/0b7c1f6e-0000-4000-8000-000000000000', 'null')).toBeNull()
  expect(blobWorkerScriptUrl('blob:https://studio.test/0b7c1f6e-0000-4000-8000-000000000000', 'null')).toBeNull()
})

it('does not run the sanitiser again on the markup its own parse is given', () => {
  // A browser that enforces Trusted Types sends the parse's string through the default policy, which is this function.
  const realParse = DOMParser.prototype.parseFromString
  const nested: string[] = []
  const parse = vi.spyOn(DOMParser.prototype, 'parseFromString').mockImplementation(function (this: DOMParser, markup: string, type: DOMParserSupportedType) {
    nested.push(sanitiseHtml(markup))
    return realParse.call(this, markup, type)
  })
  expect(sanitiseHtml('<p onclick="x()">kept</p>')).toBe('<p>kept</p>')
  expect(nested).toEqual(['<p onclick="x()">kept</p>'])
  parse.mockRestore()
  // The guard is released afterwards, and when the parse throws.
  expect(sanitiseHtml('<b onload="y()">next</b>')).toBe('<b>next</b>')
  vi.spyOn(DOMParser.prototype, 'parseFromString').mockImplementation(() => { throw new Error('parse failed') })
  expect(() => sanitiseHtml('<i>x</i>')).toThrow('parse failed')
  vi.restoreAllMocks()
  expect(sanitiseHtml('<u onerror="z()">after</u>')).toBe('<u>after</u>')
})
