import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const brand = (path: string): string => fileURLToPath(new URL(`../../../../../packages/brand/src/${path}`, import.meta.url))

/** The preview server: the browser alone on a page, with the brand package and the upstream stand-in resolved as the site does. */
export default defineConfig(({ mode }) => ({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  resolve: {
    alias: [{ find: '@brand', replacement: brand('index.ts') }, { find: '#upstream', replacement: brand('upstream.web.tsx') }],
    dedupe: ['react', 'react-dom'],
  },
  server: { port: 18660, host: '127.0.0.1', fs: { allow: [fileURLToPath(new URL('../../../../..', import.meta.url))] } },
}))
