import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import react from '@vitejs/plugin-react'
import { fumadocsMdx } from 'fumadocs-mdx/vite'
import { defineConfig, type Plugin } from 'vite'
import { loadView, type ChangelogView } from './src/site/changelog.ts'
import { repositoryRoot } from './src/site/doc-links.ts'
import { prerenderPaths } from './src/site/pages.ts'

// The release tooling's package.json is the one source of the Delo version the pages describe.
const release = JSON.parse(readFileSync(new URL('../release/package.json', import.meta.url), 'utf8')) as { version: string }

/** The static site's directory: the client build, with every prerendered page. */
const OUT_DIR = 'out'

/**
 * The not-found page without its scripts. A static host serves 404.html at any address, where the page's own route
 * data would not match the address the browser hydrates, so the page is plain HTML and CSS.
 * @param html - the prerendered page.
 * @returns the page with no script element and no module preload.
 */
function withoutScripts(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*rel="modulepreload"[^>]*>/g, '')
}

/** The id components import the changelog view through. */
const CHANGELOG_MODULE = 'virtual:delo-changelog'

/**
 * The module that carries the changelog view into the server and client bundles, so the page and the home section
 * render it without a server or a file read in the browser.
 * @param view - the view, or undefined when no version is assembled.
 * @returns the plugin.
 */
function changelogModule(view: ChangelogView | undefined): Plugin {
  return {
    name: 'delo-changelog',
    resolveId: source => source === CHANGELOG_MODULE ? `\0${CHANGELOG_MODULE}` : undefined,
    load: id => id === `\0${CHANGELOG_MODULE}` ? `export default ${JSON.stringify(view ?? null)}` : undefined,
  }
}

// With no assembled version there is no record: the changelog page and the home section are left out.
const changelog = loadView(repositoryRoot())

export default defineConfig({
  define: { 'import.meta.env.DELO_VERSION': JSON.stringify(release.version) },
  // The static site is the client build in out/; the server build under .build/ exists only to prerender it.
  build: { outDir: '.build' },
  environments: { client: { build: { outDir: OUT_DIR } } },
  plugins: [
    changelogModule(changelog),
    fumadocsMdx(),
    tailwindcss(),
    tanstackStart({
      // Generated from src/routes/ on each build into the site's directory (the path is relative to src/); not committed.
      router: { generatedRouteTree: '../routeTree.gen.ts' },
      prerender: {
        enabled: true,
        // `/guide` is written as guide.html beside guide/, so a static host serves it without a trailing-slash redirect.
        autoSubfolderIndex: false,
        // Every page is listed below, and only those are built; a page link the list misses fails the link check.
        autoStaticPathsDiscovery: false,
        crawlLinks: false,
        failOnError: true,
      },
      pages: prerenderPaths(repositoryRoot(), changelog !== undefined).map(path => path === '/404'
        ? { path, prerender: { onSuccess: ({ html }) => writeFileSync(join(OUT_DIR, '404.html'), withoutScripts(html)) } }
        : { path }),
    }),
    react(),
  ],
  resolve: { tsconfigPaths: true },
})
