/** Copy of the Multiview panes: the header, the status badge, the limits line and the pager. */

/** The dictionary namespace of the panes' copy. */
export const PANES_NS = 'delorunMultiviewPanes'

/** English dictionary. */
export const en = {
  'region': 'Multiview',
  'status.working': 'Working {time}',
  'status.working.now': 'Working',
  'status.needs-approval': 'Needs approval',
  'status.done': 'Done {time}',
  'status.done.now': 'Done',
  'status.idle': 'Ready',
  'badge.mainChat': 'Main chat',
  'action.open': 'Open full chat',
  'action.stop': 'Stop',
  'action.close': 'Close pane',
  'action.move': 'Move to…',
  'action.swap': 'Swap places',
  'move.pane.left': 'Left of {pane}',
  'move.pane.right': 'Right of {pane}',
  'move.pane.top': 'Above {pane}',
  'move.pane.bottom': 'Below {pane}',
  'move.pane.center': 'Tab with {pane}',
  'move.edge.left': 'Far left',
  'move.edge.right': 'Far right',
  'move.edge.top': 'Top',
  'move.edge.bottom': 'Bottom',
  'limits.label': 'Plan and usage',
  'limits.plan': 'Plan: {plan}',
  'limits.fiveHour': '5-hour limit {percent}%',
  'limits.fiveHourReset': '5-hour limit {percent}% · resets {time}',
  'limits.weekly': 'Weekly {percent}%',
  'limits.version': '{agent} {version}',
  'layout.hidden': '{count} pinned agents do not fit in this window and are hidden. Make the window larger to show them.',
  'layout.hidden.one': '1 pinned agent does not fit in this window and is hidden. Make the window larger to show it.',
  'layout.hidden.waiting': '{count} of them wait for you.',
  'layout.hidden.waiting.one': 'It waits for you.',
  'close.confirm': 'Close anyway?',
  'close.waiting': 'This chat is waiting for you. Press again to close the pane.',
  'layout.separator': 'Resize panes',
  'layout.grip': 'Move pane',
  'layout.tabs': 'Panes',
  'pager.region': 'Multiview',
  'pager.strip': 'Chats',
  'pager.attention': 'Needs your approval',
  'empty.noMain': 'Open a chat to use Multiview.',
}

/** A key of the dictionaries. */
export type PanesLocaleKey = keyof typeof en

/** Chinese dictionary: the English copy until the translation pass. */
export const zh: Record<PanesLocaleKey, string> = { ...en }
