import { createFileRoute } from '@tanstack/react-router'
import { searchIndexResponse } from '@/site/search.ts'

/** The static search index, which the build prerenders to `SEARCH_INDEX_PATH` and the search dialog downloads. */
export const Route = createFileRoute('/search.json')({
  server: {
    handlers: {
      GET: () => searchIndexResponse(),
    },
  },
})
