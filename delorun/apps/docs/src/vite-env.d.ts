/// <reference types="vite/client" />

/** The build-time constants the site reads through `import.meta.env`. */
interface ImportMetaEnv {
  /** The Delorun version the pages describe, which vite.config.ts reads from `delorun/apps/release/package.json`. */
  readonly DELORUN_VERSION: string
}

/** `import.meta`, with the site's build-time constants. */
interface ImportMeta {
  readonly env: ImportMetaEnv
}

/** The changelog view the build derives from Delorun's changelog record, or null when no version is assembled. */
declare module 'virtual:delorun-changelog' {
  import type { ChangelogView } from '@design/changelog.ts'
  const view: ChangelogView | null
  export default view
}
