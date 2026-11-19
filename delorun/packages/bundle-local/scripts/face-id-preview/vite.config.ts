/**
 * Vite configuration of the Face ID screen preview: serves `index.html` on 127.0.0.1:19115 with the repository's
 * tsconfig paths, so the client packages resolve to their sources, as the client specs do.
 * @module @delorun/bundle-local/scripts/face-id-preview/vite.config
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vite'

const here = fileURLToPath(new URL('.', import.meta.url))
const repository = fileURLToPath(new URL('../../../../../', import.meta.url))
const clientRequire = createRequire(join(repository, 'packages/client/ui-primitives/package.json'))

export default defineConfig({
  root: here,
  plugins: [tsconfigPaths({ projects: [join(repository, 'tsconfig.base.json')] })],
  // The client packages hold React and react-dom; every import resolves to that one copy.
  resolve: { alias: { 'react-dom': dirname(clientRequire.resolve('react-dom/package.json')), react: dirname(clientRequire.resolve('react/package.json')) } },
  server: { host: '127.0.0.1', port: 19115, strictPort: true, fs: { allow: [repository] } },
})
