import { zhCN } from '@fumadocs/language/zh-cn'
import { createRootRoute, HeadContent, Outlet, Scripts, useRouterState } from '@tanstack/react-router'
import { i18nProvider, uiTranslations } from 'fumadocs-ui/i18n'
import { RootProvider } from 'fumadocs-ui/provider/tanstack'
import StaticSearchDialog from '@/components/search.tsx'
import { htmlLangOf, localeOfPath } from '@/site/locale.ts'
import { i18n } from '@/site/source.ts'
import appCss from '@/styles/app.css?url'

// The interface labels Fumadocs shows (search, table of contents, theme and sidebar controls), in each locale.
const translations = i18n.translations().extend(uiTranslations()).preset('zh', zhCN())

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }, { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' }],
  }),
  component: RootDocument,
})

/**
 * The document every page renders in: its language follows the page's locale, and the provider carries the
 * interface labels and the static search dialog.
 * @returns the document.
 */
function RootDocument() {
  const locale = localeOfPath(useRouterState({ select: state => state.location.pathname }))
  return (
    <html lang={htmlLangOf(locale)} suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="flex min-h-screen flex-col">
        <RootProvider i18n={i18nProvider(translations, locale)} search={{ SearchDialog: StaticSearchDialog }}>
          <Outlet />
        </RootProvider>
        <Scripts />
      </body>
    </html>
  )
}
