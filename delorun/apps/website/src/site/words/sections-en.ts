/**
 * The English text of the home page below its first screen: the five claims, the four living sections, What's new, what comes next and
 * the sign-up section. It loads with that part's own chunk.
 *
 * @module @delorun/website/words/sections-en
 */
import { DOCS_URL, SUPPORT_EMAIL } from '../config.ts'
import { ENGLISH_WORDS as PLUGIN_BROWSER_EN } from '../../plugin-browser/words.ts'

/** The lower home page's text in English. */
export const SECTIONS_EN = {
  claims: {
    heading: 'What Delorun does',
    items: [
      {
        text: 'Change its look, its plugins and its code.',
        detail: 'Pick a theme, add plugins, write your own, or edit Delorun itself.',
        href: `${DOCS_URL}/guide/customising/customise`,
      },
      {
        text: 'Go back to an earlier setup.',
        detail: 'Switch at your computer; going back covers Delorun and your chats, not the files an agent changed.',
        href: `${DOCS_URL}/guide/safety-and-updates/updates#going-back`,
      },
      {
        text: 'Carry on a chat from your phone.',
        detail: 'Over your own Tailscale network, once you approve the phone at your computer.',
        href: `${DOCS_URL}/guide/everyday-use/reach`,
      },
      {
        text: 'Risky changes ask for your consent first.',
        detail: 'Commands run in a sandbox unless you grant full access.',
        href: `${DOCS_URL}/guide/safety-and-updates/safety`,
      },
      {
        text: 'Open source, built on DeepSeek Harness.',
        detail: 'MIT licensed, and one command brings your DeepSeek Harness chats across.',
        href: `${DOCS_URL}/guide/get-started/switching`,
      },
    ],
  },
  sections: {
    makeItYours: {
      heading: 'Make it yours',
      lead: 'This page is a setup. Change it, see what Delorun would write, and go back.',
      link: { text: 'Change one thing, see it, undo it', href: `${DOCS_URL}/guide/customising/customise#change-one-thing-see-it-undo-it` },
    },
    parts: {
      heading: 'Made of parts you can change',
      lead: 'Delorun is built from plugins. These are the ones it ships with, in the words the studio uses.',
      link: { text: 'Write your first plugin', href: `${DOCS_URL}/guide/plugin-guides/first-plugin` },
    },
    replays: {
      heading: 'Watch it change',
      lead: 'Four chapters of one replay: every change to Delorun listed, undoing one, the versions of your setup, and the same from the terminal.',
      link: { text: 'How changes to Delorun are reviewed', href: `${DOCS_URL}/guide/customising/changing-your-harness` },
    },
    phone: {
      heading: 'From your phone',
      lead: 'Your chats from your computer, on your phone. A few sensitive steps need your approval at the computer.',
      link: { text: 'Reach the studio from your phone', href: `${DOCS_URL}/guide/everyday-use/reach#start-from-nothing` },
    },
  },
  whatsNew: {
    heading: 'What’s new',
    latest: (version: string, date: string) => `Delorun ${version}, ${date}`,
    full: 'Read the full changelog',
  },
  next: {
    heading: 'What comes next, and teams',
    roadmap: { before: 'The desktop app, a free relay and more machines are planned in order, with no dates: ', linkText: 'read the roadmap', after: '.' },
    roadmapHref: `${DOCS_URL}/guide/roadmap`,
    teams: { before: 'From 1.0.0, teams can have Delorun shaped to their work with custom plugins and integrations. ', linkText: `Write to ${SUPPORT_EMAIL}`, after: '.' },
    teamsHref: `mailto:${SUPPORT_EMAIL}`,
  },
  signup: {
    heading: 'Get release news by email',
    text: 'A short email when a new version or a major article comes out, and nothing more often. We send one message to confirm your address first.',
  },
  /** The plugin browser's own words, which its lane keeps beside the component. */
  plugins: PLUGIN_BROWSER_EN,
} as const
