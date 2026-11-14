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
import { SEARCH_INDEX_PATH } from '@/site/config.ts'

/**
 * The search dialog the root provider opens.
 * @param props - the dialog's open state and its setter.
 * @returns the dialog.
 */
export default function StaticSearchDialog(props: SharedProps) {
  const { locale } = useI18n()
  const search = useStaticSearch({ from: SEARCH_INDEX_PATH, locale })
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
