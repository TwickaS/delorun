/**
 * The real studio screenshots the home page shows, with what each one is: a hand-picked set with written captions, and
 * the capture lane's set across every look (`wall-shots.ts`). Every file in `public/lod/` is a scaled, re-encoded copy
 * of a screenshot taken from a running Delorun studio; nothing is drawn or retouched.
 *
 * @module @delorun/website/home/shots
 */
import { WALL_SHOTS } from './wall-shots.ts'

/** What part of the studio a picture shows. */
export type Screen = 'chat' | 'changes' | 'plugins' | 'looks' | 'settings' | 'setup'

/** The picture's colours: the studio's light or dark Delorun look, or the original DeepSeek Harness look. */
export type Tone = 'light' | 'dark' | 'original'

/** The width the studio was captured at. */
export type Device = 'computer' | 'phone'

/** One screenshot. */
export interface Shot {
  readonly id: string
  readonly screen: Screen
  readonly tone: Tone
  readonly device: Device
  /** One line saying what the picture shows. */
  readonly caption: string
  /** Shown larger in the mixed wall. */
  readonly feature?: boolean
  /** The look the picture is in, only where the picture shows it selected or the capture recorded it. */
  readonly theme?: string
  /** The look's id as the capture lane recorded it, such as `ocean` or `custom-peach`; only on its pictures. */
  readonly look?: string
  /** A setting the picture shows, only where it is visible in the picture or named in the source file. */
  readonly setting?: string
  /** The interface language, when it is not English. */
  readonly language?: string
}

/** The hand-picked pictures, in the order the mixed wall shows them. */
const CURATED: readonly Shot[] = [
  { id: 'approval-light', screen: 'chat', tone: 'light', device: 'computer', caption: 'A command its settings do not allow stops and waits for your answer.', feature: true },
  { id: 'phone-deep-dive', screen: 'chat', tone: 'dark', device: 'phone', caption: 'A long investigation, followed step by step from a phone.' },
  { id: 'look-picker-light', screen: 'looks', tone: 'light', device: 'computer', caption: 'Pick a theme on the first day, and change it whenever you like.', theme: 'Custom, peach accent' },
  { id: 'changes-restart', screen: 'changes', tone: 'light', device: 'computer', caption: 'Your edits to Delorun itself run after a restart you choose.' },
  { id: 'sidebar-art-dark', screen: 'looks', tone: 'dark', device: 'computer', caption: 'Header art behind the sidebar, chosen or shuffled.', setting: 'Header art: Blueprint, Standard strength' },
  { id: 'phone-changes', screen: 'changes', tone: 'light', device: 'phone', caption: 'Changes waiting for review, on a phone.' },
  { id: 'answer-light', screen: 'chat', tone: 'light', device: 'computer', caption: 'Claude Code ran the tests for this chat: all 12 pass, in 2 minutes 13 seconds.' },
  { id: 'original-look', screen: 'looks', tone: 'original', device: 'computer', caption: 'The original DeepSeek Harness look, one switch away.', feature: true },
  { id: 'phone-look-light', screen: 'looks', tone: 'light', device: 'phone', caption: 'Themes and accent colours on a phone.', theme: 'Custom, peach accent' },
  { id: 'handoff-dark', screen: 'chat', tone: 'dark', device: 'computer', caption: 'The chat that handed the job out, with the answer it got back.' },
  { id: 'plugins-first-run', screen: 'plugins', tone: 'dark', device: 'computer', caption: 'Recommended plugins at the first run, each one your choice.' },
  { id: 'setup-versions', screen: 'setup', tone: 'light', device: 'computer', caption: 'Save the whole setup as a version, then move it to another computer.' },
  { id: 'phone-approval-dark', screen: 'chat', tone: 'dark', device: 'phone', caption: 'An approval waiting in a chat, at phone width.' },
  { id: 'changes-list', screen: 'changes', tone: 'light', device: 'computer', caption: 'Every change to what Delorun runs, listed, with Undo.', feature: true },
  { id: 'appearance-dark', screen: 'looks', tone: 'dark', device: 'computer', caption: 'Themes, light or dark, and an accent of your own.', theme: 'Soft', setting: 'Mode: System' },
  { id: 'phone-sidebar-art', screen: 'looks', tone: 'dark', device: 'phone', caption: 'Header art, on a phone.' },
  { id: 'handoff-light', screen: 'chat', tone: 'light', device: 'computer', caption: 'One chat hands a job to Claude Code and reports what came back.' },
  { id: 'chinese', screen: 'setup', tone: 'dark', device: 'computer', caption: 'The studio in Chinese, from the first screen.', language: 'Chinese' },
  { id: 'phone-plugins-light', screen: 'plugins', tone: 'light', device: 'phone', caption: 'Recommended plugins, on a phone.' },
  { id: 'plugins-settings-dark', screen: 'plugins', tone: 'dark', device: 'computer', caption: 'Every installed plugin, with what it adds.' },
  { id: 'protection', screen: 'changes', tone: 'light', device: 'computer', caption: 'The protection switch for changes to Delorun itself.' },
  { id: 'phone-pin', screen: 'settings', tone: 'light', device: 'phone', caption: 'A PIN for sensitive actions from a phone.', setting: 'PIN mode on' },
  { id: 'modes-dark', screen: 'settings', tone: 'dark', device: 'computer', caption: 'Modes for different kinds of work, and your own.' },
  { id: 'cost', screen: 'chat', tone: 'light', device: 'computer', caption: 'When tool calls keep failing, the turn stops instead of spending more, and the cost is counted.' },
  { id: 'phone-access', screen: 'setup', tone: 'dark', device: 'computer', caption: 'Reach the studio from your phone over Tailscale.' },
  { id: 'phone-home-dark', screen: 'chat', tone: 'dark', device: 'phone', caption: 'A fresh chat, ready on a phone.' },
  { id: 'phone-workspace-dark', screen: 'setup', tone: 'dark', device: 'phone', caption: 'Choose a workspace, then start.' },
  { id: 'browser-choice', screen: 'setup', tone: 'dark', device: 'computer', caption: 'Choose whether agents get a web browser, and which one.' },
  { id: 'phone-answer-dark', screen: 'chat', tone: 'dark', device: 'phone', caption: 'The answer from Claude Code, on a phone.' },
  { id: 'replies-dark', screen: 'settings', tone: 'dark', device: 'computer', caption: 'How much of the agent’s work a chat shows.', setting: 'Replies: Detailed' },
  { id: 'workspace-safety', screen: 'setup', tone: 'light', device: 'computer', caption: 'Say what the chats in a new workspace may do.' },
  { id: 'phone-appearance-dark', screen: 'looks', tone: 'dark', device: 'phone', caption: 'Appearance settings, on a phone.', theme: 'Soft', setting: 'Mode: System' },
  { id: 'approval-dark', screen: 'chat', tone: 'dark', device: 'computer', caption: 'The same approval in the dark look.' },
  { id: 'look-step-dark', screen: 'looks', tone: 'dark', device: 'computer', caption: 'The look step of the first run, in the dark.', theme: 'Soft', setting: 'Mode: System' },
  { id: 'phone-cost', screen: 'chat', tone: 'dark', device: 'phone', caption: 'A stopped turn and its cost, on a phone.' },
  { id: 'agents-dark', screen: 'chat', tone: 'dark', device: 'computer', caption: 'A chat and the agent it handed work to, side by side.' },
  { id: 'welcome-dark', screen: 'setup', tone: 'dark', device: 'computer', caption: 'The first question: what are we working on?' },
  { id: 'phone-browser-light', screen: 'setup', tone: 'light', device: 'phone', caption: 'The browser choice, on a phone.' },
  { id: 'changes-dark', screen: 'changes', tone: 'dark', device: 'computer', caption: 'The changes list in the dark look.' },
  { id: 'phone-setup-versions', screen: 'setup', tone: 'light', device: 'phone', caption: 'Setup versions, on a phone.' },
  { id: 'pin-on', screen: 'settings', tone: 'light', device: 'computer', caption: 'PIN mode on: a paired phone unlocks with your PIN.', setting: 'PIN mode on' },
  { id: 'shell-dark', screen: 'chat', tone: 'dark', device: 'computer', caption: 'A shell command, run and answered.' },
  { id: 'phone-access-phone', screen: 'setup', tone: 'dark', device: 'phone', caption: 'Phone access, set up from a phone.' },
  { id: 'appearance-light', screen: 'looks', tone: 'light', device: 'computer', caption: 'The appearance settings in the light look.', theme: 'Soft' },
]

/**
 * Spreads one list's items evenly through another's, keeping both orders.
 * @param base - the list whose items keep their places at even steps.
 * @param more - the items spread between them.
 * @returns both lists as one.
 */
function spread<T>(base: readonly T[], more: readonly T[]): readonly T[] {
  const total = base.length + more.length
  return Array.from({ length: total }, (_, i) => {
    const b = Math.floor(((i + 1) * base.length) / total) - Math.floor((i * base.length) / total)
    return b === 1 ? base[Math.floor((i * base.length) / total)] : more[i - Math.floor(((i + 1) * base.length) / total)]
  }).filter((each): each is T => each !== undefined)
}

/** Every picture, in the order the mixed wall shows them: the hand-picked ones spread through the capture lane's. */
export const SHOTS: readonly Shot[] = spread(CURATED, WALL_SHOTS)

/** The names the wall's groups take. */
export const SCREEN_NAMES: Readonly<Record<Screen, string>> = {
  chat: 'Chats',
  changes: 'Changes',
  plugins: 'Plugins',
  looks: 'Looks',
  settings: 'Settings',
  setup: 'Setup',
}

/** What each kind of screen is called on the lightbox's plate. */
export const SCREEN_LABELS: Readonly<Record<Screen, string>> = {
  chat: 'A chat',
  changes: 'Changes',
  plugins: 'Plugins',
  looks: 'Appearance',
  settings: 'Settings',
  setup: 'Setup',
}

/** The names of the tones. */
export const TONE_NAMES: Readonly<Record<Tone, string>> = { light: 'Light', dark: 'Dark', original: 'Original look' }

/** The names of the devices. */
export const DEVICE_NAMES: Readonly<Record<Device, string>> = { computer: 'On a computer', phone: 'On a phone' }

/** The pixel size of each kind of picture, for layout before it loads. */
export const SIZES: Readonly<Record<Device, { readonly width: number; readonly height: number }>> = {
  computer: { width: 1440, height: 900 },
  phone: { width: 390, height: 844 },
}

/** One chapter of the film: a picture, where the camera pushes in, and what it says. */
export interface Chapter {
  readonly id: string
  readonly line: string
  readonly detail: string
  /** The time printed on the screenshot, or undefined when it shows none. */
  readonly time?: string
  /** The point the camera pushes in on, as fractions of the picture's width and height. */
  readonly focus: readonly [number, number]
  /** How far the camera pushes in on a wide screen. */
  readonly zoom: number
  /** The dark capture of the same moment, and its focus point when it differs. */
  readonly dark?: { readonly id: string; readonly focus?: readonly [number, number] }
  /** The phone capture of the same moment (a picture in the pyramid), and the height (a fraction) the camera centres on. */
  readonly phone: { readonly file: string; readonly focusY: number }
}

/** The film: one real job from ask to answer, then Delorun changing itself. */
export const FILM: readonly Chapter[] = [
  { id: 'handoff-light', line: 'You ask in plain words.', detail: 'Run the project’s tests and tell me which pass. Delorun hands the job to Claude Code.', time: '21:29', focus: [0.56, 0.2], zoom: 1.35, dark: { id: 'handoff-dark' }, phone: { file: 'film-lead-handoff-390-light', focusY: 0.2 } },
  { id: 'approval-light', line: 'It asks before it acts.', detail: 'A command its settings do not allow waits for you: once, for this run, or not at all.', time: '21:29', focus: [0.59, 0.86], zoom: 1.6, dark: { id: 'approval-dark' }, phone: { file: 'film-approval-computer-390-light', focusY: 0.86 } },
  { id: 'agents-light', line: 'You watch it work.', detail: 'Every step is in the chat as it happens, and the agent it handed work to keeps its own chat.', time: '21:32', focus: [0.555, 0.4], zoom: 1.4, dark: { id: 'agents-dark' }, phone: { file: 'film-lead-handoff-390-light', focusY: 0.58 } },
  { id: 'answer-light', line: 'It tells you what happened.', detail: 'All 12 tests pass, in 2 minutes 13 seconds, with every step kept.', time: '21:32', focus: [0.585, 0.66], zoom: 1.55, dark: { id: 'handoff-dark', focus: [0.585, 0.62] }, phone: { file: 'film-child-finished-390-light', focusY: 0.66 } },
  { id: 'changes-restart', line: 'It can change itself, too.', detail: 'Edits to Delorun’s own files wait for your review and run after a restart you choose. By default, a phone cannot change them.', focus: [0.54, 0.5], zoom: 1.15, phone: { file: 'film-changes-phone-390', focusY: 0.3 } },
]
