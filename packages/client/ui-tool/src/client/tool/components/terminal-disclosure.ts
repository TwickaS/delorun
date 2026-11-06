/** A Tool row's open state when its terminal card may start open. @module */
import { useCallback, useState } from 'react'
import type { UseDisclosure } from '@deepseek-ai/dsh-client-ui-chat/client'

/**
 * Choose a row's open state: its own disclosure, or, while its terminal card starts open, a closed flag of its own,
 * so closing the card in the Verbose view and opening the row in another view never change each other.
 * @param disclosure - the row's disclosure.
 * @param startsOpen - whether the terminal card starts open.
 * @returns whether the row is open, and its toggle.
 */
export function useTerminalDisclosure(
  disclosure: ReturnType<UseDisclosure>,
  startsOpen: boolean,
): { readonly expanded: boolean; readonly toggle: () => void } {
  const [closed, setClosed] = useState(false)
  const toggleClosed = useCallback(() => { setClosed(value => !value) }, [])
  return startsOpen ? { expanded: !closed, toggle: toggleClosed } : { expanded: disclosure.expanded, toggle: disclosure.toggle }
}
