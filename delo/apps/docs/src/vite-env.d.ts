/// <reference types="vite/client" />

/** The build-time constants the site reads through `import.meta.env`. */
interface ImportMetaEnv {
  /** The Delo version the pages describe, which vite.config.ts reads from `delo/apps/release/package.json`. */
  readonly DELO_VERSION: string
}

/** `import.meta`, with the site's build-time constants. */
interface ImportMeta {
  readonly env: ImportMetaEnv
}

/** The changelog view the build derives from Delo's changelog record, or null when no version is assembled. */
declare module 'virtual:delo-changelog' {
  import type { ChangelogView } from '@/site/changelog.ts'
  const view: ChangelogView | null
  export default view
}
