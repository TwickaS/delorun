/**
 * The state an action leaves behind, for the sheet's "Afterwards" row: the Face ID confirms once, but full access,
 * an install or a setting stays as it was set. Actions that leave nothing lasting (a terminal, a folder picker, an
 * approval answer) have no entry and no row.
 */
import type { CHANGE_CONTROLS} from './face-id-locales.ts';
import { type FaceActionCopy, type FaceIdLocaleKey } from './face-id-locales.ts'

/** A dictionary key of the `stays.` lines. */
export type FaceStaysKey = Extract<FaceIdLocaleKey, `stays.${string}`>

/** The line of each copy id that leaves a lasting state. */
export const STAYS_OF_COPY: Readonly<Partial<Record<FaceActionCopy, FaceStaysKey>>> = {
  installPlugin: 'stays.installPlugin',
  updatePlugin: 'stays.updatePlugin',
  removePlugin: 'stays.removePlugin',
  switchPlugin: 'stays.switchPlugin',
  changePlugins: 'stays.changePlugins',
  changeSettings: 'stays.changeSettings',
  saveKey: 'stays.saveKey',
  removeKey: 'stays.removeKey',
  addWorkspace: 'stays.addWorkspace',
  workspaceDefaults: 'stays.workspaceDefaults',
  fullAccessOn: 'stays.fullAccessOn',
  fullAccessOnChat: 'stays.fullAccessOnChat',
  fullAccessOff: 'stays.fullAccessOff',
  network: 'stays.network',
  mcpAccept: 'stays.mcpAccept',
  externalAgent: 'stays.externalAgent',
  deleteForever: 'stays.deleteForever',
  awayBrowser: 'stays.awayBrowser',
  profileSwitch: 'stays.profileSwitch',
}

/** The line of each Changes and update control that leaves a lasting state. */
export const STAYS_OF_CHANGE: Readonly<Partial<Record<(typeof CHANGE_CONTROLS)[number], FaceStaysKey>>> = {
  'plugin-apply': 'stays.change.plugin-apply',
  'harness-apply': 'stays.change.harness-apply',
  'update-begin': 'stays.change.update-begin',
  'update-rollback': 'stays.change.update-rollback',
  'protection-off': 'stays.change.protection-off',
}
