/**
 * Which glyph the sheet's header shows for a strong action: typed maps keyed by the action's copy id, Changes control
 * or approval grant, so a new copy id fails the compiler until it has a glyph. An action no map names gets the plain
 * shield. The glyphs themselves are drawn by [`face-id-icons.tsx`](./face-id-icons.tsx).
 */
import { CHANGE_CONTROLS, faceCopyOf, type FaceActionCopy } from './face-id-locales.ts'
import type { FaceIconKey } from './face-id-types.ts'

/** The approval answers' grant markers, as `ApprovalGrant` names them. */
export const ANSWER_GRANTS = ['full-access', 'workspace-management', 'external-agent', 'real-browser'] as const

/** The glyph of each copy id of {@link FaceActionCopy}. */
export const COPY_ICON: Readonly<Record<FaceActionCopy, FaceIconKey>> = {
  installPlugin: 'download',
  updatePlugin: 'download',
  removePlugin: 'trash',
  switchPlugin: 'plugin',
  changePlugins: 'plugin',
  openTerminal: 'terminal',
  closeTerminal: 'terminal',
  renameTerminal: 'terminal',
  browseFolders: 'folder',
  newFolder: 'folder',
  changeSettings: 'settings',
  saveKey: 'shield',
  removeKey: 'shield',
  addWorkspace: 'folder',
  workspaceDefaults: 'settings',
  chatOutside: 'folder',
  runCommand: 'terminal',
  mcpServer: 'plugin',
  pluginCode: 'plugin',
  fullAccessOn: 'shield',
  fullAccessOnChat: 'shield',
  fullAccessOff: 'shield',
  network: 'globe',
  mcpAccept: 'check',
  externalAgent: 'terminal',
  deleteForever: 'trash',
  awayBrowser: 'globe',
  reportDetails: 'settings',
  profileSave: 'check',
  profileSwitch: 'refresh',
  runPrompts: 'shield',
  runBackground: 'settings',
  seatAnswer: 'check',
  passSetting: 'shield',
  generic: 'shield',
}

/** The glyph of each Changes and update control that has its own words. */
export const CHANGE_ICON: Readonly<Record<(typeof CHANGE_CONTROLS)[number], FaceIconKey>> = {
  'plugin-undo': 'refresh',
  'plugin-discard': 'trash',
  'harness-discard': 'trash',
  'plugin-apply': 'check',
  'plugin-other': 'plugin',
  'harness-apply': 'check',
  'harness-undo': 'refresh',
  'protection-off': 'shield',
  'make-copy': 'plugin',
  'restart': 'refresh',
  'update-begin': 'download',
  'update-rollback': 'refresh',
  'stop': 'settings',
}

/** The glyph of each approval answer's grant marker. */
export const ANSWER_ICON: Readonly<Record<(typeof ANSWER_GRANTS)[number], FaceIconKey>> = {
  'full-access': 'shield',
  'workspace-management': 'folder',
  'external-agent': 'terminal',
  'real-browser': 'globe',
}

/**
 * The glyph key of a grant action.
 * @param action - a Remote method, a Fetch route's action name, or `changes/<control>`.
 * @returns the glyph key; the shield when the action has no entry of its own.
 */
export function faceIconOf(action: string): FaceIconKey {
  if (action.startsWith('changes/')) {
    const control = CHANGE_CONTROLS.find(entry => entry === action.slice('changes/'.length))
    return control === undefined ? 'shield' : CHANGE_ICON[control]
  }
  return COPY_ICON[faceCopyOf(action)]
}
