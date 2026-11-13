/**
 * The site's text. Each claim here is stated in the documentation page its link names, which holds the detail.
 *
 * @module @delo/website/copy
 */
import { DOCS_URL, SUPPORT_EMAIL } from './config.ts'

/** A section of the home page: a heading, one line and the guide page that explains it. */
export interface Feature {
  readonly title: string
  readonly text: string
  readonly href: string
  readonly linkText: string
}

export const COPY = {
  siteTitle: 'Delorun',
  tagline: 'An agent harness that runs on your own computer',
  description: 'Delorun is an open-source agent harness that runs on your own computer: a community fork of DeepSeek Harness, MIT licensed.',
  heroTitle: 'An agent harness that runs on your own computer.',
  heroText: 'Delorun is open source: a community fork of DeepSeek Harness, MIT licensed. One command installs it, checks that the download is genuine and opens a studio in your browser.',
  installLabel: 'Install and first run',
  installCommand: 'npx delorun',
  installNote: 'Needs Node.js 24.9 or newer and a key for the model you want to talk to.',
  terminalLabel: 'What the command prints',
  /** What `npx delorun` asks first on a new home, as the setup prints it. */
  terminal: `$ npx delorun
? How do you want to set up Delorun?
> Quick (the model key and how careful prompts are)
  Full (also the release check, background running, the profile name and the port)`,
  guideLink: 'Read the install guide',
  featuresTitle: 'What you get',
  features: [
    {
      title: 'Runs on your computer',
      text: 'The studio, your chats and your workspaces live in a folder on your own machine. There is no account to create.',
      href: `${DOCS_URL}/guide/trust`,
      linkText: 'What you trust',
    },
    {
      title: 'Asks before risky steps',
      text: 'Commands run in a sandbox. One that needs more asks you first: allow it once, allow it for the chat, or give a workspace full access when you choose.',
      href: `${DOCS_URL}/guide/safety`,
      linkText: 'What Delorun protects',
    },
    {
      title: 'Open it from your phone',
      text: 'Reach your studio over your own Tailscale network. Every new device needs your approval at your computer.',
      href: `${DOCS_URL}/guide/reach`,
      linkText: 'Reach the studio from your phone',
    },
    {
      title: 'Works with DeepSeek and other providers',
      text: 'Use DeepSeek, Anthropic, OpenAI, Google Gemini and others, or any endpoint that speaks the OpenAI protocol.',
      href: `${DOCS_URL}/guide/providers`,
      linkText: 'Model providers',
    },
    {
      title: 'Signed releases, checked before they run',
      text: 'Each release is signed and entered in a public log. The installer checks both before it installs anything.',
      href: `${DOCS_URL}/guide/install#what-the-launcher-verifies`,
      linkText: 'What the launcher verifies',
    },
    {
      title: 'Open source, MIT licensed',
      text: 'Your DeepSeek Harness plugins, profiles and chats keep working, and a fresh install follows the stock workflow.',
      href: `${DOCS_URL}/guide/delo-vs-stock`,
      linkText: 'Delorun and stock DeepSeek Harness',
    },
  ] satisfies readonly Feature[],
  whatsNew: {
    heading: 'What’s new',
    latest: (version: string, date: string) => `Delorun ${version}, ${date}`,
    full: 'Read the full changelog',
  },
  nav: { docs: 'Docs', github: 'GitHub', privacy: 'Privacy', changelog: 'Changelog', roadmap: 'Roadmap' },
  footer: {
    docs: 'Docs',
    changelog: 'Changelog',
    roadmap: 'Roadmap',
    github: 'GitHub',
    privacy: 'Privacy',
    licence: 'MIT licence',
    owner: 'Delo Run',
    skip: 'Skip to the content',
    primaryNav: 'Main',
    footerNav: 'Footer',
  },
  privacy: {
    title: 'Privacy',
    intro: 'This page says what delorun.com collects about you, and what the Delorun program sends. The site is a set of static files.',
    siteHeading: 'This website',
    site: [
      'It sets no cookies and runs no analytics, advertising or tracking scripts.',
      'It loads no fonts, scripts or images from another host, and it has no forms or accounts.',
      'The one script on each page reads your device’s light or dark setting and does not send it anywhere.',
    ],
    hostHeading: 'What the host logs',
    host: 'The site is served by Cloudflare. As any web host does, Cloudflare receives each request your browser makes, which includes your IP address, the address you asked for and your browser’s request headers, and it keeps request logs and traffic figures under its own policies. The site runs no server code of Delo Run\u2019s: it serves files. Delo Run may see the request counts that Cloudflare shows the account owner, and has no way to tell visitors apart.',
    programHeading: 'The Delorun program',
    program: 'Delorun has no telemetry of its own. A few small checks, such as the daily check for a newer release, talk to the internet by default, and everything else leaves your computer only when you turn it on. The Trust page says, party by party, what each one can see.',
    programLinks: [
      { text: 'What you trust when you use Delorun', href: `${DOCS_URL}/guide/trust` },
      { text: 'Updates and the update check', href: `${DOCS_URL}/guide/updates` },
      { text: 'Model providers, which receive what you send to a model', href: `${DOCS_URL}/guide/providers` },
    ],
    contactHeading: 'Questions',
    contact: `Write to ${SUPPORT_EMAIL}. Delo Run is the trading name of the project that publishes Delorun.`,
  },
  notFound: {
    title: 'Page not found',
    text: 'The address you followed does not name a page on this site.',
    home: 'Go to the home page',
  },
} as const
