/**
 * The chapters of "every change is one step": what each shows, its caption and its pacing. State names point into
 * `changes-and-versions.fixture.ts`.
 * @module @delorun/website/replica/sessions/changes-and-versions.chapters
 */
import type { ChapterFile } from '../model.ts'

/** The chapters. */
export const CHAPTERS: ChapterFile = {
  session: 'changes-and-versions',
  workspace: 'shop-api',
  chats: ['Make the theme warmer', 'Count words in my notes', 'Tidy the README'],
  start: { screen: 'changes', shown: 0, changes: 'two', groups: ['recent.heading'], versions: 'list' },
  chapters: [
    {
      id: 'listed',
      title: 'Every change listed',
      caption: 'Each change to a plugin is listed under Changes, with when it was made.',
      steps: [{ kind: 'wait', hold: 4000 }],
    },
    {
      id: 'undo',
      title: 'Undo one',
      caption: 'Undo takes one change back and asks first. The other change stays.',
      steps: [
        { kind: 'wait', hold: 1200 },
        { kind: 'press', target: { dictionary: 'changes', key: 'confirm.undo', within: '[data-change-id="chg-2"]' }, hold: 2600 },
        { kind: 'press', target: { dictionary: 'changes', key: 'confirm.undo', within: '[role="dialog"]' }, hold: 400 },
        { kind: 'changes', state: 'undone', groups: ['recent.heading'], hold: 3200 },
      ],
    },
    {
      id: 'versions',
      title: 'Setup versions',
      caption: 'Setup versions lists every setup Delorun saved. Switch to this version restores a whole setup after a restart, and saves the current one first.',
      steps: [
        { kind: 'screen', screen: 'versions', hold: 5200 },
      ],
    },
    {
      id: 'logs',
      title: 'The log',
      caption: 'delorun logs shows the running Delorun’s log, with secrets left out.',
      steps: [
        { kind: 'screen', screen: 'terminal', hold: 400 },
        { kind: 'command', command: 'delorun logs', output: ['10:42:03 plugin delorun-theme: settings changed, reloaded', '10:50:11 change chg-2 undone: delorun-theme back to its earlier settings', '10:50:12 plugin delorun-theme reloaded'], hold: 4600 },
      ],
    },
  ],
}
