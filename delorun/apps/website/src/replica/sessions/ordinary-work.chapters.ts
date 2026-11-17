/**
 * The chapters of "a piece of ordinary work": what each shows, its caption and its pacing. The event indexes point into
 * `ordinary-work.session.ts`. The replay opens on the question already asked and the agent's first reply, so the frame
 * is never an empty chat; a replay that does not play rests on the answer.
 * @module @delorun/website/replica/sessions/ordinary-work.chapters
 */
import type { ChapterFile } from '../model.ts'

/** The chapters. */
export const CHAPTERS: ChapterFile = {
  session: 'ordinary-work',
  workspace: 'shop-api',
  chats: ['Count and run the tests', 'Tidy the README', 'Why is the build slow?'],
  start: { screen: 'chat', shown: 4, changes: '', groups: [], versions: '' },
  resting: 3,
  chapters: [
    {
      id: 'ask',
      title: 'Ask',
      caption: 'You ask for a piece of work in a chat, in your own words.',
      steps: [
        { kind: 'wait', hold: 3200 },
      ],
    },
    {
      id: 'asks-first',
      title: 'It asks first',
      caption: 'Before the agent runs a command, it asks. Allow once lets this one command run; Allow for this chat lets the agent edit files and run commands in this project for the rest of the chat.',
      steps: [
        { kind: 'show', through: 5, hold: 4200 },
        { kind: 'press', target: { dictionary: 'approval', key: 'allowOnce' }, hold: 900 },
      ],
    },
    {
      id: 'runs',
      title: 'It runs',
      caption: 'The command runs on your computer, and its output is folded into the chat.',
      steps: [
        { kind: 'show', through: 6, hold: 1200 },
        { kind: 'show', through: 8, hold: 3000 },
      ],
    },
    {
      id: 'result',
      title: 'The answer',
      caption: 'The agent reads the output and answers.',
      steps: [
        { kind: 'show', through: 12, hold: 5000 },
      ],
    },
  ],
}
