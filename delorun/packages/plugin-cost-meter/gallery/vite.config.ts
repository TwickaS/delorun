/**
 * The plan-limits gallery's dev server: it renders the real sign-in line, limit bars, Settings card and Plans pill over
 * seeded figures, for pictures. Run from the repository root with
 * `node_modules/.bin/vite --config delorun/packages/plugin-cost-meter/gallery/vite.config.ts --port <port> --host 127.0.0.1`.
 */
import { fileURLToPath } from 'node:url'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vite'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [tsconfigPaths({ projects: [fileURLToPath(new URL('../../../../tsconfig.base.json', import.meta.url))] })],
  server: { fs: { strict: false } },
})
