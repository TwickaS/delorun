import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router'
import { LOOK_SCRIPT, LOOK_SCRIPT_ID } from '@design/head-script.ts'
import { OG_IMAGE_PATH, SITE_URL } from '@/site/config.ts'
import { COPY } from '@/site/copy.ts'
import appCss from '@/styles/app.css?url'

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
      { property: 'og:image:alt', content: COPY.linkPreviewAlt },
      { name: 'twitter:card', content: 'summary_large_image' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
    ],
    scripts: [{ id: LOOK_SCRIPT_ID, children: LOOK_SCRIPT }],
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
