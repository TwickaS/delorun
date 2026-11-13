import { createFileRoute } from '@tanstack/react-router'
import { ChangelogPage, changelogHead } from '@/components/changelog.tsx'

/** The changelog page with the Chinese title and the English entries. */
export const Route = createFileRoute('/zh/changelog')({
  head: () => changelogHead('zh'),
  component: () => <ChangelogPage locale="zh" />,
})
