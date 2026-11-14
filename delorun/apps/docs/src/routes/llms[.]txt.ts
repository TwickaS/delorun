import { createFileRoute } from '@tanstack/react-router'
import { llmsIndex } from '@/site/markdown.ts'

/** The English `llms.txt` index, which the build prerenders to a file. */
export const Route = createFileRoute('/llms.txt')({
  server: {
    handlers: {
      GET: () => new Response(llmsIndex('en'), { headers: { 'content-type': 'text/plain; charset=utf-8' } }),
    },
  },
})
