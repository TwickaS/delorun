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

/** Every string the home page shows, with the documentation link each claim points to. */
export const COPY = {
  siteTitle: 'Delorun',
  tagline: 'Your harness. No limits.',
  description: 'Delorun is an open-source agent harness on your own computer. Theme it, extend it with your own plugins, use it from your phone, and go back whenever a change is not right.',
  heroTitle: 'Your harness. No limits.',
  heroText: 'Delorun is an open-source agent harness on your own computer. Theme it, extend it with your own plugins, use it from your phone, and go back whenever a change is not right. One command installs it and checks that the download is genuine.',
  installLabel: 'Install and first run',
  installCommand: 'npx delorun',
  copyLabel: 'Copy command',
  copiedLabel: 'Copied',
  /** Shown beside the install command; `linkText` is the part that links to `href`. */
  platformNote: {
    before: 'Delorun runs on Linux and on ',
    linkText: 'Windows through WSL2',
    href: `${DOCS_URL}/guide/install#windows-through-wsl2`,
    after: '. macOS and native Windows are not supported.',
  },
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
      text: 'Pick a theme and an accent, change any setting, and write your own plugins to add what Delorun does not do.',
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
      text: 'Your chats and settings stay in a folder on your computer, with no account. Commands run in a sandbox and ask before risky steps, and every release is signed and checked before it runs.',
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
  signup: {
    heading: 'Get release news by email',
    text: 'Sign up for a short email when a new version of Delorun comes out. We send a message to confirm your address first, and nothing else until you open it.',
    nameLabel: 'First name',
    optional: '(optional)',
    emailLabel: 'Email address',
    submit: 'Sign up for updates',
    privacyNote: { before: 'See ', link: 'what we store', after: ' and why.' },
    checking: 'Checking that you are a person…',
    sending: 'Saving your sign-up…',
    networkError: 'The sign-up did not reach us. Check your connection and try again.',
    checkError: 'The check that you are a person could not load. Reload the page and try again.',
    noScript: (email: string) => `The check that you are a person needs scripts. With scripts off, write to ${email} to be added.`,
    footerHeading: 'Release news by email',
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
    intro: 'This page says what delorun.com collects about you, and what the Delorun program sends. Apart from the sign-up form, the site is a set of static files.',
    siteHeading: 'This website',
    site: [
      'It sets no cookies of its own and runs no analytics, advertising or tracking scripts.',
      'It loads no fonts, scripts or images from another host until you use the sign-up form; then it loads Cloudflare\u2019s Turnstile check, described below.',
      'It has no accounts. The only form is the sign-up for release news.',
      'A small script on each page reads your device\u2019s light or dark setting and does not send it anywhere.',
    ],
    hostHeading: 'What the host logs',
    host: 'The site is served by Cloudflare. As any web host does, Cloudflare receives each request your browser makes, which includes your IP address, the address you asked for and your browser’s request headers, and it keeps request logs and traffic figures under its own policies. Apart from the sign-up routes below, the site serves files, and Delo Run may see the request counts that Cloudflare shows the account owner but has no way to tell visitors apart.',
    updatesHeading: 'Release news by email',
    updates: [
      'If you sign up, we store the email address you give, the first name if you give one, the time and page of your sign-up, the version of the consent sentence you ticked, and whether you have confirmed or unsubscribed. We store no IP address and no browser details with it.',
      'We use it only to email you Delorun release news that you asked for, starting with one message to confirm your address. The basis is your consent, which you give by ticking the box and confirming by email.',
      'We keep it until you unsubscribe. A sign-up that is not confirmed is deleted after 30 days. When you unsubscribe, we keep the address, marked as unsubscribed, only so that we do not email it again; write to us to have it deleted.',
      'Cloudflare processes it for us: it stores the data in its D1 database and sends the messages with its Email Service.',
      'The sign-up is checked with Cloudflare Turnstile to keep out automated sign-ups. The check loads from challenges.cloudflare.com only when you first use the form, and Cloudflare receives what any such check receives, such as your IP address and browser details, under its own policy. Our Worker sends the check\u2019s token to Cloudflare for verification and does not send your address with it. The Worker also gives your IP address to Cloudflare\u2019s rate limiter, which counts sign-ups to stop floods; we do not store it.',
    ],
    updatesLinks: [
      { text: 'Cloudflare Turnstile and privacy', href: 'https://developers.cloudflare.com/turnstile/' },
    ],
    updatesRights: `To unsubscribe, use the link in any message. To ask what we hold, correct it or have it deleted, write to ${SUPPORT_EMAIL}.`,
    programHeading: 'The Delorun program',
    program: 'Delorun has no telemetry of its own. A few small checks, such as the daily check for a newer release, talk to the internet by default. Your messages go to the model provider you choose when you chat, and nothing else leaves your computer unless you turn it on. The Trust page says, party by party, what each one can see.',
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
