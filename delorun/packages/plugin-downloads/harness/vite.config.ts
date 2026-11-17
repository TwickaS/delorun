import { defineConfig } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  root: import.meta.dirname,
  esbuild: { jsx: 'automatic' },
  plugins: [tsconfigPaths({ root: '../../../..' })],
  server: { host: '127.0.0.1', port: 18571, strictPort: true },
})
