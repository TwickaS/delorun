/**
 * The small pages the Worker answers with: the result of a form posted without scripts, and the confirmation and
 * unsubscribe pages. They carry their own styles, because they are not part of the built site, and load nothing.
 *
 * @module @delo/website/worker/pages
 */
import { SITE_URL, TRADING_NAME } from '../site/config.ts'
import { escapeHtml } from './mail.ts'

/** The styles: the site's neutral light and dark colours. */
const STYLE = `
:root{color-scheme:light dark;--bg:#fff;--fg:#0a0a0a;--muted:#525252;--border:#d4d4d4}
@media (prefers-color-scheme:dark){:root{--bg:#0a0a0a;--fg:#fafafa;--muted:#a3a3a3;--border:#404040}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 ui-sans-serif,system-ui,sans-serif}
main{max-width:34rem;margin:0 auto;padding:4rem 1.25rem}
h1{font-size:1.75rem;line-height:1.2;margin:0 0 1rem}
p{margin:0 0 1rem}
a{color:inherit;text-underline-offset:.25em}
button{font:inherit;font-weight:600;color:var(--bg);background:var(--fg);border:0;border-radius:.5rem;padding:.65rem 1.1rem;cursor:pointer}
a:focus-visible,button:focus-visible{outline:2px solid var(--fg);outline-offset:3px}
.muted{color:var(--muted);font-size:.9rem}
`

/** A button that posts to a path with the token the link carried. */
export interface PageAction {
  readonly path: string
  readonly token: string
  readonly label: string
}

/**
 * Builds a page. Responses are not cached, are not indexed and send no referrer, because the address of a
 * confirmation or unsubscribe page carries a token.
 * @param status - the HTTP status.
 * @param title - the heading and title.
 * @param paragraphs - the text.
 * @param action - an optional button that posts.
 * @returns the response.
 */
export function page(status: number, title: string, paragraphs: readonly string[], action?: PageAction): Response {
  const form = action === undefined ? '' : `<form method="post" action="${escapeHtml(action.path)}"><input type="hidden" name="token" value="${escapeHtml(action.token)}"><button type="submit">${escapeHtml(action.label)}</button></form>`
  const html = `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)} | Delorun</title><style>${STYLE}</style></head>
<body><main><h1>${escapeHtml(title)}</h1>${paragraphs.map(text => `<p>${escapeHtml(text)}</p>`).join('')}${form}<p class="muted"><a href="${SITE_URL}/">Back to delorun.com</a> &middot; ${escapeHtml(TRADING_NAME)}</p></main></body></html>`
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    },
  })
}
