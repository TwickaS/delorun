/**
 * The English text of the home page below its first screen: the five claims, the four living sections, What's new, what comes next and
 * the sign-up section. It loads with that part's own chunk.
 *
 * @module @delorun/website/words/sections-en
 */
import { DOCS_URL, SUPPORT_EMAIL } from '../config.ts'

/** The lower home page's text in English. */
export const SECTIONS_EN = {
  claims: {
    heading: 'What Delorun does',
    items: [
      {
        text: 'Change its look, its settings and its plugins, write your own, or edit Delorun itself.',
        href: `${DOCS_URL}/guide/customise`,
      },
      {
        text: 'Save your setup before a change and switch back later; going back covers Delorun and your chats, not the files an agent changed.',
        href: `${DOCS_URL}/guide/updates#going-back`,
      },
      {
        text: 'Carry on a chat from your phone over your own Tailscale network, once you approve the phone at your computer.',
        href: `${DOCS_URL}/guide/reach`,
      },
      {
        text: 'It needs no account, runs commands in a sandbox and asks before risky steps.',
        href: `${DOCS_URL}/guide/safety`,
      },
      {
        text: 'Open source under MIT and built on DeepSeek Harness: one command brings your DeepSeek Harness chats across.',
        href: `${DOCS_URL}/guide/switching`,
      },
    ],
  },
  sections: {
    makeItYours: {
      heading: 'Make it yours',
      lead: 'This page is a setup. Change it, see what Delorun would write, and go back.',
      still: 'Theme tiles beside the entry Delorun writes for them, and a list of versions.',
      link: { text: 'Change one thing, see it, undo it', href: `${DOCS_URL}/guide/customise#change-one-thing-see-it-undo-it` },
    },
    parts: {
      heading: 'Made of parts you can change',
      lead: 'Delorun is built from plugins. These are the ones it ships with, in the words the studio uses.',
      still: 'The plugins Delorun ships, each with what it does.',
      link: { text: 'Write your first plugin', href: `${DOCS_URL}/guide/first-plugin` },
    },
    replays: {
      heading: 'Watch it change',
      lead: 'Sessions replayed from real runs: asking for a plugin, changing Delorun itself, reviewing a change before it loads, and going back.',
      still: 'A replayed session in the studio, paused on its first chapter.',
      link: { text: 'How changes to Delorun are reviewed', href: `${DOCS_URL}/guide/changing-your-harness` },
    },
    phone: {
      heading: 'From your phone',
      lead: 'The same studio on your computer and in your pocket, with the same chats.',
      wideLabel: 'The studio at desktop width',
      narrowLabel: 'The studio at phone width',
      link: { text: 'Reach the studio from your phone', href: `${DOCS_URL}/guide/reach#start-from-nothing` },
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
} as const
