/**
 * The site's English text. Every claim here is stated on the documentation page its link names, which holds the detail
 * and the limits; `tests/words.spec.ts` checks that each linked page and heading exists.
 *
 * @module @delorun/website/words/en
 */
import { DOCS_URL, TRADING_NAME } from '../config.ts'

/** The roadmap entry that the desktop button's note links to: the "Next" section, which lists the desktop app first. */
export const ROADMAP_DESKTOP_HREF = `${DOCS_URL}/guide/roadmap#next`

/** Every string the site shows in English, with the documentation link each claim points to. */
export const EN = {
  language: 'en-GB',
  siteTitle: 'Delorun',
  tagline: 'Bring your own everything.',
  description: 'Your models and keys. Your plugins. Your look. Your agents. Delorun is an AI agent harness on your own computer, and every part of it is yours to swap.',
  hero: {
    subline: 'An AI agent that works on your own computer, in a harness you can reshape: its look, its plugins, even Delorun itself.',
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
    description: 'Research, how Delorun is built, guides and releases.',
    intro: 'Research, how Delorun is built, guides and releases.',
    empty: 'No articles yet.',
    read: 'Read',
    published: (date: string) => `Published ${date}`,
  },
  signup: {
    footerHeading: 'Release news by email',
  },
  nav: { why: 'Why Delorun', docs: 'Docs', blog: 'Blog', github: 'GitHub', privacy: 'Privacy', changelog: 'Changelog', roadmap: 'Roadmap' },
  footer: {
    docs: 'Docs',
    changelog: 'Changelog',
    roadmap: 'Roadmap',
    why: 'Why Delorun',
    questions: 'Questions and answers',
    knownIssues: 'Known issues',
    blog: 'Blog',
    github: 'GitHub',
    privacy: 'Privacy',
    licence: 'MIT licence',
    upstream: 'Built on DeepSeek Harness',
    owner: `Delorun is published by ${TRADING_NAME}`,
    skip: 'Skip to the content',
    primaryNav: 'Main',
    footerNav: 'Footer',
  },
  privacy: {
    title: 'Privacy',
    description: 'What delorun.com collects about you, and what the Delorun program sends: no cookies, no tracking, one sign-up form.',
  },
  /** The link-preview image's text alternative. */
  linkPreviewAlt: 'The Delorun mark and the words Delorun, an agent harness that runs on your own computer.',
  /** Shown in the place of the lower home page when its script fails to load. */
  partFailed: 'The rest of this page did not load. Reload the page to see it.',
  notFound: {
    title: 'Page not found',
    text: 'Nothing is plugged in at this address.',
    home: 'Go to the home page',
    markLabel: 'The Delorun mark with its plug pulled out',
  },
} as const
