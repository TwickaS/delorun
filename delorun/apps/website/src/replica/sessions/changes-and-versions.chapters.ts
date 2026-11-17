/**
 * The chapters of "every change is one step": what each shows, its caption and its pacing. State names point into
 * `changes-and-versions.session.ts`. Each chapter looks different from the one before within its first moments: the
 * Undo chapter opens its confirmation at once, and the terminal chapter has its command typed within half a second.
 * @module @delorun/website/replica/sessions/changes-and-versions.chapters
 */
import type { ChapterFile } from '../model.ts'

/** The chapters. */
export const CHAPTERS: ChapterFile = {
  session: 'changes-and-versions',
  workspace: 'shop-api',
  chats: ['Make the theme warmer', 'Count words in my notes', 'Tidy the README'],
  start: { screen: 'changes', shown: 0, changes: 'two', groups: ['recent.heading'], versions: 'list' },
  resting: 0,
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
        { kind: 'wait', hold: 200 },
        { kind: 'press', target: { dictionary: 'changes', key: 'confirm.undo', within: '[data-change-id="chg-1"]' }, hold: 3400 },
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
      id: 'terminal',
      title: 'From the terminal',
      caption: 'In a terminal, delorun logs shows where Delorun keeps its logs, then the latest records.',
      steps: [
        { kind: 'screen', screen: 'terminal', hold: 0 },
        { kind: 'command', command: 'delorun logs', perChar: 30, hold: 6400 },
      ],
    },
  ],
}
