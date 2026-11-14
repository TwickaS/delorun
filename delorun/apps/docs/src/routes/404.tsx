import { createFileRoute } from '@tanstack/react-router'
import { NotFound, notFoundHead } from '@/components/home.tsx'

/** The not-found page, prerendered to 404.html, which a static host serves for an address no file has; the build removes its scripts. */
export const Route = createFileRoute('/404')({
  head: notFoundHead,
  component: NotFound,
})
