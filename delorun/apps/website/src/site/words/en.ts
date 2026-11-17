/**
 * The site's English text. Every claim here is stated on the documentation page its link names, which holds the detail
 * and the limits; `tests/words.spec.ts` checks that each linked page and heading exists.
 *
 * @module @delorun/website/words/en
 */
import { DOCS_URL } from '../config.ts'

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
