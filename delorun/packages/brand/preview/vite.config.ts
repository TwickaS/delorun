import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

/** The directory of the studio's copy of a package that the brand package does not declare. */
const studioPackage = (name: string): string => dirname(createRequire(new URL('../../../../packages/client/ui-primitives/package.json', import.meta.url)).resolve(`${name}/package.json`))

/** The gallery's dev server: the studio build of `#upstream`, the studio's sources for its packages, and automatic JSX. */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  esbuild: { jsx: 'automatic' },
  resolve: {
    tsconfigPaths: true,
    // The brand package declares no react-dom; the gallery borrows the studio's copy.
    alias: [{ find: /^react-dom(\/|$)/, replacement: `${studioPackage('react-dom')}$1` }, { find: /^react(\/|$)/, replacement: `${studioPackage('react')}$1` }],
    dedupe: ['react', 'react-dom'],
  },
  server: { host: '127.0.0.1', port: 47312, fs: { strict: false } },
})
