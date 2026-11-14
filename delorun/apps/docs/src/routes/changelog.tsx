import { createFileRoute } from '@tanstack/react-router'
import { ChangelogPage, changelogHead } from '@/components/changelog.tsx'

/** The changelog page in English. */
export const Route = createFileRoute('/changelog')({
  head: () => changelogHead('en'),
  component: () => <ChangelogPage locale="en" />,
})
