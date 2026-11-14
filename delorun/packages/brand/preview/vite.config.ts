import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

/** The gallery's dev server: the studio build of `#upstream`, the studio's sources for its packages, and automatic JSX. */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  esbuild: { jsx: 'automatic' },
  resolve: {
    tsconfigPaths: true,
    // The brand package declares no react-dom; the gallery borrows the studio's copy.
    alias: [{ find: /^react-dom(\/|$)/, replacement: `/home/user/delo-run-wt/brand/node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom$1` }, { find: /^react(\/|$)/, replacement: `/home/user/delo-run-wt/brand/node_modules/.pnpm/react@18.3.1/node_modules/react$1` }],
    dedupe: ['react', 'react-dom'],
  },
  server: { host: '127.0.0.1', port: 47312, fs: { strict: false } },
})
