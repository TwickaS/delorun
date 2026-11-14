import { createFileRoute } from '@tanstack/react-router'
import { markdownResponse } from '@/site/markdown.ts'

/** Each Chinese page as Markdown, which the build prerenders to an extensionless file. */
export const Route = createFileRoute('/zh/llms.mdx/$section/$')({
  server: {
    handlers: {
      GET: ({ params }) => markdownResponse(params.section, params._splat?.split('/') ?? [], 'zh'),
    },
  },
})
