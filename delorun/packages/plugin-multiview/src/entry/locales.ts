/** Copy of the Multiview entry points: the pin button, the header button, the popover footer and the Layout menu. */

/** English dictionary. */
export const en = {
  'pin': 'Pin to Multiview',
  'pin.aria': 'Pin {agent} to Multiview',
  'unpin': 'Unpin from Multiview',
  'unpin.aria': 'Unpin {agent} from Multiview',
  'pin.refused.max-panes': 'Multiview is full: {max} panes at most. Unpin an agent, or raise the limit in Settings.',
  'pin.refused.no-room': 'The window has no room for another pane. Make it larger, or unpin an agent.',
  'footer.status': '{pinned} pinned · room for {free} more',
  'footer.statusFull': '{pinned} pinned · no room for more',
  'footer.pinRunning': 'Pin running',
  'footer.pinRunning.none': 'No running agent to pin',
  'footer.pinRunning.allPinned': 'Every running agent is pinned',
  'footer.open': 'Open Multiview',
  'footer.close': 'Close Multiview',
  'button': 'Multiview',
  'button.aria': 'Multiview',
  'button.count': '{count} pinned',
  'button.waiting': 'An agent is waiting for you',
  'button.open.none': 'Nothing to show yet: pin an agent from the agents list, or start one.',
  'layout': 'Layout',
  'layout.main-column': 'Main and column',
  'layout.side-by-side': 'Side by side',
  'layout.grid': 'Grid',
  'layout.main-top': 'Main on top',
  'layout.reset': 'Reset to default',
}

/** A key of the dictionaries. */
export type MultiviewLocaleKey = keyof typeof en

/** Chinese dictionary: the English copy until the translation pass. */
export const zh: Record<MultiviewLocaleKey, string> = { ...en }
