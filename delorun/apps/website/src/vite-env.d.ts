/// <reference types="vite/client" />

/** The changelog view the build derives from Delorun's changelog record, or null when no version is assembled. */
declare module 'virtual:delorun-changelog' {
  import type { ChangelogView } from '@design/changelog.ts'
  const view: ChangelogView | null
  export default view
}

/** The licence texts of the material the site ships, read from the files that ship it. */
declare module 'virtual:delorun-notices' {
  import type { Notice } from '../../../packages/site-design/scripts/notices.ts'
  const notices: readonly Notice[]
  export default notices
}
