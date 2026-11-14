/**
 * Puts `tokens.css` in the document once as a `<style data-delorun-brand-tokens>` element. A studio plugin's browser
 * bundle drops a bare `import './tokens.css'` because the bundler treats the stylesheet module as side-effect free, so
 * the brand loads its tokens through this module, which `package.json` lists in `sideEffects`.
 * @module @delorun/brand/tokens-style
 */
import tokens from './tokens.css?inline'

if (typeof document !== 'undefined' && document.querySelector('style[data-delorun-brand-tokens]') === null) {
  const tag = document.createElement('style')
  tag.dataset.delorunBrandTokens = ''
  tag.textContent = tokens
  document.head.appendChild(tag)
}
