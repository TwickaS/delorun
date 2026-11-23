/**
 * The privacy page's English text. It lives apart from the site's main dictionary so the page's long text loads with
 * the privacy page's own script, never with the home page's.
 *
 * @module @delorun/website/words/privacy-en
 */
import { DOCS_URL, SUPPORT_EMAIL } from '../config.ts'

/** The privacy page's text in English; its title is in the main dictionary, which the page's head reads. */
export const PRIVACY_EN = {
  intro: 'This page says what delorun.com collects about you, and what the Delorun program sends. Apart from the sign-up form, the site is a set of static files.',
  siteHeading: 'This website',
  site: [
    'It sets no cookies of its own and runs no analytics, advertising or tracking scripts.',
    'It loads no fonts, scripts or images from another host until you use the sign-up form; then it loads Cloudflare’s Turnstile check, described below.',
    'It has no accounts. The only form is the sign-up for release news.',
    'A small script on each page reads your device’s light or dark setting and any look carried in the link you followed. It sends neither anywhere and stores nothing.',
  ],
  /** What the browser keeps, with the button that clears it. */
  stored: 'When you pick a package manager above the install command, your browser keeps that choice in this site’s local storage on your device, so the page shows the same command next time. It is not sent anywhere, and nothing is kept until you pick one.',
  forget: 'Forget my package manager choice',
  forgotten: 'Forgotten. The page shows the default command again.',
  hostHeading: 'What the host logs',
  host: 'The site is served by Cloudflare. As any web host does, Cloudflare receives each request your browser makes, which includes your IP address, the address you asked for and your browser’s request headers, and it keeps request logs and traffic figures under its own policies. Apart from the sign-up routes below, the site serves files, and Delorun may see the request counts that Cloudflare shows the account owner but has no way to tell visitors apart.',
  updatesHeading: 'Release news by email',
  updates: [
    'If you sign up, we store the email address you give, the first name if you give one, the time and page of your sign-up, the version of the consent sentence you ticked, and whether you have confirmed or unsubscribed. We store no IP address and no browser details with it.',
    'We use it only to email you the Delorun release news and major articles that you asked for, starting with one message to confirm your address. The basis is your consent, which you give by ticking the box and confirming by email.',
    'We keep it until you unsubscribe. A sign-up that is not confirmed is deleted after 30 days. When you unsubscribe, we keep the address, marked as unsubscribed, only so that we do not email it again; write to us to have it deleted.',
    'Cloudflare processes it for us: it stores the data in its D1 database and sends the messages with its Email Service.',
    'The sign-up is checked with Cloudflare Turnstile to keep out automated sign-ups. The check loads from challenges.cloudflare.com only when you first use the form, and Cloudflare receives what any such check receives, such as your IP address and browser details, under its own policy. Our Worker sends the check’s token to Cloudflare for verification and does not send your address with it. The Worker also gives your IP address to Cloudflare’s rate limiter, which counts sign-ups to stop floods; we do not store it.',
  ],
  updatesLinks: [
    { text: 'Cloudflare Turnstile and privacy', href: 'https://developers.cloudflare.com/turnstile/' },
  ],
  updatesRights: `To unsubscribe, use the link in any message. To ask what we hold, correct it or have it deleted, write to ${SUPPORT_EMAIL}.`,
  programHeading: 'The Delorun program',
  program: 'Delorun has no telemetry of its own. A few small checks, such as the daily check for a newer release, talk to the internet by default. Your messages go to the model provider you choose when you chat, and nothing else leaves your computer unless you turn it on. The Trust page says, party by party, what each one can see.',
  programLinks: [
    { text: 'What you trust when you use Delorun', href: `${DOCS_URL}/guide/safety-and-updates/trust` },
    { text: 'Updates and the update check', href: `${DOCS_URL}/guide/safety-and-updates/updates` },
    { text: 'Model providers, which receive what you send to a model', href: `${DOCS_URL}/guide/get-started/providers` },
  ],
  contactHeading: 'Questions',
  contact: `Write to ${SUPPORT_EMAIL}. Delorun is published by Vadim Alexeev, trading as Delorun.`,
} as const
