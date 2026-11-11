import { defineConfig } from 'fumadocs-mdx/config'
import { remarkDelo } from './src/site/remark-delo.ts'

// The collections are defined in src/site/collections.ts; this file holds the compile options every page shares.
export default defineConfig({
  mdxOptions: { remarkPlugins: [remarkDelo] },
})
