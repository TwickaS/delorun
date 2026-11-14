import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router'
import { OG_IMAGE_PATH, SITE_URL } from '@/site/config.ts'
import { COPY } from '@/site/copy.ts'
import appCss from '@/styles/app.css?url'

/** Colours the page by the device's light or dark setting, before the first paint and when the setting changes. */
const THEME_SCRIPT = "(function(){var m=matchMedia('(prefers-color-scheme: dark)');function a(){document.documentElement.classList.toggle('dark',m.matches)}a();m.addEventListener('change',a)})()"

/** The id the build keeps when it strips the router's scripts from 404.html. */
export const THEME_SCRIPT_ID = 'theme-init'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { name: 'description', content: COPY.description },
      { property: 'og:site_name', content: COPY.siteTitle },
      { property: 'og:type', content: 'website' },
      { property: 'og:title', content: `${COPY.siteTitle}: ${COPY.tagline}` },
      { property: 'og:description', content: COPY.description },
      { property: 'og:image', content: `${SITE_URL}${OG_IMAGE_PATH}` },
      { property: 'og:image:alt', content: 'The Delorun mark and the words Delorun, an agent harness that runs on your own computer.' },
      { name: 'twitter:card', content: 'summary_large_image' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
    ],
    scripts: [{ id: THEME_SCRIPT_ID, children: THEME_SCRIPT }],
  }),
  component: RootDocument,
})

/**
 * The document every page renders in.
 * @returns the document.
 */
function RootDocument() {
  return (
    <html lang="en-GB" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="flex min-h-screen flex-col">
        <Outlet />
        <Scripts />
      </body>
    </html>
  )
}
