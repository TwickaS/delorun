/// <reference types="vite/client" />

/** The changelog view the build derives from Delorun's changelog record, or null when no version is assembled. */
declare module 'virtual:delorun-changelog' {
  import type { ChangelogView } from '@design/changelog.ts'
  const view: ChangelogView | null
  export default view
}
