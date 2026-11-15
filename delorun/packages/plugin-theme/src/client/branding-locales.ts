/** The Branding section's copy. */

/** English dictionary. */
export const en = {
  nav: 'Branding',
  title: 'Branding',
  show: 'Show the mark',
  'show.lead': 'Shows the icon and name on the empty chat screen and in the sidebar header.',
  name: 'Name',
  'name.lead': 'Replaces “Delorun” in the sidebar header, on the empty chat screen and in the browser tab title.',
  'name.placeholder': 'Delorun',
  'name.problem': 'The name is 1 to 40 characters of plain text.',
  icon: 'Icon',
  'icon.lead': 'Replaces the mark in those places and in the browser tab icon. Use the Delorun mark, pick an icon, or upload a PNG, JPEG or WebP image of up to 256 KB.',
  'icon.mark': 'Delorun mark',
  'icon.picked': 'Picked icon',
  'icon.upload': 'Uploaded image',
  'icon.pick': 'Pick an icon',
  'icon.choose': 'Choose an image',
  'icon.problem': 'The icon must be a PNG, JPEG or WebP image of up to 256 KB. SVG is not accepted.',
  greeting: 'Greeting',
  'greeting.lead': 'The line above the message box on the empty chat screen.',
  'greeting.custom': 'Your own line',
  'greeting.placeholder': 'What are we working on?',
  'greeting.problem': 'The greeting is 1 to 80 characters of plain text.',
  signin: 'Sign-in pages',
  'signin.lead': 'The sign-in and pairing pages for other devices show this name and icon, or nothing when the mark is hidden. They appear before anyone signs in, so anyone who can reach this address sees them.',
  reset: 'Use the Delorun defaults',
  notice: 'Part of the saved branding could not be used, so the Delorun defaults show instead.',
  saveFailed: 'The branding could not be saved. Try again.',
}

/** A key of the Branding dictionary. */
export type BrandingLocaleKey = keyof typeof en

/** Chinese dictionary. */
// A309: the Chinese copy waits for the translation pass; English stands in meanwhile.
export const zh: Record<BrandingLocaleKey, string> = { ...en }
