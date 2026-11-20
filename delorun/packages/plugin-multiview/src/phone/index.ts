/**
 * The phone half of Multiview: the pager that replaces the split layout in a narrow window.
 * @module @delorun/plugin-multiview/phone
 */

export { PHONE_PAGER_BREAKPOINT, PHONE_PAGER_QUERY, usePhonePager } from './breakpoint.ts'
export { isMounted, MOUNT_RADIUS, pageAt, pageForKey, pageOrder } from './pages.ts'
export { PageDots, PhonePager } from './PhonePager.tsx'
export type { PageDotsProps, PhonePage, PhonePagerLabels, PhonePagerProps, PhonePageState } from './PhonePager.tsx'
export { PhoneSwitch } from './PhoneSwitch.tsx'
