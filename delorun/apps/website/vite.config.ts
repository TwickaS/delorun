import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { loadView, type ChangelogView } from '../../packages/site-design/src/changelog.ts'

/** The static site's directory: the client build, with every prerendered page. */
const OUT_DIR = 'out'

/** The pages the build prerenders; the site has no others. */
const PAGES = ['/', '/privacy', '/404']

/**
 * The not-found page without the router's scripts. A static host serves 404.html at any address, where the page's own
 * route data would not match the address the browser hydrates, so the page is plain HTML and CSS plus the theme script.
 * @param html - the prerendered page.
 * @returns the page with no router script and no module preload.
 */
function withoutRouterScripts(html: string): string {
  return html.replace(/<script\b(?![^>]*\bid="theme-init")[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*rel="modulepreload"[^>]*>/g, '')
}

/** The id components import the changelog view through. */
const CHANGELOG_MODULE = 'virtual:delorun-changelog'

/**
 * The module that carries the changelog view into the server and client bundles.
 * @param view - the view, or undefined when no version is assembled.
 * @returns the plugin.
 */
function changelogModule(view: ChangelogView | undefined): Plugin {
  return {
    name: 'delorun-changelog',
    resolveId: source => source === CHANGELOG_MODULE ? `\0${CHANGELOG_MODULE}` : undefined,
    load: id => id === `\0${CHANGELOG_MODULE}` ? `export default ${JSON.stringify(view ?? null)}` : undefined,
  }
}

// With no assembled version there is no record: the What's new section is left out.
const changelog = loadView(resolve(process.cwd(), '../../..'))

export default defineConfig({
  build: { outDir: '.build' },
  environments: { client: { build: { outDir: OUT_DIR } } },
  plugins: [
    changelogModule(changelog),
    tailwindcss(),
    tanstackStart({
      router: { generatedRouteTree: '../routeTree.gen.ts' },
      prerender: {
        enabled: true,
        autoSubfolderIndex: false,
        autoStaticPathsDiscovery: false,
        crawlLinks: false,
        failOnError: true,
      },
      pages: PAGES.map(path => path === '/404'
        ? { path, prerender: { onSuccess: ({ html }: { html: string }) => writeFileSync(join(OUT_DIR, '404.html'), withoutRouterScripts(html)) } }
        : { path }),
    }),
    react(),
  ],
  resolve: {
    tsconfigPaths: true,
    // The shared design's stylesheet imports Fumadocs UI's CSS from outside this directory, so the import resolves to this site's install.
    alias: [{ find: '#upstream', replacement: fileURLToPath(new URL('../../packages/brand/src/upstream.web.tsx', import.meta.url)) }, { find: /^fumadocs-ui\/css\//, replacement: fileURLToPath(new URL('./node_modules/fumadocs-ui/css/', import.meta.url)) }],
    dedupe: ['react', 'react-dom'],
  },
})
