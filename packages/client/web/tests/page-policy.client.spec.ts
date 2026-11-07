// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { config } from 'zod'
import { installStyleNonce } from '../src/page-policy.ts'

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

afterEach(() => {
  document.createElement = create
  document.head.innerHTML = ''
  config({ jitless: false })
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
