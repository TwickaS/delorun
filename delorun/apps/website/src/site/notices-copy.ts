/**
 * The text of the notices page, in English.
 *
 * @module @delorun/website/notices-copy
 */
export const NOTICES_COPY = {
  title: 'Notices',
  description: 'The licences of the themes, typefaces and libraries that delorun.com shows or uses.',
  footerLabel: 'Notices',
  intro: 'Delorun is built on other people’s work. This page gives the licence of each part that this site shows or uses.',
  covers: {
    't3-code': 'The Slate, Berry, Grove, Ocean, Ember and Iris looks derive from the themes of T3 Code.',
    'schibsted-grotesk': 'The typeface of the headlines and text.',
    'jetbrains-mono': 'The typeface of commands, file names and the settings entry.',
    sonner: 'The library behind the small message that appears when you change the look.',
  },
} as const satisfies { title: string; description: string; footerLabel: string; intro: string; covers: Record<string, string> }
