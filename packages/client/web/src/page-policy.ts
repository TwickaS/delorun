/**
 * Client boot adaptations for a page served under a nonce-based Content
 * Security Policy, such as a Delorun reach listener's. Such a policy admits a
 * `<style>` element only when it carries the nonce of the response that served
 * the page, and refuses string evaluation. Evaluating this module, when the
 * page has a `<script nonce>` element, stamps that nonce on every `<style>`
 * element created through `document.createElement`, so the styles plugin
 * bundles and libraries create at run time apply, and puts zod in jitless
 * mode, so it never tries string evaluation. A page without such a script is
 * left unchanged.
 *
 * The module also creates the three Trusted Types policies contract C4 names,
 * whenever the page's browser exposes `trustedTypes`: the `default` policy,
 * whose `createHTML` passes markup through the studio's HTML sanitiser so
 * upstream components and community client plugins that assign `innerHTML`
 * keep working, whose `createScriptURL` admits only the plugin bundle URLs the
 * client module registry's current boot manifest lists, and whose `createScript`
 * refuses every string; the `delorun-plugin-loader` policy, which applies the
 * same URL rule and which the client module loader assigns `script.src`
 * through; and the `delorun-blob-worker` policy, which admits a `blob:` URL
 * whose origin is the page's own, so a feature that runs its code in a Worker
 * built from a Blob can construct it. All three are inert on a page whose
 * Content Security Policy does not enforce Trusted Types. The loader reads the
 * `delorun-plugin-loader` policy from the `__DSH_TRUSTED_TYPES__` page global
 * and keeps the URL allowlist current through the stash's `register`; a feature
 * bundle reads the `delorun-blob-worker` policy from the same global.
 *
 * The Web entry imports this module before any other module, so all of this is
 * in place before any module creates a style, parses a value or loads a bundle.
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

/** Path prefix of the client plugin bundles the script URL rule admits. */
const PLUGIN_SCRIPT_PATH_PREFIX = '/plugins/'
/** File name of a bundle script under one package's row: `client.js` and its `client.<name>.js` chunks. */
const PLUGIN_BUNDLE_BASENAME = /^client(?:\.[A-Za-z0-9][A-Za-z0-9._-]*)?\.js$/

/** The slice of a parsed boot manifest the script URL allowlist reads. */
export interface BootBundleRows {
  readonly modules: ReadonlyArray<{ readonly id: string; readonly url: string }>
}

/** The exact bundle pathnames the current boot manifest lists. */
const pluginScriptPaths = new Set<string>()
/** The per-package path prefixes under which the manifest's rows load bundles and chunks. */
const pluginScriptPrefixes = new Set<string>()

/** The origin relative bundle URLs resolve against; a placeholder when no page exists. */
function pageOrigin(): string {
  return typeof location === 'undefined' ? 'https://studio.invalid' : location.origin
}

/**
 * Replace the script URL allowlist with the bundle paths of the client module
 * registry's current boot manifest. Until a manifest is registered the
 * allowlist is empty, so no plugin URL passes.
 * @param manifest - the parsed boot manifest.
 */
export function registerPluginScriptBundles(manifest: BootBundleRows): void {
  pluginScriptPaths.clear()
  pluginScriptPrefixes.clear()
  for (const row of manifest.modules) {
    try {
      pluginScriptPaths.add(new URL(row.url, pageOrigin()).pathname)
    } catch {
      // An unreadable row URL admits nothing; the package prefix still covers its bundles.
    }
    pluginScriptPrefixes.add(`${PLUGIN_SCRIPT_PATH_PREFIX}${row.id}/`)
  }
}

/**
 * C4's plugin script URL rule: the URL is same-origin, its path begins with
 * `/plugins/`, and that path without its query is a bundle the current boot
 * manifest lists — a row's own path, or a `client.js` bundle or `client.*.js`
 * chunk under a listed package's path prefix.
 * @param url - the URL a script sink is being assigned.
 * @returns the URL, or `null` when the rule refuses it.
 */
export function pluginScriptUrl(url: string): string | null {
  let target: URL
  try {
    target = new URL(url, pageOrigin())
  } catch {
    return null
  }
  if (target.origin !== pageOrigin()) return null
  if (!target.pathname.startsWith(PLUGIN_SCRIPT_PATH_PREFIX)) return null
  const base = target.pathname.lastIndexOf('/') + 1
  let prefixed = false
  for (const prefix of pluginScriptPrefixes) {
    if (target.pathname.startsWith(prefix)) {
      prefixed = true
      break
    }
  }
  const listed = pluginScriptPaths.has(target.pathname)
    || (prefixed && PLUGIN_BUNDLE_BASENAME.test(target.pathname.slice(base)))
  return listed ? url : null
}

/**
 * The blob Worker URL rule: the URL is a `blob:` URL whose origin is the page's
 * own. A blob URL inherits the origin of the page that created it, so this
 * admits a Worker source this page built and refuses one another origin built.
 * A page with an opaque origin (`null`) is refused every URL, because every
 * opaque origin has the same string form, so a blob URL cannot be shown to be
 * this page's.
 * @param url - the URL a Worker constructor is being given.
 * @param origin - the page's origin; the page's own unless a caller names one.
 * @returns the URL, or `null` when the rule refuses it.
 */
export function blobWorkerScriptUrl(url: string, origin: string = pageOrigin()): string | null {
  if (origin === 'null') return null
  let target: URL
  try {
    target = new URL(url, origin)
  } catch {
    return null
  }
  if (target.protocol !== 'blob:') return null
  return target.origin === origin ? url : null
}

/** One created Trusted Types policy: the browser wraps each callback's result. */
interface TrustedScriptUrlPolicy {
  createScriptURL(input: string): string | null
}

/** The Trusted Types policy factory's slice the page uses (`window.trustedTypes`). */
interface TrustedTypePolicyFactory {
  createPolicy<T>(policyName: string, policy: {
    createHTML?: (input: string) => string
    createScriptURL?: (input: string) => string | null
    createScript?: (input: string) => string | null
  }): T
}

/**
 * The page boot's Trusted Types stash: what the client module loader reads to
 * assign `script.src` through the named policy and to keep the URL allowlist
 * current, exposed as the `__DSH_TRUSTED_TYPES__` page global.
 */
export interface TrustedTypesStash {
  /** The `delorun-plugin-loader` policy, which applies the script URL rule. */
  readonly pluginLoader: TrustedScriptUrlPolicy
  /** The `delorun-blob-worker` policy, which admits a same-origin `blob:` Worker URL. */
  readonly blobWorker: TrustedScriptUrlPolicy
  /** Replace the allowlist with the client module registry's current boot manifest. */
  register(manifest: BootBundleRows): void
}

/** Page global the stash is exposed under. */
const TRUSTED_TYPES_STASH = '__DSH_TRUSTED_TYPES__'

/**
 * The studio's HTML sanitiser, the default policy's `createHTML`: it removes
 * `<script>` elements, event-handler attributes, `javascript:` URLs and
 * `<iframe srcdoc>`, and returns the rest, so upstream components and
 * community client plugins that assign `innerHTML` keep working.
 * @param html - the markup a sink is being assigned.
 * @returns the sanitised markup.
 */
export function sanitiseHtml(html: string): string {
  // The parse below is itself a Trusted Types sink and would call this policy again without end.
  if (sanitising) return html
  sanitising = true
  try {
    return sanitiseParsed(html)
  } finally {
    sanitising = false
  }
}

/** Whether {@link sanitiseHtml} is running, so its own parse reaches the sink without a second pass. */
let sanitising = false

function sanitiseParsed(html: string): string {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  for (const script of parsed.querySelectorAll('script')) script.remove()
  for (const element of parsed.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      const scheme = attribute.value.replace(/[^\S]|[\x00-\x1f]/gu, '').toLowerCase()
      if (attribute.name.toLowerCase().startsWith('on') || attribute.name.toLowerCase() === 'srcdoc'
        || scheme.startsWith('javascript:')) {
        element.removeAttribute(attribute.name)
      }
    }
  }
  return parsed.body.innerHTML
}

/**
 * Create the `default`, `delorun-plugin-loader` and `delorun-blob-worker`
 * Trusted Types policies and expose the last two, with the allowlist registry,
 * to the client module loader and to the feature bundles that build a Worker
 * from a Blob. Does nothing when the page's browser has no `trustedTypes`, and
 * leaves the page unchanged when a policy name is already taken.
 * @param scope - the page's global scope.
 * @returns the stash the loader reads, or `undefined` without Trusted Types support.
 */
export function installTrustedTypes(scope: { trustedTypes?: TrustedTypePolicyFactory }): TrustedTypesStash | undefined {
  const factory = scope.trustedTypes
  if (factory === undefined) return undefined
  try {
    factory.createPolicy('default', {
      createHTML: sanitiseHtml,
      createScriptURL: pluginScriptUrl,
      createScript: () => null,
    })
    const pluginLoader = factory.createPolicy<TrustedScriptUrlPolicy>('delorun-plugin-loader', {
      createScriptURL: pluginScriptUrl,
    })
    const blobWorker = factory.createPolicy<TrustedScriptUrlPolicy>('delorun-blob-worker', {
      createScriptURL: blobWorkerScriptUrl,
    })
    const stash: TrustedTypesStash = { pluginLoader, blobWorker, register: registerPluginScriptBundles }
    ;(globalThis as { __DSH_TRUSTED_TYPES__?: TrustedTypesStash })[TRUSTED_TYPES_STASH] = stash
    return stash
  } catch {
    return undefined
  }
}

if (typeof document !== 'undefined' && installStyleNonce(document) !== undefined) config({ jitless: true })
if (typeof window !== 'undefined') {
  const factory = (window as { trustedTypes?: TrustedTypePolicyFactory }).trustedTypes
  if (factory !== undefined) installTrustedTypes({ trustedTypes: factory })
}
