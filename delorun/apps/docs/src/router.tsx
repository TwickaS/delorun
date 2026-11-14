import { createRouter } from '@tanstack/react-router'
import { NotFound } from '@/components/home.tsx'
import { routeTree } from '../routeTree.gen.ts'

/**
 * The site's router, which TanStack Start creates for each prerendered page and once in the browser.
 * @returns the router over the generated route tree.
 */
export function getRouter() {
  return createRouter({
    routeTree,
    defaultPreload: 'intent',
    scrollRestoration: true,
    defaultNotFoundComponent: NotFound,
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
