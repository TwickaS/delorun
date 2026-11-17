/**
 * The replica's local preview server: the site's aliases, the replica's build plugins and the site's stylesheet, on
 * port 18670. Not part of the site's build.
 * @module @delorun/website/replica/preview/vite.config
 */
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { STUDIO_ALIASES } from '../../../studio-aliases.ts'
import { replicaPlugins } from '../build/plugins.ts'

const at = (path: string): string => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  root: at('./'),
  // The brand's fonts sit in `delorun/packages/brand`, outside this preview's root.
  server: { host: '127.0.0.1', port: 18670, strictPort: true, fs: { allow: [at('../../../../../')] } },
  plugins: [replicaPlugins({ aliases: STUDIO_ALIASES, release: '0.1.0-preview.2' }), tailwindcss(), react()],
  resolve: {
    tsconfigPaths: true,
    alias: [...STUDIO_ALIASES, { find: '#upstream', replacement: at('../../../../../packages/brand/src/upstream.web.tsx') }, { find: /^sonner$/, replacement: at('../../../node_modules/sonner') }, { find: /^fumadocs-ui\/css\//, replacement: at('../../../node_modules/fumadocs-ui/css/') }],
    dedupe: ['react', 'react-dom'],
  },
})
