import { defineConfig, defineDocs } from 'fumadocs-mdx/config'
import { z } from 'zod'
import { remarkDelo } from './src/site/remark-delo.ts'

// The pages carry their title as the first heading, so the frontmatter's title is optional.
const pageFrontmatter = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
})

// Each collection reads Delo's pages in place: `<name>.md` and its Chinese pair `<name>.zh.md` beside it. The
// `.i18n.yaml` consistency records are not matched.
export const guide = defineDocs({
  dir: '../../docs/guide',
  docs: { schema: pageFrontmatter, postprocess: { includeProcessedMarkdown: true } },
})
export const reference = defineDocs({
  dir: '../../docs/reference',
  docs: { schema: pageFrontmatter, postprocess: { includeProcessedMarkdown: true } },
})

export default defineConfig({
  mdxOptions: { remarkPlugins: [remarkDelo] },
})
