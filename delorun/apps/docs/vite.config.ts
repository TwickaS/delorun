import { cpSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import react from '@vitejs/plugin-react'
import { fumadocsMdx } from 'fumadocs-mdx/vite'
import { defineConfig, type Plugin } from 'vite'
import { loadView, type ChangelogView } from '../../packages/site-design/src/changelog.ts'
import { repositoryRoot } from './src/site/doc-links.ts'
import { prerenderPaths } from './src/site/pages.ts'
import { redirectsFile } from './src/site/redirects.ts'
import { pagePaths, sitemapXml } from './src/site/sitemap.ts'

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
const CHANGELOG_MODULE = 'virtual:delorun-changelog'

/**
 * The module that carries the changelog view into the server and client bundles, so the page and the home section
 * render it without a server or a file read in the browser.
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

// With no assembled version there is no record: the changelog page and the home section are left out.
const changelog = loadView(repositoryRoot())

// The pages describe the newest assembled version; with no record they name none.
const describedVersion = changelog?.versions[0]?.version ?? ''

const paths = prerenderPaths(repositoryRoot(), changelog !== undefined)

/**
 * Writes `sitemap.xml` into the client output after the pages are prerendered.
 * @returns the plugin.
 */
function sitemapFile(): Plugin {
  return {
    name: 'delorun-sitemap',
    apply: 'build',
    closeBundle: { order: 'post', sequential: true, handler() { writeFileSync(join(OUT_DIR, 'sitemap.xml'), sitemapXml(pagePaths(paths))) } },
  }
}

/**
 * Writes `_redirects` into the client output: the permanent redirects from the addresses pages had before they moved
 * into groups. The host reads the file as redirect rules, beside `_headers`.
 * @returns the plugin.
 */
function redirectsRules(): Plugin {
  return {
    name: 'delorun-redirects',
    apply: 'build',
    closeBundle: { order: 'post', sequential: true, handler() { writeFileSync(join(OUT_DIR, '_redirects'), redirectsFile()) } },
  }
}

/**
 * Copies the guide's pictures into the client output at `/guide/pictures/`. The pages' HTML bundles each picture with a
 * content hash; the Markdown routes keep the relative path `pictures/<file>`, which resolves there.
 * @returns the plugin.
 */
function guidePictures(): Plugin {
  return {
    name: 'delorun-guide-pictures',
    apply: 'build',
    closeBundle: { order: 'post', sequential: true, handler() { cpSync(join(repositoryRoot(), 'delorun/docs/guide/pictures'), join(OUT_DIR, 'guide/pictures'), { recursive: true }) } },
  }
}

export default defineConfig({
  define: { 'import.meta.env.DELORUN_VERSION': JSON.stringify(describedVersion) },
  // The static site is the client build in out/; the server build under .build/ exists only to prerender it.
  build: { outDir: '.build' },
  environments: { client: { build: { outDir: OUT_DIR } } },
  plugins: [
    changelogModule(changelog),
    sitemapFile(),
    redirectsRules(),
    guidePictures(),
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
      pages: paths.map(path => path === '/404'
        ? { path, prerender: { onSuccess: ({ html }) => writeFileSync(join(OUT_DIR, '404.html'), withoutScripts(html)) } }
        : { path }),
    }),
    react(),
  ],
  resolve: {
    tsconfigPaths: true,
    // The shared design's stylesheet imports Fumadocs UI's CSS from outside this directory, so the import resolves to this site's install.
    alias: [{ find: '#upstream', replacement: fileURLToPath(new URL('../../packages/brand/src/upstream.web.tsx', import.meta.url)) }, { find: /^sonner$/, replacement: fileURLToPath(new URL('./node_modules/sonner', import.meta.url)) }, { find: /^fumadocs-ui\/css\//, replacement: fileURLToPath(new URL('./node_modules/fumadocs-ui/css/', import.meta.url)) }],
    // The shared design's components import React from outside this directory; every copy must be this site's.
    dedupe: ['react', 'react-dom'],
  },
})
