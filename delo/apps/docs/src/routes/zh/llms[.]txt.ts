import { createFileRoute } from '@tanstack/react-router'
import { llmsIndex } from '@/site/markdown.ts'

/** The Chinese `llms.txt` index, which the build prerenders to a file. */
export const Route = createFileRoute('/zh/llms.txt')({
  server: {
    handlers: {
      GET: () => new Response(llmsIndex('zh'), { headers: { 'content-type': 'text/plain; charset=utf-8' } }),
    },
  },
})
