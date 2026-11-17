/**
 * The modules the replica's build makes (`build/plugins.ts`). `virtual:replica-studio` is declared in the generated
 * `studio/facade.d.ts`.
 * @module @delorun/website/replica/virtual-modules
 */
declare module 'virtual:replica-strings' {
  /** The drawn studio's text, picked from the product's dictionaries. */
  const strings: import('./strings.ts').ReplicaStrings
  export default strings
}

declare module 'virtual:replica-icons' {
  /** The `<symbol>` markup of the replica's icons. */
  export const SYMBOLS: string
  /** Each icon's default size in pixels. */
  export const SIZES: { readonly [G in typeof import('./studio/icon-list.ts').REPLICA_ICONS[number]]: number }
}

declare module 'virtual:replica-tokens.css'

declare module 'virtual:replica-island' {
  /**
   * The live replica's first render as static markup with its styles. On the server it renders `ReplicaLive`; in the
   * browser it is empty.
   * @param props - the session and the width.
   * @returns the markup; empty in the browser.
   */
  export function island(props: Pick<import('./ReplicaLive.tsx').ReplicaLiveProps, 'session' | 'width'>): string
}
