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
  tagline: 'Your harness. No limits.',
  description: 'Delorun is an open-source agent harness on your own computer. Theme it, extend it with your own plugins, use it from your phone, and go back whenever a change is not right.',
  heroTitle: 'Your harness. No limits.',
  heroText: 'Delorun is an open-source agent harness on your own computer. Theme it, extend it with your own plugins, use it from your phone, and go back whenever a change is not right. One command installs it and checks that the download is genuine.',
  installLabel: 'Install and first run',
  installCommand: 'npx delorun',
  installNote: 'Needs Node.js 24.9 or newer and a key for the model you want to talk to.',
  terminalLabel: 'What the command prints',
  /** What `npx delorun` asks first on a new home, as the setup prints it. */
  terminal: `$ npx delorun
? How will you use Delorun?
> Just me, on this computer (recommended)
  Also from my phone or another device
  For scripts and automation`,
  guideLink: 'Read the install guide',
  featuresTitle: 'What you can do',
  features: [
    {
      title: 'Make it yours',
      text: 'Pick a theme and an accent, change any setting, and write your own plugins to add what Delorun does not do yet.',
      href: `${DOCS_URL}/guide/customise`,
      linkText: 'Where to customise what',
    },
    {
      title: 'Try it, keep it or go back',
      text: 'Delorun saves your setup before every update, and you can save it yourself before a change. Keep what you like, or switch back.',
      href: `${DOCS_URL}/guide/updates`,
      linkText: 'Updates and going back',
    },
    {
      title: 'From your phone',
      text: 'Open your studio over your own Tailscale network and carry on a chat from the sofa or in bed. Approve each new device once, at your computer.',
      href: `${DOCS_URL}/guide/reach`,
      linkText: 'Reach the studio from your phone',
    },
    {
      title: 'Any model you like',
      text: 'Use DeepSeek, Anthropic, OpenAI, Google Gemini and others, or any endpoint that speaks the OpenAI protocol.',
      href: `${DOCS_URL}/guide/providers`,
      linkText: 'Model providers',
    },
    {
      title: 'Safe on your own computer',
      text: 'Everything stays in a folder on your machine, with no account. Commands run in a sandbox and ask before risky steps, and every release is signed and checked before it runs.',
      href: `${DOCS_URL}/guide/safety`,
      linkText: 'What Delorun protects',
    },
    {
      title: 'Open source, MIT licensed',
      text: 'Read and change every line. Coming from DeepSeek Harness? One command copies your chats, workspaces and, if you say so, your profiles and settings.',
      href: `${DOCS_URL}/guide/switching`,
      linkText: 'Move from DeepSeek Harness',
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
    upstream: 'Built from DeepSeek Harness',
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
