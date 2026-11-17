/**
 * The search dialog: it downloads the static search index once and searches it in the browser, among the pages of the
 * locale the reader is in.
 *
 * @module @delorun/docs/search-dialog
 */
import { useStaticSearch } from 'fumadocs-core/search/client'
import {
  SearchDialog,
  SearchDialogClose,
  SearchDialogContent,
  SearchDialogHeader,
  SearchDialogIcon,
  SearchDialogInput,
  SearchDialogList,
  SearchDialogOverlay,
  type SharedProps,
} from 'fumadocs-ui/components/dialog/search'
import { useI18n } from 'fumadocs-ui/contexts/i18n'
import { useSearchContext } from 'fumadocs-ui/contexts/search'
import { useEffect } from 'react'
import { SEARCH_INDEX_PATH } from '@/site/config.ts'

/** The query a link carried in `?search=`, held until the dialog has opened with it. */
let pendingQuery: string | undefined

/**
 * Opens the search with the query of a `?search=<query>` link, the address the product site's search box links to, and
 * removes the parameter from the address. The search index is downloaded only here, when the dialog opens.
 * @returns nothing; it renders no element.
 */
export function OpenSearchFromLink() {
  const { setOpenSearch } = useSearchContext()
  useEffect(() => {
    const url = new URL(location.href)
    const query = url.searchParams.get('search')
    if (query === null || query.trim() === '') return
    pendingQuery = query
    url.searchParams.delete('search')
    history.replaceState(history.state, '', url.pathname + url.search + url.hash)
    setOpenSearch(true)
  }, [setOpenSearch])
  return null
}

/**
 * The search dialog the root provider opens.
 * @param props - the dialog's open state and its setter.
 * @returns the dialog.
 */
export default function StaticSearchDialog(props: SharedProps) {
  const { locale } = useI18n()
  const search = useStaticSearch({ from: SEARCH_INDEX_PATH, locale })
  const { onSearchChange } = search
  useEffect(() => {
    if (pendingQuery === undefined) return
    onSearchChange(pendingQuery)
    pendingQuery = undefined
  }, [onSearchChange])
  return (
    <SearchDialog {...search} {...props}>
      <SearchDialogOverlay />
      <SearchDialogContent>
        <SearchDialogHeader>
          <SearchDialogIcon />
          <SearchDialogInput />
          <SearchDialogClose />
        </SearchDialogHeader>
        <SearchDialogList />
      </SearchDialogContent>
    </SearchDialog>
  )
}
