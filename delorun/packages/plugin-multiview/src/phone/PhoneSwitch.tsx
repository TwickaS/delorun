/**
 * Chooses between the phone pager and the split layout by window width, so the panel lane has one place that decides.
 * @module @delorun/plugin-multiview/phone/PhoneSwitch
 */

import type { JSX, ReactNode } from 'react'
import { usePhonePager } from './breakpoint.ts'

/**
 * Show `phone` in a window narrower than the pager breakpoint and `split` otherwise.
 * @param props - the two alternatives.
 * @returns the chosen one.
 */
export function PhoneSwitch(props: { readonly phone: ReactNode; readonly split: ReactNode }): JSX.Element {
  return <>{usePhonePager() ? props.phone : props.split}</>
}
