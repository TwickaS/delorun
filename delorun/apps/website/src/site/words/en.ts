/**
 * The site's English text. Every claim here is stated on the documentation page its link names, which holds the detail
 * and the limits; `tests/claims.spec.ts` checks that each linked page and heading exists.
 *
 * @module @delorun/website/words/en
 */
import { DOCS_URL, SUPPORT_EMAIL } from '../config.ts'

/** The roadmap entry that the desktop button's note links to: the "Next" section, which lists the desktop app first. */
export const ROADMAP_DESKTOP_HREF = `${DOCS_URL}/guide/roadmap#next`

/** Every string the site shows in English, with the documentation link each claim points to. */
export const EN = {
  language: 'en-GB',
  siteTitle: 'Delorun',
  tagline: 'Your harness. No limits.',
  description: 'Delorun is an open source agent harness on your own computer that you shape to your work: its look, its plugins, even Delorun itself. Built on DeepSeek Harness.',
  hero: {
    title: 'Your harness. No limits.',
    subline: 'An agent harness on your own computer that bends to your work: its look, its plugins, even Delorun itself.',
    packageManagerLabel: 'Package manager',
    copyLabel: 'Copy command',
    copiedLabel: 'Copied',
    copyFailedLabel: 'Copy failed. Select the command and copy it.',
    /** The heading of the command list shown when scripts are off. */
    commandsLabel: 'Install with any of these',
    platform: {
      before: 'Runs on Linux and on ',
      linkText: 'Windows through WSL2',
      href: `${DOCS_URL}/guide/install#windows-through-wsl2`,
      after: '. ',
    },
    status: {
      before: 'This is a preview: ',
      linkText: 'what that means',
      href: `${DOCS_URL}/guide/trust#how-releases-are-signed-in-the-preview`,
      after: '.',
    },
    replicaLabel: 'The Delorun studio at work on an ordinary chat',
    stillAlt: 'The Delorun studio in a browser: a list of chats and workspaces on the left, and on the right a chat about laying out four raised beds, with a table of the beds and a JSON file the assistant wrote.',
  },
  desktop: {
    /** The label while no platform has a download. */
    label: 'Desktop app for macOS and Windows',
    /** The label once the visitor's platform has a download. */
    labelFor: { macos: 'Download for macOS', windows: 'Download for Windows' },
    note: {
      before: 'Not available yet. It comes next on ',
      linkText: 'the roadmap',
      href: ROADMAP_DESKTOP_HREF,
      after: '.',
    },
  },
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
  closing: {
    heading: 'Start with one command',
  },
  blog: {
    title: 'Blog',
    intro: 'Research, how Delorun is built, guides and releases.',
    empty: 'No articles yet.',
    read: 'Read',
    published: (date: string) => `Published ${date}`,
  },
  signup: {
    heading: 'Get release news by email',
    text: 'A short email when a new version or a major article comes out, and nothing more often. We send one message to confirm your address first.',
    nameLabel: 'First name',
    optional: '(optional)',
    emailLabel: 'Email address',
    /** The sentence beside the tick box, and the version the Worker stores with each sign-up; raise the version whenever the sentence or the page around it changes. */
    consent: { text: 'Email me Delorun release news and major articles. One click unsubscribes.', version: '2' },
    submit: 'Sign up for updates',
    privacyNote: { before: 'See ', link: 'what we store', after: ' and why.' },
    checking: 'Checking that you are a person…',
    sending: 'Saving your sign-up…',
    networkError: 'The sign-up did not reach us. Check your connection and try again.',
    checkError: 'The check that you are a person could not load. Reload the page and try again.',
    noScript: (email: string) => `The check that you are a person needs scripts. With scripts off, write to ${email} to be added.`,
    footerHeading: 'Release news by email',
  },
  nav: { docs: 'Docs', blog: 'Blog', github: 'GitHub', privacy: 'Privacy', changelog: 'Changelog', roadmap: 'Roadmap' },
  footer: {
    docs: 'Docs',
    changelog: 'Changelog',
    roadmap: 'Roadmap',
    questions: 'Questions and answers',
    knownIssues: 'Known issues',
    blog: 'Blog',
    github: 'GitHub',
    privacy: 'Privacy',
    licence: 'MIT licence',
    upstream: 'Built on DeepSeek Harness',
    owner: 'Delo Run',
    skip: 'Skip to the content',
    primaryNav: 'Main',
    footerNav: 'Footer',
  },
  privacy: {
    title: 'Privacy',
  },
  notFound: {
    title: 'Page not found',
    text: 'Nothing is plugged in at this address.',
    home: 'Go to the home page',
    markLabel: 'The Delorun mark with its plug pulled out',
  },
} as const
