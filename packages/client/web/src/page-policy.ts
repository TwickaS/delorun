/**
 * Client boot adaptations for a page served under a nonce-based Content
 * Security Policy, such as a Delo reach listener's. Such a policy admits a
 * `<style>` element only when it carries the nonce of the response that served
 * the page, and refuses string evaluation. Evaluating this module, when the
 * page has a `<script nonce>` element, stamps that nonce on every `<style>`
 * element created through `document.createElement`, so the styles plugin
 * bundles and libraries create at run time apply, and puts zod in jitless
 * mode, so it never tries string evaluation. A page without such a script is
 * left unchanged. The Web entry imports this module before any other module,
 * so both are in place before any module creates a style or parses a value.
 * @module @deepseek-ai/dsh-client-web/page-policy
 */
import { config } from 'zod'

/**
 * Stamp the page's nonce on every `<style>` element `doc.createElement` creates
 * from now on. Does nothing when no `<script>` in `doc` carries a nonce.
 * @param doc - the document whose `createElement` is wrapped.
 * @returns the nonce being stamped, or `undefined` when none was found.
 */
export function installStyleNonce(doc: Document): string | undefined {
  const nonce = pageNonce(doc)
  if (nonce === undefined) return undefined
  const create = doc.createElement
  doc.createElement = function createElement(this: Document, tagName: string, options?: ElementCreationOptions) {
    const element = create.call(this, tagName, options)
    if (element.localName === 'style') element.nonce = nonce
    return element
  } as Document['createElement']
  return nonce
}

/**
 * The nonce of the page's first nonced `<script>`. Browsers expose a served
 * nonce only through the `nonce` property.
 * @param doc - the page.
 * @returns the nonce, or `undefined` when no script carries one.
 */
export function pageNonce(doc: Document): string | undefined {
  const nonce = doc.querySelector<HTMLScriptElement>('script[nonce]')?.nonce
  return nonce === undefined || nonce === '' ? undefined : nonce
}

if (typeof document !== 'undefined' && installStyleNonce(document) !== undefined) config({ jitless: true })
