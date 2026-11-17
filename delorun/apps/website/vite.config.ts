import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { STUDIO_ALIASES } from './studio-aliases.ts'
import { linkChunkStyles } from './scripts/styles.ts'
import { RENDERED_CHUNK_STYLES, SITEMAP_PATHS } from './src/site/config.ts'
import { sitemapPaths, sitemapXml } from './src/site/sitemap.ts'
import { readNotices, type Notice } from '../../packages/site-design/scripts/notices.ts'
import { headlinesOnly, loadView, type ChangelogView } from '../../packages/site-design/src/changelog.ts'

/** The static site's directory: the client build, with every prerendered page. */
const OUT_DIR = 'out'

/** The pages the build prerenders; the site has no others. */
const PAGES = ['/', '/blog', '/privacy', '/notices', '/404']

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

/** The id the notices page imports the licence texts through. */
const NOTICES_MODULE = 'virtual:delorun-notices'

/**
 * The module that carries the licence texts into the bundles of the notices page.
 * @param notices - the notices, read from the files that ship the material.
 * @returns the plugin.
 */
function noticesModule(notices: readonly Notice[]): Plugin {
  return {
    name: 'delorun-notices',
    resolveId: source => source === NOTICES_MODULE ? `\0${NOTICES_MODULE}` : undefined,
    load: id => id === `\0${NOTICES_MODULE}` ? `export default ${JSON.stringify(notices)}` : undefined,
  }
}

/** The number of published articles; the blog index is in the sitemap only when it is above zero. */
const articleCount = existsSync('content/blog') ? readdirSync('content/blog').filter(name => name.endsWith('.md')).length : 0

/**
 * Writes `sitemap.xml` into the client output after the pages are prerendered.
 * @returns the plugin.
 */
function sitemapFile(): Plugin {
  return {
    name: 'delorun-sitemap',
    apply: 'build',
    closeBundle: { order: 'post', sequential: true, handler() { if (existsSync(OUT_DIR)) writeFileSync(join(OUT_DIR, 'sitemap.xml'), sitemapXml(sitemapPaths(SITEMAP_PATHS, articleCount))) } },
  }
}

/**
 * Links the stylesheets of the chunks the prerender renders but the browser loads later (`RENDERED_CHUNK_STYLES`), once
 * the pages are prerendered.
 * @returns the plugin.
 */
function chunkStyles(): Plugin {
  return {
    name: 'delorun-chunk-styles',
    apply: 'build',
    closeBundle: { order: 'post', sequential: true, handler() { if (existsSync(OUT_DIR)) linkChunkStyles(OUT_DIR, RENDERED_CHUNK_STYLES) } },
  }
}

// With no assembled version there is no record: the What's new section is left out.
const changelog = loadView(resolve(process.cwd(), '../../..'))

const notices = readNotices({ packages: resolve(process.cwd(), '../../packages'), sonnerLicence: resolve(process.cwd(), 'node_modules/sonner/LICENSE.md') })

export default defineConfig({
  build: { outDir: '.build' },
  environments: { client: { build: { outDir: OUT_DIR } } },
  plugins: [
    changelogModule(headlinesOnly(changelog)),
    noticesModule(notices),
    sitemapFile(),
    chunkStyles(),
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
    alias: [...STUDIO_ALIASES, { find: '#upstream', replacement: fileURLToPath(new URL('../../packages/brand/src/upstream.web.tsx', import.meta.url)) }, { find: /^sonner$/, replacement: fileURLToPath(new URL('./node_modules/sonner', import.meta.url)) }, { find: /^fumadocs-ui\/css\//, replacement: fileURLToPath(new URL('./node_modules/fumadocs-ui/css/', import.meta.url)) }],
    dedupe: ['react', 'react-dom'],
  },
})
