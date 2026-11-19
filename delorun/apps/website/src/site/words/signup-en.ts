/**
 * The sign-up form's English text, apart from the consent sentence, which the main dictionary holds with its version
 * because the Worker stores that version. It loads with the form's own chunk.
 *
 * @module @delorun/website/words/signup-en
 */

/** The sign-up form's text in English. */
export const SIGNUP_EN = {
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
} as const
