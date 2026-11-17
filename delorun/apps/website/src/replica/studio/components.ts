/**
 * The real studio components the replica renders, and where each lives. `build/plugins.ts` re-exports them as
 * `virtual:replica-studio`; `build/facade.ts` writes `facade.d.ts`, the props each one takes, from the component's own
 * exported types, so a change to a component's props fails the website's type check where the replica passes them.
 * Paths are relative to the repository's root; upstream files are named through the site's `#studio/` alias.
 * @module @delorun/website/replica/studio/components
 */

/** One real component: its export name and its source file. */
export interface StudioComponent {
  readonly name: string
  readonly file: string
}

/** The real components. */
export const STUDIO_COMPONENTS: readonly StudioComponent[] = [
  { name: 'ChangesSection', file: 'delorun/packages/plugin-changes/src/client/ChangesSection.tsx' },
  { name: 'VersionsSection', file: 'delorun/packages/bundle-local/src/client/VersionsSection.tsx' },
  { name: 'AllowForChat', file: 'delorun/packages/bundle-local/src/client/AllowForChat.tsx' },
  { name: 'ApprovalCard', file: '#studio/ui-approval/src/client/ApprovalCard.tsx' },
  { name: 'CommandText', file: '#studio/ui-primitives/src/CommandText.tsx' },
]
